"""Memora FastAPI application — the local, offline backend.

Serves the media index, thumbnails, originals, People/Search/Albums, and drives
scanning + AI processing. Bound to localhost only; nothing is ever uploaded.

Access control (A01): when launched by Electron, a per-launch secret arrives in
``MEMORA_API_TOKEN`` and every request must carry it in ``X-Memora-Token``
(Electron's main process adds the header; the renderer never sees it). Requests
whose Host is not a loopback name are rejected (DNS rebinding), and CORS only
admits the app's own origins.
"""
from __future__ import annotations

import hmac
import mimetypes
import os
import sys
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from . import ai_pipeline, db, maintenance, repository, scanner, tiles, watcher
from .ai import system_info
from .ai.device import describe, detect_device
from .config import API_TOKEN, HOST, LOOPBACK_HOSTS, PORT, TOKEN_HEADER
from .db import get_conn, init_db
from .media_utils import crop_face, generate_display, is_web_safe

_server = None  # uvicorn.Server, set by run() so shutdown can be requested
_startup_report: dict = {}


def shutdown_workers(timeout: float = 5.0) -> dict:
    """Stop background work cleanly (B14): cancel scan + AI after the current
    item, stop the watcher, wait for the threads, close every DB connection."""
    scanner.cancel_scan()
    ai_pipeline.cancel_processing()
    stopped_watch = watcher.stop_watcher(timeout)
    stopped_scan = scanner.wait(timeout)
    stopped_ai = ai_pipeline.wait(timeout)
    db.close_all(checkpoint=True)
    return {"watcher": stopped_watch, "scan": stopped_scan, "ai": stopped_ai}


def request_exit() -> None:
    """Ask uvicorn to shut down gracefully (runs the lifespan shutdown)."""
    if _server is not None:
        _server.should_exit = True


def _watch_parent_stdin() -> None:
    """Exit when Electron's stdin pipe closes, i.e. the parent app died."""
    try:
        while sys.stdin and sys.stdin.buffer.read(1):
            pass
    except Exception:
        pass
    print("[memora] parent process gone; shutting down")
    request_exit()


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    _startup_report["migration"] = init_db()
    # quick_check reads the whole DB: run it off the startup path.
    threading.Thread(
        target=lambda: _startup_report.__setitem__("integrity", db.integrity_report()),
        daemon=True, name="memora-integrity",
    ).start()
    watcher.start_watcher()
    if os.environ.get("MEMORA_EXIT_ON_STDIN_EOF") == "1":
        threading.Thread(target=_watch_parent_stdin, daemon=True, name="memora-parent").start()
    # Probe the hardware off the request path (spawns OS queries) so the first
    # /api/system call is instant and the choice shows up in the log at boot.
    threading.Thread(
        target=lambda: print(f"[memora] hardware: {describe(detect_device())}"),
        daemon=True,
        name="memora-hwprobe",
    ).start()
    yield
    print(f"[memora] shutdown: {shutdown_workers()}")


app = FastAPI(title="Memora", version="0.2.0", lifespan=_lifespan)

# Media bytes are addressed by numeric media id (/api/thumb/{id}, /api/display/{id}).
# "no-cache" forces revalidation on every request; FileResponse's ETag/Last-Modified
# make that a cheap 304 when the file is unchanged.
_REVALIDATE = {"Cache-Control": "no-cache"}


def _host_name(host_header: str) -> str:
    host = host_header.strip().lower()
    if host.startswith("["):  # [::1]:8756
        return host.split("]")[0] + "]"
    return host.rsplit(":", 1)[0] if ":" in host else host


@app.middleware("http")
async def _access_control(request: Request, call_next):
    # DNS-rebinding defence: only loopback Host names reach the API.
    if _host_name(request.headers.get("host", "")) not in LOOPBACK_HOSTS:
        return JSONResponse({"detail": "Forbidden host"}, status_code=403)
    if API_TOKEN and request.method != "OPTIONS" and request.url.path != "/api/health":
        supplied = request.headers.get(TOKEN_HEADER, "")
        if not hmac.compare_digest(supplied.encode(), API_TOKEN.encode()):
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    return await call_next(request)


