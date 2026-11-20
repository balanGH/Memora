"""Folder scanning and incremental indexing.

Walks registered folders, discovers media files, extracts metadata, generates
thumbnails, and upserts rows into SQLite. Runs in a background thread;
progress is reported through a shared, thread-safe status object.

Safety rules (see AUDIT_REPORT.md):

* Originals are only read, never written, moved or deleted.
* Memora's own data directory is never indexed, and symlinks/junctions are not
  followed, so a scan can't escape the folders the user chose.
* A file that disappears is *flagged* missing, never deleted automatically.
  A folder that is not reachable (unplugged drive) is skipped entirely.
* A new file whose SHA-256 matches a missing item is treated as a move: the
  existing item is re-pointed, keeping favorites, albums, faces and tags.
* One bad file never stops a scan; failures are recorded for retry.
"""
from __future__ import annotations

import os
import threading
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Iterator, Optional

from .config import IMAGE_EXTENSIONS, MEDIA_EXTENSIONS, resolved_data_dir
from .db import PRUNE_EMPTY_PEOPLE_SQL, get_conn, stable_media_id, transaction
from .media_utils import (
    extract_metadata,
    extract_video_metadata,
    file_sha256,
    generate_thumbnail,
    generate_video_thumbnail,
    phash_file,
    unsupported_reason,
)

# A thumbnail that fails this many scans in a row is not retried until the
# file changes or the user asks for a retry.
MAX_THUMB_ATTEMPTS = 3


@dataclass
class ScanStatus:
    running: bool = False
    total: int = 0
    processed: int = 0
    added: int = 0
    updated: int = 0
    moved: int = 0
    missing: int = 0
    failed: int = 0
    cancelled: bool = False
    current_folder: Optional[str] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "running": self.running,
                "total": self.total,
                "processed": self.processed,
                "added": self.added,
                "updated": self.updated,
                "moved": self.moved,
                "missing": self.missing,
                "failed": self.failed,
                "cancelled": self.cancelled,
                "current_folder": self.current_folder,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
            }

    def bump(self, **counts: int) -> None:
        with self._lock:
            for k, v in counts.items():
                setattr(self, k, getattr(self, k) + v)


STATUS = ScanStatus()
# Held for the whole duration of any indexing pass (manual scan or watcher
# sweep), so two passes never index the same files at once (B13).
_scan_lock = threading.Lock()
_cancel = threading.Event()
_thread: Optional[threading.Thread] = None


def reset_state() -> None:
    """Testing hook: forget status and flags (not the lock if held)."""
    global STATUS
    _cancel.clear()
    STATUS = ScanStatus()


# ------------------------------------------------------------- paths -------

def _norm(p) -> str:
    return os.path.normcase(os.path.realpath(p))


def _is_within(child: str, parent: str) -> bool:
    """True if normalized ``child`` equals or is inside normalized ``parent``."""
    try:
        return os.path.commonpath([child, parent]) == parent
    except ValueError:  # different drives on Windows
        return False


_isjunction = getattr(os.path, "isjunction", lambda _p: False)


def _is_link(p: str) -> bool:
    return os.path.islink(p) or _isjunction(p)


def library_roots() -> list[str]:
    conn = get_conn()
    return [r["path"] for r in conn.execute("SELECT path FROM folders").fetchall()]


def path_in_library(path) -> Optional[str]:
    """The library folder containing ``path`` (or equal to it), else None."""
    target = _norm(path)
    for root in library_roots():
        if _is_within(target, _norm(root)):
            return root
    return None


def path_in_data_dir(path) -> bool:
    return _is_within(_norm(path), resolved_data_dir())


# ----------------------------------------------------------- folders -------

