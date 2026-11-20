"""Watch Folders: continuously auto-ingest new media.

A single background thread polls every folder marked ``watch = 1`` on an
interval and runs the same indexing pass as a manual scan (new, changed,
moved and missing files), then kicks off AI processing for new items.
Polling (rather than OS file events) keeps this dependency-free and
cross-platform; unchanged files cost one ``stat`` each.

A sweep takes the scanner's lock without waiting: if a manual scan is running
the sweep is skipped, so the two never index the same files at once.
"""
from __future__ import annotations

import threading
from datetime import datetime
from typing import Optional

from . import ai_pipeline, scanner
from .db import get_conn

_INTERVAL = 15  # seconds between sweeps
_thread: Optional[threading.Thread] = None
_stop = threading.Event()

STATUS = {
    "running": False,
    "watched": 0,
    "added_total": 0,
    "last_check": None,
    "skipped_busy": 0,
}


def reset_state() -> None:
    STATUS.update(running=False, watched=0, added_total=0, last_check=None, skipped_busy=0)


def _watched_folders() -> list[dict]:
    conn = get_conn()
    return [
        dict(r)
        for r in conn.execute("SELECT id, path FROM folders WHERE watch = 1").fetchall()
    ]


def _sweep() -> Optional[dict]:
    """One pass over the watched folders. None if a scan held the lock."""
    folders = _watched_folders()
    STATUS["watched"] = len(folders)
    if not folders:
        STATUS["last_check"] = datetime.now().isoformat()
        return {"added": 0}
    if not scanner._scan_lock.acquire(blocking=False):
        STATUS["skipped_busy"] += 1
        return None
    try:
        totals = scanner.scan_folders([f["id"] for f in folders], status=None, cancel=_stop)
    finally:
        scanner._scan_lock.release()
    new = totals["added"] + totals["updated"]
    if new:
        STATUS["added_total"] += totals["added"]
        ai_pipeline.start_processing()  # enqueue AI for the new files
    STATUS["last_check"] = datetime.now().isoformat()
    return totals


def _loop() -> None:
    STATUS["running"] = True
    try:
        while not _stop.is_set():
            try:
                _sweep()
            except Exception as e:  # never let the watcher thread die
                print(f"[memora.watch] sweep failed: {type(e).__name__}")
            _stop.wait(_INTERVAL)
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


def stop_watcher(timeout: float = 5.0) -> bool:
    """Ask the watcher to stop and wait for it. True if it stopped."""
    _stop.set()
    t = _thread
    if t is not None:
        t.join(timeout)
        return not t.is_alive()
    return True


def snapshot() -> dict:
    return dict(STATUS)
