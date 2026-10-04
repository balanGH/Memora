"""Watch Folders: continuously auto-ingest new media.

A single background thread polls every folder marked ``watch = 1`` on an
interval. New files (not already indexed) are indexed exactly like a manual
scan — metadata + thumbnail — then AI processing is kicked off so they become
searchable. Polling (rather than OS file events) keeps this dependency-free and
cross-platform; ``_index_file`` skips paths already in the DB, so re-walking is
cheap and idempotent.
"""
from __future__ import annotations

import threading
import time
from datetime import datetime
from pathlib import Path

from . import ai_pipeline, scanner
from .db import get_conn, transaction

_INTERVAL = 15  # seconds between sweeps
_thread: threading.Thread | None = None
_stop = threading.Event()

STATUS = {
    "running": False,
    "watched": 0,
    "added_total": 0,
    "last_check": None,
}


def _watched_folders() -> list[dict]:
    conn = get_conn()
    return [
        dict(r)
        for r in conn.execute("SELECT id, path FROM folders WHERE watch = 1").fetchall()
    ]


def _sweep() -> None:
    folders = _watched_folders()
    STATUS["watched"] = len(folders)
    added = 0
    for f in folders:
        root = Path(f["path"])
        if not root.is_dir():
            continue
        for path in scanner._iter_media_files(root):
            try:
                with transaction() as conn:
                    if scanner._index_file(conn, f["id"], path):
                        added += 1
            except Exception:
                pass
    if added:
        STATUS["added_total"] += added
        ai_pipeline.start_processing()  # enqueue AI for the new files
    STATUS["last_check"] = datetime.now().isoformat()


def _loop() -> None:
    STATUS["running"] = True
    try:
        while not _stop.is_set():
            try:
                _sweep()
            except Exception:
                pass
            # Wake early if asked to stop.
            for _ in range(_INTERVAL):
                if _stop.is_set():
                    break
                time.sleep(1)
    finally:
        STATUS["running"] = False


def start_watcher() -> None:
    """Start the watcher thread once (idempotent)."""
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, daemon=True, name="memora-watch")
    _thread.start()


def snapshot() -> dict:
    return dict(STATUS)
