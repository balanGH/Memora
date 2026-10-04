"""Background AI processing + face clustering.

Runs the AI services (stub or real, see ``app.ai``) over any media rows that haven't been
processed yet, persists faces / tags / OCR / embeddings, and greedily clusters
faces into ``people`` by embedding similarity. Structured so real models slot
in behind ``app.ai`` without touching this orchestration.
"""
from __future__ import annotations

import json
import shutil
import struct
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

from .ai import get_ai
from .ai.interfaces import cosine_similarity
from .db import get_conn, transaction

_lock = threading.Lock()

# Control flags for the Processing Center (pause / resume / cancel).
_pause = threading.Event()
_cancel = threading.Event()

STATUS = {
    "running": False,
    "processed": 0,
    "total": 0,
    "failed": 0,
    "paused": False,
    "cancelling": False,
    "current": None,
    "finished_at": None,
}


def _pack(vec: list[float]) -> bytes:
    return struct.pack(f"{len(vec)}f", *vec)


def _unpack(blob: Optional[bytes]) -> list[float]:
    if not blob:
        return []
    n = len(blob) // 4
    return list(struct.unpack(f"{n}f", blob))


class _PersonIndex:
    """In-memory running centroid of every person's face embeddings.

    The old approach compared each new face against ONE arbitrary face per
    person (SQLite's bare column in a GROUP BY), so clustering quality depended
    on which face SQLite happened to return. Matching against the mean of all a
    person's faces is far more stable, and keeping it in memory avoids
    re-reading every embedding from SQLite for each new face.
    """

    def __init__(self) -> None:
        self._sum: dict[int, list[float]] = {}
        self.loaded = False

    def load(self, conn) -> None:
        self._sum.clear()
        for row in conn.execute(
            "SELECT person_id, embedding FROM faces "
            "WHERE person_id IS NOT NULL AND embedding IS NOT NULL"
        ):
            self.add(row["person_id"], _unpack(row["embedding"]))
        self.loaded = True

    def add(self, person_id: int, vec: list[float]) -> None:
        if not vec:
            return
        cur = self._sum.get(person_id)
        if cur is None or len(cur) != len(vec):
            self._sum[person_id] = list(vec)
        else:
            for i, v in enumerate(vec):
                cur[i] += v

    def best_match(self, vec: list[float]) -> tuple[Optional[int], float]:
        best_id, best_sim = None, 0.0
        for pid, total in self._sum.items():
            # Cosine similarity is scale-invariant, so the sum acts as the mean.
            sim = cosine_similarity(vec, total)
            if sim > best_sim:
                best_id, best_sim = pid, sim
        return best_id, best_sim


_index = _PersonIndex()
# Set by manual merge/split so the worker reloads centroids before its next face.
_index_dirty = threading.Event()


def invalidate_person_index() -> None:
    """Call after people/faces are changed outside the pipeline (merge, split)."""
    _index_dirty.set()


def _assign_person(conn, embedding: list[float], threshold: float) -> int:
    """Find the closest existing person or create a new one."""
    if not _index.loaded or _index_dirty.is_set():
        _index_dirty.clear()
        _index.load(conn)

    best_id, best_sim = _index.best_match(embedding)
    if best_id is not None and best_sim >= threshold:
        person_id = best_id
    else:
        person_id = conn.execute("INSERT INTO people(name) VALUES (NULL)").lastrowid
    _index.add(person_id, embedding)
    return person_id