# The renderer runs on the electron-vite dev server (localhost) in dev and on
# file:// (Origin "null") when packaged. Added last, so it wraps the auth
# middleware and answers CORS preflights itself.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(null|file://.*|https?://(localhost|127\.0\.0\.1)(:\d+)?)$",
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", TOKEN_HEADER],
)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "version": app.version}


@app.get("/api/system")
def get_system() -> dict:
    """Detected GPUs, chosen compute device, and the active AI backend."""
    return system_info()


@app.get("/api/stats")
def stats() -> dict:
    return repository.library_stats()


# ------------------------------------------------------------- Folders ------

class FolderIn(BaseModel):
    path: str


@app.get("/api/folders")
def get_folders() -> dict:
    return {"folders": scanner.list_folders()}


@app.post("/api/folders")
def post_folder(body: FolderIn) -> dict:
    try:
        folder_id = scanner.add_folder(body.path)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"id": folder_id}


@app.delete("/api/folders/{folder_id}")
def delete_folder(folder_id: int) -> dict:
    """Remove a folder from the library (files on disk are untouched)."""
    return {"removed": scanner.remove_folder(folder_id)}


class WatchIn(BaseModel):
    watch: bool


@app.post("/api/folders/{folder_id}/watch")
def post_folder_watch(folder_id: int, body: WatchIn) -> dict:
    repository.set_folder_watch(folder_id, body.watch)
    return {"ok": True}


# -------------------------------------------------------------- Scan --------

class ScanIn(BaseModel):
    folder_ids: list[int] | None = None
    process_ai: bool = True


@app.post("/api/scan")
def post_scan(body: ScanIn) -> dict:
    started = scanner.start_scan(body.folder_ids, body.process_ai)
    return {"started": started}


@app.post("/api/scan/cancel")
def post_scan_cancel() -> dict:
    return {"ok": scanner.cancel_scan()}


@app.get("/api/scan/status")
def scan_status() -> dict:
    return {
        "scan": scanner.STATUS.snapshot(),
        "ai": ai_pipeline.STATUS,
    }


@app.get("/api/scan/failures")
def get_scan_failures() -> dict:
    return {"failures": scanner.scan_failures()}


@app.post("/api/scan/failures/retry")
def post_scan_failures_retry() -> dict:
    return {"started": scanner.retry_scan_failures()}


@app.post("/api/ai/process")
def post_process() -> dict:
    return {"started": ai_pipeline.start_processing()}


@app.post("/api/ai/purge-stub")
def post_purge_stub() -> dict:
    try:
        return {"removed": ai_pipeline.purge_stub_results()}
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))


# -------------------------------------------------- Processing Center -------

@app.get("/api/processing")
def get_processing() -> dict:
    """Full snapshot for the Processing Center: live status + per-stage counts."""
    return {
        "scan": scanner.STATUS.snapshot(),
        "ai": ai_pipeline.STATUS,
        "watch": watcher.snapshot(),
        "stages": repository.processing_stats(),
    }


@app.get("/api/processing/failed")
def get_processing_failed() -> dict:
    return {"failed": repository.failed_media()}


@app.post("/api/processing/{action}")
def post_processing_action(action: str) -> dict:
    if action == "start":
        return {"ok": ai_pipeline.start_processing()}
    if action == "pause":
        return {"ok": ai_pipeline.pause_processing()}
    if action == "resume":
        return {"ok": ai_pipeline.resume_processing()}
    if action == "cancel":
        return {"ok": ai_pipeline.cancel_processing()}
    if action == "retry":
        return {"retried": ai_pipeline.retry_failed()}
    raise HTTPException(status_code=400, detail=f"Unknown action: {action}")


