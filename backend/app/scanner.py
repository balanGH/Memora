"""Folder scanning and incremental indexing.

Walks registered folders, discovers media files, extracts metadata, generates
thumbnails, and upserts rows into SQLite. Designed to be run in a background
thread; progress is reported through a shared, thread-safe status object.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

from .config import IMAGE_EXTENSIONS, MEDIA_EXTENSIONS
from .db import get_conn, transaction
from .media_utils import extract_metadata, generate_thumbnail


@dataclass
class ScanStatus:
    running: bool = False
    total: int = 0
    processed: int = 0
    added: int = 0
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
                "current_folder": self.current_folder,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
            }


STATUS = ScanStatus()
_scan_lock = threading.Lock()


def add_folder(path: str) -> int:
    p = Path(path).expanduser().resolve()
    if not p.is_dir():
        raise ValueError(f"Not a directory: {p}")
    with transaction() as conn:
        cur = conn.execute(
            "INSERT OR IGNORE INTO folders(path) VALUES (?)", (str(p),)
        )
        if cur.lastrowid:
            return cur.lastrowid
        row = conn.execute(
            "SELECT id FROM folders WHERE path = ?", (str(p),)
        ).fetchone()
        return row["id"]


def list_folders() -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, path, added_at, last_scan FROM folders ORDER BY added_at"
    ).fetchall()
    return [dict(r) for r in rows]


def _iter_media_files(root: Path):
    for entry in root.rglob("*"):
        if entry.is_file() and entry.suffix.lower() in MEDIA_EXTENSIONS:
            yield entry


def _index_file(conn, folder_id: int, path: Path) -> bool:
    """Insert one media file. Returns True if newly added."""
    existing = conn.execute(
        "SELECT id FROM media WHERE path = ?", (str(path),)
    ).fetchone()
    if existing:
        return False

    kind = "image" if path.suffix.lower() in IMAGE_EXTENSIONS else "video"
    try:
        size = path.stat().st_size
    except OSError:
        size = None

    meta = extract_metadata(path) if kind == "image" else {}
    thumb = generate_thumbnail(path) if kind == "image" else None

    conn.execute(
        """
        INSERT INTO media (
            folder_id, path, filename, kind, size_bytes, width, height,
            taken_at, thumb_path, camera_make, camera_model, gps_lat, gps_lon
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            folder_id,
            str(path),
            path.name,
            kind,
            size,
            meta.get("width"),
            meta.get("height"),
            meta.get("taken_at"),
            thumb,
            meta.get("camera_make"),
            meta.get("camera_model"),
            meta.get("gps_lat"),
            meta.get("gps_lon"),
        ),
    )
    return True


def _scan_worker(folder_ids: Optional[list[int]] = None) -> None:
    conn = get_conn()
    folders = list_folders()
    if folder_ids:
        folders = [f for f in folders if f["id"] in folder_ids]

    with STATUS._lock:
        STATUS.running = True
        STATUS.total = 0
        STATUS.processed = 0
        STATUS.added = 0
        STATUS.started_at = datetime.now().isoformat()
        STATUS.finished_at = None

    try:
        # Pass 1: count for progress.
        file_map: dict[int, list[Path]] = {}
        for folder in folders:
            files = list(_iter_media_files(Path(folder["path"])))
            file_map[folder["id"]] = files
            with STATUS._lock:
                STATUS.total += len(files)

        # Pass 2: index.
        for folder in folders:
            with STATUS._lock:
                STATUS.current_folder = folder["path"]
            for path in file_map[folder["id"]]:
                try:
                    with transaction() as tconn:
                        if _index_file(tconn, folder["id"], path):
                            with STATUS._lock:
                                STATUS.added += 1
                except Exception:
                    pass
                finally:
                    with STATUS._lock:
                        STATUS.processed += 1
            conn.execute(
                "UPDATE folders SET last_scan = datetime('now') WHERE id = ?",
                (folder["id"],),
            )
            conn.commit()
    finally:
        with STATUS._lock:
            STATUS.running = False
            STATUS.current_folder = None
            STATUS.finished_at = datetime.now().isoformat()


def start_scan(folder_ids: Optional[list[int]] = None) -> bool:
    """Kick off a scan in a background thread. Returns False if already running."""
    if not _scan_lock.acquire(blocking=False):
        return False
    try:
        if STATUS.running:
            return False

        def _run():
            try:
                _scan_worker(folder_ids)
            finally:
                _scan_lock.release()

        threading.Thread(target=_run, daemon=True, name="memora-scan").start()
        return True
    except Exception:
        _scan_lock.release()
        raise