def add_folder(path: str) -> int:
    p = Path(path).expanduser()
    if not p.is_absolute():
        raise ValueError(f"Folder path must be absolute: {path}")
    try:
        p = p.resolve(strict=True)
    except (OSError, RuntimeError):
        raise ValueError(f"Not a directory: {p}")
    if not p.is_dir():
        raise ValueError(f"Not a directory: {p}")
    if path_in_data_dir(p):
        raise ValueError("Memora's own data folder can't be added to the library")

    conn = get_conn()
    for row in conn.execute("SELECT id, path FROM folders").fetchall():
        existing = _norm(row["path"])
        if existing == _norm(p):
            return row["id"]
        if _is_within(_norm(p), existing):
            raise ValueError(f"Already in the library as part of {row['path']}")

    with transaction() as conn:
        cur = conn.execute("INSERT OR IGNORE INTO folders(path) VALUES (?)", (str(p),))
        if cur.lastrowid:
            return cur.lastrowid
        row = conn.execute("SELECT id FROM folders WHERE path = ?", (str(p),)).fetchone()
        return row["id"]


def remove_folder(folder_id: int) -> int:
    """Forget a library folder and everything indexed from it.

    Originals on disk are never touched. Returns how many media rows were
    removed; faces, tags and album entries go with them (ON DELETE CASCADE).
    """
    with transaction() as conn:
        removed = conn.execute(
            "SELECT COUNT(*) FROM media WHERE folder_id = ?", (folder_id,)
        ).fetchone()[0]
        conn.execute("DELETE FROM media WHERE folder_id = ?", (folder_id,))
        conn.execute("DELETE FROM scan_failures WHERE folder_id = ?", (folder_id,))
        conn.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
        # Drop people left with no faces at all.
        conn.execute(
            PRUNE_EMPTY_PEOPLE_SQL
        )
    from .ai_pipeline import invalidate_person_index

    invalidate_person_index()
    return removed


def list_folders() -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, path, added_at, last_scan, watch FROM folders ORDER BY added_at"
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["available"] = os.path.isdir(r["path"])
        out.append(d)
    return out


# ------------------------------------------------------------- walking -----

def _iter_media_files(root: Path) -> Iterator[Path]:
    """Media files under ``root``: no symlinks/junctions, never the data dir."""
    data_dir = resolved_data_dir()
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        kept = []
        for d in dirnames:
            full = os.path.join(dirpath, d)
            if _is_link(full) or _is_within(_norm(full), data_dir):
                continue
            kept.append(d)
        dirnames[:] = kept
        for name in filenames:
            if os.path.splitext(name)[1].lower() not in MEDIA_EXTENSIONS:
                continue
            full = os.path.join(dirpath, name)
            if _is_link(full):
                continue
            yield Path(full)


def _count_media_files(root: Path) -> int:
    return sum(1 for _ in _iter_media_files(root))


# ------------------------------------------------------------ indexing -----

def _free_media_id(conn, path: str) -> int:
    """Path-derived id, or a salted variant if a moved item already owns it."""
    mid, n = stable_media_id(path), 0
    while conn.execute("SELECT 1 FROM media WHERE id = ?", (mid,)).fetchone():
        n += 1
        mid = stable_media_id(f"{path}#{n}")
    return mid


def _derive(path: Path, kind: str, st: os.stat_result) -> dict:
    """Everything computed from the file's content (metadata, thumb, hashes)."""
    meta = extract_metadata(path) if kind == "image" else extract_video_metadata(path)
    thumb = (
        generate_thumbnail(path, st.st_size, st.st_mtime_ns)
        if kind == "image"
        else generate_video_thumbnail(path, st.st_size, st.st_mtime_ns)
    )
    return {
        "meta": meta,
        "thumb": thumb,
        "phash": phash_file(Path(thumb)) if thumb else None,
        "sha256": file_sha256(path),
    }


def _record_thumb_failure(conn, folder_id: int, path: Path, kind: str) -> None:
    if kind != "image":
        return  # video thumbnails legitimately need ffmpeg; not a failure
    reason = unsupported_reason(path) or "Could not decode image (corrupt or unsupported)"
    _record_failure(conn, folder_id, path, reason)


def _record_failure(conn, folder_id: Optional[int], path: Path, error: str) -> None:
    conn.execute(
        """INSERT INTO scan_failures(path, folder_id, error) VALUES (?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET error = excluded.error,
               attempts = attempts + 1, last_attempt = datetime('now')""",
        (str(path), folder_id, error[:500]),
    )


def _clear_failure(conn, path: Path) -> None:
    conn.execute("DELETE FROM scan_failures WHERE path = ?", (str(path),))