def _persist_face(conn, media_id: int, face, threshold: float) -> None:
    person_id = _assign_person(conn, face.embedding, threshold)
    conn.execute(
        """INSERT INTO faces(media_id, person_id, bbox_x, bbox_y, bbox_w,
                             bbox_h, embedding, age, gender)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (media_id, person_id, face.bbox.x, face.bbox.y, face.bbox.w,
         face.bbox.h, _pack(face.embedding),
         getattr(face, "age", None), getattr(face, "gender", None)),
    )
    conn.execute(
        "UPDATE people SET cover_media_id = ? WHERE id = ? AND cover_media_id IS NULL",
        (media_id, person_id),
    )


def _persist_tags(conn, media_id: int, tags, ocr_text: str, embedding) -> None:
    for tag in tags:
        conn.execute(
            "INSERT INTO tags(media_id, kind, label, confidence) VALUES (?, ?, ?, ?)",
            (media_id, tag.kind, tag.label, tag.confidence),
        )
    if ocr_text:
        conn.execute(
            "INSERT INTO tags(media_id, kind, label, confidence) VALUES (?, 'ocr', ?, 1.0)",
            (media_id, ocr_text),
        )
    conn.execute(
        "INSERT INTO tags(media_id, kind, label, confidence) VALUES (?, 'embedding', ?, 1.0)",
        (media_id, json.dumps(embedding)),
    )


def _dedupe_faces(faces, threshold: float):
    """Collapse near-duplicate faces (same person across video frames)."""
    kept = []
    for f in faces:
        if any(
            cosine_similarity(f.embedding, k.embedding) >= threshold for k in kept
        ):
            continue
        kept.append(f)
    return kept


def _process_image(conn, media_id: int, path: Path) -> None:
    ai = get_ai()
    result = ai.analyze(path)
    for face in result.faces:
        _persist_face(conn, media_id, face, ai.face_match_threshold)
    _persist_tags(conn, media_id, result.tags, result.ocr_text, result.clip_embedding)


def _process_video(conn, media_id: int, path: Path) -> None:
    """Sample frames, detect+dedupe faces across them, tag a representative frame."""
    from .media_utils import extract_video_frames

    ai = get_ai()
    frames = extract_video_frames(path)
    try:
        if not frames:
            # Extraction failed (corrupt file / unsupported codec): nothing to analyze.
            _persist_tags(conn, media_id, [], "", [])
            return

        all_faces = []
        for frame in frames:
            try:
                all_faces.extend(ai.faces.detect(frame))
            except Exception:
                pass
        for face in _dedupe_faces(all_faces, ai.face_match_threshold):
            _persist_face(conn, media_id, face, ai.face_match_threshold)

        # Tags + semantic embedding from the middle frame.
        mid = frames[len(frames) // 2]
        tags = ai.tagging.tag(mid)
        embedding = ai.embeddings.embed_image(mid)
        _persist_tags(conn, media_id, tags, "", embedding)
    finally:
        if frames:
            shutil.rmtree(frames[0].parent, ignore_errors=True)


def _process_one(conn, media_id: int, path: Path, kind: str) -> None:
    from .media_utils import file_sha1

    # Exact-duplicate hash (Duplicate Center / Processing Center); compute once.
    row = conn.execute("SELECT file_hash FROM media WHERE id = ?", (media_id,)).fetchone()
    if row and not row["file_hash"]:
        h = file_sha1(path)
        if h:
            conn.execute("UPDATE media SET file_hash = ? WHERE id = ?", (h, media_id))

    if kind == "video":
        _process_video(conn, media_id, path)
    else:
        _process_image(conn, media_id, path)
    conn.execute(
        "UPDATE media SET ai_processed = 1, ai_error = NULL WHERE id = ?", (media_id,)
    )


def _pending(conn, exclude: set[int]) -> list:
    """Unprocessed media not yet attempted in this run.

    Items with a recorded error are skipped (Retry re-queues them) so a corrupt
    file is not re-attempted on every watcher sweep. Videos are only queued when
    ffmpeg is available, so they stay pending until it is installed.
    """
    from .media_utils import ffmpeg_path

    sql = "SELECT id, path, kind FROM media WHERE ai_processed = 0 AND ai_error IS NULL"
    if not ffmpeg_path():
        sql += " AND kind = 'image'"
    return [r for r in conn.execute(sql).fetchall() if r["id"] not in exclude]


def _worker() -> None:
    conn = get_conn()
    attempted: set[int] = set()
    pending = _pending(conn, attempted)

    STATUS.update(
        running=True, processed=0, total=len(pending), failed=0,
        paused=False, cancelling=False, current=None, finished_at=None,
    )
    # Fresh centroids each run (people may have been edited since last time).
    _index.loaded = False
    try:
        while pending and not _cancel.is_set():
            for row in pending:
                if _cancel.is_set():
                    break
                # Honor a pause request without burning CPU.
                while _pause.is_set() and not _cancel.is_set():
                    STATUS["paused"] = True
                    time.sleep(0.3)
                STATUS["paused"] = False
                if _cancel.is_set():
                    break

                attempted.add(row["id"])
                STATUS["current"] = row["path"]
                try:
                    with transaction() as tconn:
                        _process_one(tconn, row["id"], Path(row["path"]), row["kind"])
                except Exception as e:  # record the failure so it can be retried
                    STATUS["failed"] += 1
                    # The rollback discarded this item's faces; resync centroids.
                    _index.loaded = False
                    try:
                        with transaction() as econn:
                            econn.execute(
                                "UPDATE media SET ai_error = ? WHERE id = ?",
                                (f"{type(e).__name__}: {e}"[:500], row["id"]),
                            )
                    except Exception:
                        pass
                STATUS["processed"] += 1

            # Pick up anything added while we were busy (watcher, rescans, retry).
            pending = _pending(conn, attempted)
            STATUS["total"] += len(pending)
    finally:
        STATUS.update(
            running=False, paused=False, cancelling=False, current=None,
            finished_at=datetime.now().isoformat(),
        )
        _cancel.clear()
        _pause.clear()


def start_processing() -> bool:
    if not _lock.acquire(blocking=False):
        return False
    if STATUS["running"]:
        _lock.release()
        return False
    # Never start a run already paused/cancelled by a stale request.
    _cancel.clear()
    _pause.clear()

    def _run():
        try:
            _worker()
        finally:
            _lock.release()

    threading.Thread(target=_run, daemon=True, name="memora-ai").start()
    return True


# ----------------------------------------------------- Processing controls ---

def pause_processing() -> bool:
    if not STATUS["running"]:
        return False
    _pause.set()
    return True


def resume_processing() -> bool:
    _pause.clear()
    return True


def cancel_processing() -> bool:
    """Stop the current run after the in-flight item (does not undo work done)."""
    if not STATUS["running"]:
        return False
    STATUS["cancelling"] = True
    _cancel.set()
    _pause.clear()
    return True


def retry_failed() -> int:
    """Clear errors on failed media so the next run reprocesses them."""
    conn = get_conn()
    cur = conn.execute(
        "UPDATE media SET ai_error = NULL, ai_processed = 0 WHERE ai_error IS NOT NULL"
    )
    conn.commit()
    n = cur.rowcount
    if n:
        start_processing()
    return n
