"""Memora FastAPI application — the local, offline backend.

Serves the media index, thumbnails, originals, People/Search/Albums, and drives
scanning + AI processing. Bound to localhost only; nothing is ever uploaded.
"""
from __future__ import annotations

import mimetypes
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import ai_pipeline, repository, scanner, tiles
from .config import HOST, PORT
from .db import get_conn, init_db
from .media_utils import crop_face, generate_display, is_web_safe

app = FastAPI(title="Memora", version="0.1.0")

# Media bytes are addressed by numeric media id (/api/thumb/{id}, /api/display/{id}).
# Because ids are reused when the library is rescanned/rebuilt, the same URL can
# point to a different file over time. Without this header Chromium heuristically
# caches the old image and shows a thumbnail that no longer matches the original.
# "no-cache" forces revalidation on every request; FileResponse's ETag/Last-Modified
# make that a cheap 304 when the file is unchanged.
_REVALIDATE = {"Cache-Control": "no-cache"}

# The renderer runs on a vite dev-server origin in dev and file:// in prod.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # localhost-only server; safe for a local desktop app
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    init_db()


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "version": app.version}


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


# -------------------------------------------------------------- Scan --------

class ScanIn(BaseModel):
    folder_ids: list[int] | None = None
    process_ai: bool = True


@app.post("/api/scan")
def post_scan(body: ScanIn) -> dict:
    started = scanner.start_scan(body.folder_ids)
    return {"started": started}


@app.get("/api/scan/status")
def scan_status() -> dict:
    return {
        "scan": scanner.STATUS.snapshot(),
        "ai": ai_pipeline.STATUS,
    }


@app.post("/api/ai/process")
def post_process() -> dict:
    return {"started": ai_pipeline.start_processing()}


# -------------------------------------------------------------- Media -------

@app.get("/api/media")
def get_media_list(
    view: str = "photos", sort: str = "newest", limit: int = 200, offset: int = 0
) -> dict:
    return repository.list_media(view=view, sort=sort, limit=limit, offset=offset)


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
        "SELECT thumb_path, path FROM media WHERE id = ?", (media_id,)
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    thumb = row["thumb_path"]
    if thumb and Path(thumb).exists():
        return FileResponse(thumb, media_type="image/webp", headers=_REVALIDATE)
    # fall back to original if thumbnail is missing
    if row["path"] and Path(row["path"]).exists():
        return FileResponse(row["path"], headers=_REVALIDATE)
    raise HTTPException(status_code=404, detail="File missing")


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
        raise HTTPException(status_code=415, detail="Cannot render this image")
    return FileResponse(jpeg, media_type="image/jpeg", headers=_REVALIDATE)


# ------------------------------------------------------------- People -------

@app.get("/api/people")
def get_people(include_hidden: bool = False) -> dict:
    return {"people": repository.list_people(include_hidden=include_hidden)}


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
    ok = repository.merge_people(body.source_id, body.target_id)
    return {"ok": ok}


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
    except Exception as e:
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


# ------------------------------------------------------------- Search -------

@app.get("/api/search")
def get_search(q: str, limit: int = 200) -> dict:
    return repository.search(q, limit=limit)


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
    return {"id": repository.create_album(body.name)}


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

    init_db()
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    run()