_CONTENT_COLUMNS = """size_bytes = ?, mtime_ns = ?, width = ?, height = ?, taken_at = ?,
    taken_at_source = ?, tz_offset = ?, thumb_path = ?, camera_make = ?, camera_model = ?,
    gps_lat = ?, gps_lon = ?, duration = ?, video_codec = ?, phash = ?, file_hash = ?,
    thumb_attempts = ?"""


def _content_values(st: os.stat_result, d: dict) -> tuple:
    m = d["meta"]
    return (
        st.st_size, st.st_mtime_ns, m.get("width"), m.get("height"), m.get("taken_at"),
        m.get("taken_at_source"), m.get("tz_offset"), d["thumb"], m.get("camera_make"),
        m.get("camera_model"), m.get("gps_lat"), m.get("gps_lon"), m.get("duration"),
        m.get("video_codec"), d["phash"], d["sha256"], 0 if d["thumb"] else 1,
    )


def _reset_ai(conn, media_id: int) -> None:
    """Content changed: AI output describes the old pixels, so drop it (manual
    'user' tags are kept) and queue the item again."""
    conn.execute("DELETE FROM faces WHERE media_id = ?", (media_id,))
    conn.execute("DELETE FROM tags WHERE media_id = ? AND kind != 'user'", (media_id,))
    conn.execute(
        """UPDATE media SET ai_processed = 0, ai_error = NULL, faces_model = NULL,
               tags_model = NULL, ocr_model = NULL, embed_model = NULL WHERE id = ?""",
        (media_id,),
    )


