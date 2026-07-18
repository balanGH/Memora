"""Background AI processing + face clustering.

Runs the (currently stubbed) AI services over any media rows that haven't been
processed yet, persists faces / tags / OCR / embeddings, and greedily clusters
faces into ``people`` by embedding similarity. Structured so real models slot
in behind ``app.ai`` without touching this orchestration.
"""
from __future__ import annotations

import json
import struct
import threading
from datetime import datetime
from pathlib import Path
from typing import Optional

from .ai import get_ai
from .ai.interfaces import cosine_similarity
from .db import get_conn, transaction

_CLUSTER_THRESHOLD = 0.92  # cosine similarity to treat two faces as same person
_lock = threading.Lock()

STATUS = {
    "running": False,
    "processed": 0,
    "total": 0,
    "finished_at": None,
}


def _pack(vec: list[float]) -> bytes:
    return struct.pack(f"{len(vec)}f", *vec)


def _unpack(blob: Optional[bytes]) -> list[float]:
    if not blob:
        return []
    n = len(blob) // 4
    return list(struct.unpack(f"{n}f", blob))


def _assign_person(conn, embedding: list[float]) -> int:
    """Find the closest existing person or create a new one."""
    rows = conn.execute(
        """
        SELECT p.id AS person_id, f.embedding AS embedding
        FROM people p JOIN faces f ON f.person_id = p.id
        WHERE f.embedding IS NOT NULL
        GROUP BY p.id
        """
    ).fetchall()

    best_id, best_sim = None, 0.0
    for row in rows:
        sim = cosine_similarity(embedding, _unpack(row["embedding"]))
        if sim > best_sim:
            best_id, best_sim = row["person_id"], sim

    if best_id is not None and best_sim >= _CLUSTER_THRESHOLD:
        return best_id

    cur = conn.execute("INSERT INTO people(name) VALUES (NULL)")
    return cur.lastrowid


def _process_one(conn, media_id: int, path: Path) -> None:
    ai = get_ai()
    result = ai.analyze(path)

    for face in result.faces:
        person_id = _assign_person(conn, face.embedding)
        conn.execute(
            """INSERT INTO faces(media_id, person_id, bbox_x, bbox_y, bbox_w,
                                 bbox_h, embedding)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (media_id, person_id, face.bbox.x, face.bbox.y, face.bbox.w,
             face.bbox.h, _pack(face.embedding)),
        )
        # give the person a cover photo if it lacks one
        conn.execute(
            "UPDATE people SET cover_media_id = ? WHERE id = ? AND cover_media_id IS NULL",
            (media_id, person_id),
        )

    for tag in result.tags:
        conn.execute(
            "INSERT INTO tags(media_id, kind, label, confidence) VALUES (?, ?, ?, ?)",
            (media_id, tag.kind, tag.label, tag.confidence),
        )

    if result.ocr_text:
        conn.execute(
            "INSERT INTO tags(media_id, kind, label, confidence) VALUES (?, 'ocr', ?, 1.0)",
            (media_id, result.ocr_text),
        )

    conn.execute(
        "UPDATE media SET ai_processed = 1 WHERE id = ?", (media_id,)
    )
    # store CLIP embedding on the media row via a tag-free side table would be
    # cleaner; for the slice we keep it in a JSON tag for simplicity.
    conn.execute(
        "INSERT INTO tags(media_id, kind, label, confidence) VALUES (?, 'embedding', ?, 1.0)",
        (media_id, json.dumps(result.clip_embedding)),
    )


def _worker() -> None:
    conn = get_conn()
    pending = conn.execute(
        "SELECT id, path FROM media WHERE ai_processed = 0 AND kind = 'image'"
    ).fetchall()

    STATUS.update(running=True, processed=0, total=len(pending), finished_at=None)
    try:
        for row in pending:
            try:
                with transaction() as tconn:
                    _process_one(tconn, row["id"], Path(row["path"]))
            except Exception:
                pass
            STATUS["processed"] += 1
    finally:
        STATUS.update(running=False, finished_at=datetime.now().isoformat())


def start_processing() -> bool:
    if not _lock.acquire(blocking=False):
        return False
    if STATUS["running"]:
        _lock.release()
        return False

    def _run():
        try:
            _worker()
        finally:
            _lock.release()

    threading.Thread(target=_run, daemon=True, name="memora-ai").start()
    return True
