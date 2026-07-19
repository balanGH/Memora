"""Background AI processing + face clustering.

Runs the (currently stubbed) AI services over any media rows that haven't been
processed yet, persists faces / tags / OCR / embeddings, and greedily clusters
faces into ``people`` by embedding similarity. Structured so real models slot
in behind ``app.ai`` without touching this orchestration.
"""
from __future__ import annotations

import json
import shutil
import struct
import threading
from datetime import datetime
from pathlib import Path
from typing import Optional

from .ai import get_ai
from .ai.interfaces import cosine_similarity
from .db import get_conn, transaction

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


def _assign_person(conn, embedding: list[float], threshold: float) -> int:
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

    if best_id is not None and best_sim >= threshold:
        return best_id

    cur = conn.execute("INSERT INTO people(name) VALUES (NULL)")
    return cur.lastrowid


def _persist_face(conn, media_id: int, face, threshold: float) -> None:
    person_id = _assign_person(conn, face.embedding, threshold)
    conn.execute(
        """INSERT INTO faces(media_id, person_id, bbox_x, bbox_y, bbox_w,
                             bbox_h, embedding)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (media_id, person_id, face.bbox.x, face.bbox.y, face.bbox.w,
         face.bbox.h, _pack(face.embedding)),
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
    if not frames:
        # ffmpeg missing / extraction failed — nothing to analyze.
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

    # clean up temp frames
    try:
        shutil.rmtree(frames[0].parent, ignore_errors=True)
    except Exception:
        pass


def _process_one(conn, media_id: int, path: Path, kind: str) -> None:
    if kind == "video":
        _process_video(conn, media_id, path)
    else:
        _process_image(conn, media_id, path)
    conn.execute("UPDATE media SET ai_processed = 1 WHERE id = ?", (media_id,))


def _worker() -> None:
    from .media_utils import ffmpeg_path

    conn = get_conn()
    # Always process images. Only queue videos when ffmpeg is available, so they
    # stay pending (not marked done-with-nothing) until you install ffmpeg.
    if ffmpeg_path():
        pending = conn.execute(
            "SELECT id, path, kind FROM media WHERE ai_processed = 0"
        ).fetchall()
    else:
        pending = conn.execute(
            "SELECT id, path, kind FROM media WHERE ai_processed = 0 AND kind = 'image'"
        ).fetchall()

    STATUS.update(running=True, processed=0, total=len(pending), finished_at=None)
    try:
        for row in pending:
            try:
                with transaction() as tconn:
                    _process_one(tconn, row["id"], Path(row["path"]), row["kind"])
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