def _index_file(conn, folder_id: int, path: Path) -> str:
    """Index or refresh one file.

    Returns 'added' | 'updated' | 'moved' | 'unchanged' | 'excluded'.
    Raises on unexpected errors (the caller records them).
    """
    spath = str(path)
    if conn.execute("SELECT 1 FROM excluded_paths WHERE path = ?", (spath,)).fetchone():
        return "excluded"  # removed from the library by the user ("Empty trash")
    st = path.stat()
    kind = "image" if path.suffix.lower() in IMAGE_EXTENSIONS else "video"
    row = conn.execute(
        """SELECT id, size_bytes, mtime_ns, thumb_path, file_hash, is_missing,
                  thumb_attempts FROM media WHERE path = ?""",
        (spath,),
    ).fetchone()

    if row is not None:
        legacy = row["mtime_ns"] is None  # indexed before change tracking existed
        changed = row["size_bytes"] != st.st_size or (
            not legacy and row["mtime_ns"] != st.st_mtime_ns
        )
        if changed:
            d = _derive(path, kind, st)
            conn.execute(
                f"UPDATE media SET {_CONTENT_COLUMNS}, folder_id = ?, is_missing = 0, "
                "missing_since = NULL WHERE id = ?",
                (*_content_values(st, d), folder_id, row["id"]),
            )
            _reset_ai(conn, row["id"])
            if d["thumb"]:
                _clear_failure(conn, path)
            else:
                _record_thumb_failure(conn, folder_id, path, kind)
            return "updated"

        sets: dict[str, object] = {}
        if legacy:
            sets["mtime_ns"] = st.st_mtime_ns
        if row["is_missing"]:
            sets["is_missing"], sets["missing_since"] = 0, None
        if not row["file_hash"]:
            sets["file_hash"] = file_sha256(path)  # backfill (legacy rows)
        thumb_ok = bool(row["thumb_path"]) and os.path.exists(row["thumb_path"])
        if not thumb_ok and (row["thumb_attempts"] or 0) < MAX_THUMB_ATTEMPTS:
            thumb = (
                generate_thumbnail(path, st.st_size, st.st_mtime_ns)
                if kind == "image"
                else generate_video_thumbnail(path, st.st_size, st.st_mtime_ns)
            )
            if thumb:
                sets.update(thumb_path=thumb, thumb_attempts=0, phash=phash_file(Path(thumb)))
                _clear_failure(conn, path)
            elif kind == "image":
                sets["thumb_attempts"] = (row["thumb_attempts"] or 0) + 1
                _record_thumb_failure(conn, folder_id, path, kind)
        if sets:
            cols = ", ".join(f"{k} = ?" for k in sets)
            conn.execute(f"UPDATE media SET {cols} WHERE id = ?", (*sets.values(), row["id"]))
        return "unchanged"

    d = _derive(path, kind, st)

    # Moved / renamed file: same bytes as an item whose file has vanished.
    if d["sha256"]:
        for cand in conn.execute(
            "SELECT id, path FROM media WHERE file_hash = ? AND is_missing = 1",
            (d["sha256"],),
        ).fetchall():
            if not os.path.exists(cand["path"]):
                conn.execute(
                    f"UPDATE media SET {_CONTENT_COLUMNS}, path = ?, filename = ?, "
                    "folder_id = ?, is_missing = 0, missing_since = NULL WHERE id = ?",
                    (*_content_values(st, d), spath, path.name, folder_id, cand["id"]),
                )
                _clear_failure(conn, Path(cand["path"]))
                return "moved"

    m = d["meta"]
    conn.execute(
        """
        INSERT INTO media (
            id, folder_id, path, filename, kind, size_bytes, mtime_ns, width, height,
            taken_at, taken_at_source, tz_offset, thumb_path, camera_make, camera_model,
            gps_lat, gps_lon, duration, video_codec, phash, file_hash, thumb_attempts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            _free_media_id(conn, spath), folder_id, spath, path.name, kind,
            st.st_size, st.st_mtime_ns, m.get("width"), m.get("height"),
            m.get("taken_at"), m.get("taken_at_source"), m.get("tz_offset"), d["thumb"],
            m.get("camera_make"), m.get("camera_model"), m.get("gps_lat"), m.get("gps_lon"),
            m.get("duration"), m.get("video_codec"), d["phash"], d["sha256"],
            0 if d["thumb"] else 1,
        ),
    )
    if d["thumb"]:
        _clear_failure(conn, path)
    else:
        _record_thumb_failure(conn, folder_id, path, kind)
    return "added"


def _reconcile_missing(folder_id: int) -> int:
    """Flag (never delete) items of a reachable folder whose file is gone.
    Returns how many were newly flagged."""
    conn = get_conn()
    gone = [
        r["id"]
        for r in conn.execute(
            "SELECT id, path FROM media WHERE folder_id = ? AND is_missing = 0", (folder_id,)
        )
        if not os.path.exists(r["path"])
    ]
    if gone:
        with transaction() as tx:
            tx.executemany(
                "UPDATE media SET is_missing = 1, missing_since = datetime('now') WHERE id = ?",
                [(i,) for i in gone],
            )
    return len(gone)


def scan_folders(
    folder_ids: Optional[list[int]] = None, *, status: Optional[ScanStatus] = None,
    cancel: Optional[threading.Event] = None,
) -> dict:
    """Synchronous indexing pass. Caller must hold ``_scan_lock``.

    ``status`` receives live progress (None for quiet watcher sweeps).
    """
    folders = list_folders()
    if folder_ids:
        folders = [f for f in folders if f["id"] in folder_ids]
    # An unplugged drive / deleted folder is skipped entirely: no walking and,
    # crucially, no "missing" flags for everything in it.
    folders = [f for f in folders if f["available"]]
    totals = {"added": 0, "updated": 0, "moved": 0, "missing": 0, "failed": 0, "processed": 0}

    def bump(key: str, n: int = 1) -> None:
        totals[key] += n
        if status is not None:
            status.bump(**{key: n})

    # Pass 0: flag vanished files first, so pass 2 can recognise moves
    # (including moves between two library folders).
    for f in folders:
        if cancel is not None and cancel.is_set():
            break
        bump("missing", _reconcile_missing(f["id"]))

    # Pass 1: count for progress (streaming; no file list kept in memory).
    if status is not None:
        for f in folders:
            n = _count_media_files(Path(f["path"]))
            status.bump(total=n)

    # Pass 2: index, one transaction per file so a failure only loses that file.
    conn = get_conn()
    for f in folders:
        if cancel is not None and cancel.is_set():
            break
        if status is not None:
            with status._lock:
                status.current_folder = f["path"]
        completed = True
        for path in _iter_media_files(Path(f["path"])):
            if cancel is not None and cancel.is_set():
                completed = False
                break
            try:
                with transaction() as tconn:
                    result = _index_file(tconn, f["id"], path)
                if result in ("added", "updated", "moved"):
                    bump(result)
            except Exception as e:  # isolate the bad file and keep going
                bump("failed")
                try:
                    with transaction() as econn:
                        _record_failure(econn, f["id"], path, f"{type(e).__name__}: {e}")
                except Exception:
                    pass
            finally:
                bump("processed")
        if completed:
            with transaction() as tx:
                tx.execute(
                    "UPDATE folders SET last_scan = datetime('now') WHERE id = ?", (f["id"],)
                )
    return totals


def _scan_worker(folder_ids: Optional[list[int]] = None, process_ai: bool = True) -> None:
    """Run a full scan with live status. Caller must hold ``_scan_lock``."""
    with STATUS._lock:
        STATUS.running = True
        STATUS.cancelled = False
        for k in ("total", "processed", "added", "updated", "moved", "missing", "failed"):
            setattr(STATUS, k, 0)
        STATUS.started_at = datetime.now().isoformat()
        STATUS.finished_at = None
    try:
        scan_folders(folder_ids, status=STATUS, cancel=_cancel)
    finally:
        with STATUS._lock:
            STATUS.running = False
            STATUS.cancelled = _cancel.is_set()
            STATUS.current_folder = None
            STATUS.finished_at = datetime.now().isoformat()
        cancelled = _cancel.is_set()
        _cancel.clear()
        if process_ai and not cancelled:
            from . import ai_pipeline

            # No-op when nothing is pending or a run is already going (the
            # running worker re-checks for new items before it exits).
            ai_pipeline.start_processing()


def start_scan(folder_ids: Optional[list[int]] = None, process_ai: bool = True) -> bool:
    """Kick off a scan in a background thread. Returns False if already running."""
    global _thread
    if not _scan_lock.acquire(blocking=False):
        return False
    try:
        _cancel.clear()

        def _run():
            try:
                _scan_worker(folder_ids, process_ai)
            finally:
                _scan_lock.release()

        _thread = threading.Thread(target=_run, daemon=True, name="memora-scan")
        _thread.start()
        return True
    except Exception:
        _scan_lock.release()
        raise


def cancel_scan() -> bool:
    """Stop the running scan after the current file. Re-scanning resumes
    cheaply: unchanged files are skipped by a size/mtime check."""
    if not STATUS.running:
        return False
    _cancel.set()
    return True


def wait(timeout: Optional[float] = None) -> bool:
    """Join the scan thread (tests / shutdown). True if it has finished."""
    t = _thread
    if t is not None:
        t.join(timeout)
        return not t.is_alive()
    return True


# ------------------------------------------------------ missing / failed ---

def missing_media(limit: int = 500) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        """SELECT id, filename, path, missing_since, thumb_path FROM media
           WHERE is_missing = 1 ORDER BY missing_since DESC LIMIT ?""",
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]


def forget_missing(media_ids: list[int]) -> int:
    """Remove the given *missing* items from the library (explicit user action).

    Only rows still flagged missing whose file is still absent are removed; the
    files are not excluded, so if they come back they are re-imported.
    """
    if not media_ids:
        return 0
    conn = get_conn()
    placeholders = ",".join("?" * len(media_ids))
    rows = conn.execute(
        f"SELECT id, path FROM media WHERE is_missing = 1 AND id IN ({placeholders})",
        media_ids,
    ).fetchall()
    ids = [r["id"] for r in rows if not os.path.exists(r["path"])]
    if not ids:
        return 0
    with transaction() as tx:
        tx.executemany("DELETE FROM media WHERE id = ?", [(i,) for i in ids])
        tx.execute(
            PRUNE_EMPTY_PEOPLE_SQL
        )
    from .ai_pipeline import invalidate_person_index

    invalidate_person_index()
    return len(ids)


def scan_failures(limit: int = 200) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT path, error, attempts, last_attempt FROM scan_failures "
        "ORDER BY last_attempt DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]


def retry_scan_failures() -> bool:
    """Reset thumbnail attempt counters and rescan (resumes failed files)."""
    with transaction() as conn:
        conn.execute("UPDATE media SET thumb_attempts = 0 WHERE thumb_path IS NULL")
    return start_scan()