# ------------------------------------------------------- Maintenance --------

@app.get("/api/maintenance/health")
def get_maintenance_health() -> dict:
    return {**maintenance.health_report(), "startup": _startup_report}


@app.post("/api/maintenance/cleanup-cache")
def post_cleanup_cache() -> dict:
    return maintenance.cleanup_cache()


def _require_idle() -> None:
    if scanner.STATUS.running or ai_pipeline.STATUS["running"]:
        raise HTTPException(status_code=409, detail="Wait for scanning / AI processing to finish")


@app.post("/api/maintenance/repair")
def post_repair() -> dict:
    _require_idle()
    return maintenance.repair()


@app.get("/api/maintenance/backups")
def get_backups() -> dict:
    return {"backups": db.list_backups()}


@app.post("/api/maintenance/backup")
def post_backup() -> dict:
    return {"backup": db.backup_database("manual").name}


class RestoreIn(BaseModel):
    name: str


@app.post("/api/maintenance/restore")
def post_restore(body: RestoreIn) -> dict:
    _require_idle()
    if not scanner._scan_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="A scan is in progress")
    try:
        return db.restore_backup(body.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        scanner._scan_lock.release()


@app.post("/api/admin/shutdown")
def post_shutdown() -> dict:
    """Graceful exit requested by the Electron main process on quit."""
    request_exit()
    return {"ok": True}


# ------------------------------------------------------------- Privacy ------

@app.get("/api/privacy")
def get_privacy() -> dict:
    return repository.privacy_info()


# -------------------------------------------------------------- Media -------

@app.get("/api/media")
def get_media_list(
    view: str = "photos", sort: str = "newest", limit: int = 200, offset: int = 0
) -> dict:
    limit = max(1, min(limit, 20000))
    offset = max(0, offset)
    return repository.list_media(view=view, sort=sort, limit=limit, offset=offset)


@app.get("/api/media/timeline")
def get_media_timeline(view: str = "photos", sort: str = "newest") -> dict:
    return {"months": repository.timeline(view=view, sort=sort)}


@app.get("/api/media/missing")
def get_missing() -> dict:
    return {"items": scanner.missing_media()}


class IdsIn(BaseModel):
    media_ids: list[int] = Field(default_factory=list)


@app.post("/api/media/missing/forget")
def post_forget_missing(body: IdsIn) -> dict:
    """Remove the listed missing items from the library (explicit action)."""
    return {"removed": scanner.forget_missing(body.media_ids)}


class BulkFlagIn(BaseModel):
    media_ids: list[int]
    flag: str
    value: bool


@app.post("/api/media/flags")
def post_bulk_flag(body: BulkFlagIn) -> dict:
    try:
        return {"changed": repository.set_flag_bulk(body.media_ids, body.flag, body.value)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/trash/restore")
def post_trash_restore() -> dict:
    return {"restored": repository.restore_all_trash()}


@app.post("/api/trash/empty")
def post_trash_empty() -> dict:
    """Remove trashed items from the library. Original files stay on disk."""
    return {"removed": repository.empty_trash()}


@app.get("/api/duplicates")
def get_duplicates(similar: bool = False) -> dict:
    groups = repository.duplicate_groups()
    if similar:
        groups = groups + repository.near_duplicate_groups()
    return {"groups": groups}


@app.get("/api/media/{media_id}")
def get_media_detail(media_id: int) -> dict:
    media = repository.get_media(media_id)
    if not media:
        raise HTTPException(status_code=404, detail="Media not found")
    return media


class FlagIn(BaseModel):
    flag: str
    value: bool


@app.post("/api/media/{media_id}/flag")
def post_flag(media_id: int, body: FlagIn) -> dict:
    try:
        repository.set_flag(media_id, body.flag, body.value)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


@app.get("/api/media/{media_id}/similar")
def get_similar(media_id: int) -> dict:
    return {"items": repository.similar_media(media_id)}


class TagIn(BaseModel):
    label: str


@app.post("/api/media/{media_id}/tags")
def post_tag(media_id: int, body: TagIn) -> dict:
    try:
        tag = repository.add_tag(media_id, body.label)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"tag": tag}


@app.delete("/api/media/{media_id}/tags/{tag_id}")
def delete_tag(media_id: int, tag_id: int) -> dict:
    return {"ok": repository.delete_tag(media_id, tag_id)}


@app.get("/api/thumb/{media_id}")
def get_thumb(media_id: int):
    row = get_conn().execute(
        "SELECT thumb_path, path, kind FROM media WHERE id = ?", (media_id,)
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    thumb = row["thumb_path"]
    if thumb and Path(thumb).exists():
        return FileResponse(thumb, media_type="image/webp", headers=_REVALIDATE)
    # Fall back to the original only when a browser can render it directly.
    if row["kind"] == "image" and row["path"] and is_web_safe(Path(row["path"])) \
            and Path(row["path"]).exists():
        return FileResponse(row["path"], headers=_REVALIDATE)
    raise HTTPException(status_code=404, detail="Thumbnail unavailable")


@app.get("/api/file/{media_id}")
def get_file(media_id: int):
    row = get_conn().execute(
        "SELECT path FROM media WHERE id = ?", (media_id,)
    ).fetchone()
    if not row or not Path(row["path"]).exists():
        raise HTTPException(status_code=404, detail="File missing")
    mime, _ = mimetypes.guess_type(row["path"])
    # FileResponse honors HTTP Range requests, so <video> seeking works.
    return FileResponse(
        row["path"], media_type=mime or "application/octet-stream", headers=_REVALIDATE
    )


@app.get("/api/display/{media_id}")
def get_display(media_id: int):
    """Browser-renderable image for the viewer.

    Serves the original for web-safe formats (JPEG/PNG/…); converts HEIC/TIFF/…
    to a cached JPEG so Chromium can actually display them.
    """
    row = get_conn().execute(
        "SELECT path, kind FROM media WHERE id = ?", (media_id,)
    ).fetchone()
    if not row or not Path(row["path"]).exists():
        raise HTTPException(status_code=404, detail="File missing")
    path = Path(row["path"])
    if row["kind"] != "image" or is_web_safe(path):
        mime, _ = mimetypes.guess_type(str(path))
        return FileResponse(
            str(path), media_type=mime or "application/octet-stream", headers=_REVALIDATE
        )
    jpeg = generate_display(path)
    if not jpeg:
        from .media_utils import unsupported_reason

        raise HTTPException(
            status_code=415, detail=unsupported_reason(path) or "Cannot render this image"
        )
    return FileResponse(jpeg, media_type="image/jpeg", headers=_REVALIDATE)


# ------------------------------------------------------------- People -------

@app.get("/api/people")
def get_people(include_hidden: bool = False) -> dict:
    return {"people": repository.list_people(include_hidden=include_hidden)}


@app.get("/api/people/review")
def get_people_review() -> dict:
    """Uncertain face matches awaiting manual confirmation."""
    return {"faces": repository.uncertain_faces()}


class AssignIn(BaseModel):
    person_id: Optional[int] = None


@app.post("/api/faces/{face_id}/assign")
def post_assign_face(face_id: int, body: AssignIn) -> dict:
    pid = repository.assign_face(face_id, body.person_id)
    if pid is None:
        raise HTTPException(status_code=404, detail="Face or person not found")
    return {"person_id": pid}


class RenameIn(BaseModel):
    name: str | None


@app.post("/api/people/{person_id}/rename")
def post_rename(person_id: int, body: RenameIn) -> dict:
    repository.rename_person(person_id, body.name)
    return {"ok": True}


class HideIn(BaseModel):
    hidden: bool


@app.post("/api/people/{person_id}/hide")
def post_hide_person(person_id: int, body: HideIn) -> dict:
    repository.set_person_hidden(person_id, body.hidden)
    return {"ok": True}


class MergeIn(BaseModel):
    source_id: int
    target_id: int


@app.post("/api/people/merge")
def post_merge(body: MergeIn) -> dict:
    op_id = repository.merge_people(body.source_id, body.target_id)
    return {"ok": op_id is not None, "op_id": op_id}


@app.post("/api/people/merge/{op_id}/undo")
def post_merge_undo(op_id: int) -> dict:
    return {"ok": repository.undo_merge(op_id)}


class SplitIn(BaseModel):
    media_ids: list[int]


@app.post("/api/people/{person_id}/split")
def post_split(person_id: int, body: SplitIn) -> dict:
    return {"new_person_id": repository.split_person(person_id, body.media_ids)}


@app.get("/api/people/{person_id}/media")
def get_person_media(person_id: int) -> dict:
    return {"items": repository.media_for_person(person_id)}


class CoverIn(BaseModel):
    media_id: int


@app.post("/api/people/{person_id}/cover")
def post_person_cover(person_id: int, body: CoverIn) -> dict:
    return {"ok": repository.set_person_cover(person_id, body.media_id)}


class ExportPersonIn(BaseModel):
    person_id: int
    dest: str


@app.post("/api/export/person")
def post_export_person(body: ExportPersonIn) -> dict:
    try:
        return repository.export_person(body.person_id, body.dest)
    except (ValueError, OSError) as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/people/{person_id}/face")
def get_person_face(person_id: int, media_id: int | None = None):
    """Return a cropped face thumbnail for the person.

    Which face is used:
      * ``media_id`` given  -> that photo's face (used by the thumbnail picker),
      * else the person's chosen cover photo if set,
      * else the largest detected face.
    404 (frontend then shows the generic avatar / photo thumb) when there's no
    usable bbox.
    """
    conn = get_conn()
    if media_id is None:
        cover = conn.execute(
            "SELECT cover_media_id FROM people WHERE id = ?", (person_id,)
        ).fetchone()
        if cover and cover["cover_media_id"]:
            media_id = cover["cover_media_id"]

    row = None
    if media_id is not None:
        row = conn.execute(
            """SELECT m.path AS path, f.bbox_x, f.bbox_y, f.bbox_w, f.bbox_h
               FROM faces f JOIN media m ON m.id = f.media_id
               WHERE f.person_id = ? AND f.media_id = ?
                 AND f.bbox_w IS NOT NULL AND f.bbox_w > 0
               ORDER BY (f.bbox_w * f.bbox_h) DESC LIMIT 1""",
            (person_id, media_id),
        ).fetchone()
    if row is None:  # no chosen face (or it had no bbox) -> largest overall
        row = conn.execute(
            """SELECT m.path AS path, f.bbox_x, f.bbox_y, f.bbox_w, f.bbox_h
               FROM faces f JOIN media m ON m.id = f.media_id
               WHERE f.person_id = ? AND f.bbox_w IS NOT NULL AND f.bbox_w > 0
               ORDER BY (f.bbox_w * f.bbox_h) DESC LIMIT 1""",
            (person_id,),
        ).fetchone()
    if not row or not Path(row["path"]).exists():
        raise HTTPException(status_code=404, detail="No face crop available")
    data = crop_face(
        Path(row["path"]),
        (row["bbox_x"], row["bbox_y"], row["bbox_w"], row["bbox_h"]),
    )
    if not data:
        raise HTTPException(status_code=404, detail="Crop failed")
    return Response(content=data, media_type="image/webp", headers=_REVALIDATE)


# ---------------------------------------------------------- Relations -------

@app.get("/api/relations")
def get_relations() -> dict:
    return repository.relation_graph()


@app.get("/api/relations/suggestions")
def get_relation_suggestions(limit: int = 8) -> dict:
    return {"suggestions": repository.relation_suggestions(limit)}


@app.get("/api/relations/family-suggestions")
def get_family_suggestions() -> dict:
    return {"suggestions": repository.family_suggestions()}


class AutoConnectIn(BaseModel):
    min_shared: int = 2
    label: str = "appears with"


@app.post("/api/relations/auto")
def post_auto_connect(body: AutoConnectIn) -> dict:
    return {"created": repository.auto_connect(body.min_shared, body.label)}


class RelationIn(BaseModel):
    person_a: int
    person_b: int
    label: str = ""
    directed: bool = False


@app.post("/api/relations")
def post_relation(body: RelationIn) -> dict:
    try:
        return {
            "relation": repository.add_relation(
                body.person_a, body.person_b, body.label, body.directed
            )
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/api/relations/{rel_id}")
def delete_relation(rel_id: int) -> dict:
    return {"ok": repository.delete_relation(rel_id)}


# ------------------------------------------------------------- Search -------

@app.get("/api/search")
def get_search(q: str, limit: int = 200, person_id: int | None = None) -> dict:
    return repository.search(q, limit=max(1, min(limit, 2000)), person_id=person_id)


@app.get("/api/search/suggest")
def get_search_suggest(q: str) -> dict:
    return repository.search_suggestions(q)


# ------------------------------------------------------------- Places -------

@app.get("/api/places")
def get_places() -> dict:
    return {"places": repository.list_places()}


@app.get("/api/places/media")
def get_place_media(key: str) -> dict:
    return {"items": repository.media_for_place(key)}


@app.get("/api/geo/media")
def get_geo_media(sort: str = "newest") -> dict:
    return {"items": repository.geotagged_media(sort=sort)}


# --------------------------------------------------------- Map tiles --------

@app.get("/api/tile/{style}/{z}/{x}/{y}")
def get_tile(style: str, z: int, x: int, y: int):
    """Cached map tile. 404 when offline and not yet cached (blank tile)."""
    data = tiles.get_tile(style, z, x, y)
    if data is None:
        raise HTTPException(status_code=404, detail="Tile unavailable offline")
    return Response(
        content=data,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=604800"},
    )


@app.get("/api/tiles/stats")
def get_tiles_stats() -> dict:
    return tiles.cache_stats()


@app.post("/api/tiles/clear")
def post_tiles_clear() -> dict:
    return {"cleared": tiles.clear_cache()}


# ------------------------------------------------------------- Albums -------

@app.get("/api/albums")
def get_albums() -> dict:
    return {"albums": repository.list_albums()}


class AlbumIn(BaseModel):
    name: str


@app.post("/api/albums")
def post_album(body: AlbumIn) -> dict:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Album name can't be empty")
    return {"id": repository.create_album(name)}


class AlbumAddIn(BaseModel):
    media_ids: list[int]


@app.post("/api/albums/{album_id}/media")
def post_album_media(album_id: int, body: AlbumAddIn) -> dict:
    return {"added": repository.add_to_album(album_id, body.media_ids)}


@app.get("/api/albums/{album_id}/media")
def get_album_media(album_id: int) -> dict:
    return {"items": repository.album_media(album_id)}


def run() -> None:
    import uvicorn

    global _server
    if HOST not in LOOPBACK_HOSTS and not API_TOKEN:
        raise SystemExit(
            f"Refusing to listen on non-loopback host {HOST!r} without MEMORA_API_TOKEN."
        )
    if not API_TOKEN:
        print("[memora] WARNING: MEMORA_API_TOKEN not set; API auth disabled (dev mode, loopback only)")
    config = uvicorn.Config(app, host=HOST, port=PORT, log_level="info")
    _server = uvicorn.Server(config)
    _server.run()


if __name__ == "__main__":
    run()
