"""Background AI processing + face clustering.

Runs the active AI services (see ``app.ai``) over media whose results are
missing or were produced by a different model, persists faces / tags / OCR /
embeddings, and greedily clusters faces into ``people`` by embedding
similarity.

Versioning & resumability (B29/B30): each media row records which model
produced its faces, tags, OCR and embedding (``faces_model`` …). A service
runs on an item only when its active model differs from the recorded one, and
it replaces only its own output. So:

* an interrupted run resumes where it stopped (finished items are recorded),
* installing a new model reprocesses just that service,
* a disabled service never deletes or rewrites existing results,
* faces from different models (incompatible embedding spaces) are never
  compared with each other.
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
from .db import PRUNE_EMPTY_PEOPLE_SQL, get_conn, transaction

_lock = threading.Lock()
_thread: Optional[threading.Thread] = None
BATCH = 100  # media rows fetched per query (bounded memory, B06)

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

# media column -> (models() key) for every AI service
_SERVICE_COLUMNS = {
    "faces": "faces_model",
    "tags": "tags_model",
    "ocr": "ocr_model",
    "embed": "embed_model",
}
_TAG_KINDS = ("object", "scene", "pet")


def reset_state() -> None:
    """Testing hook."""
    _pause.clear()
    _cancel.clear()
    STATUS.update(running=False, processed=0, total=0, failed=0, paused=False,
                  cancelling=False, current=None, finished_at=None)
    _index.reset()
    _index_dirty.clear()


def _pack(vec: list[float]) -> bytes:
    return struct.pack(f"{len(vec)}f", *vec)


def _unpack(blob: Optional[bytes]) -> list[float]:
    if not blob:
        return []
    n = len(blob) // 4
    return list(struct.unpack(f"{n}f", blob))


class _PersonIndex:
    """In-memory running centroid of every person's face embeddings, for one
    face model (embedding space) at a time.

    Matching against the mean of all a person's faces is far more stable than
    against one arbitrary face, and keeping it in memory avoids re-reading
    every embedding from SQLite for each new face.
    """

    def __init__(self) -> None:
        self._sum: dict[int, list[float]] = {}
        self.loaded = False
        self.model: Optional[str] = None

    def reset(self) -> None:
        self._sum.clear()
        self.loaded = False
        self.model = None

    def load(self, conn, model: Optional[str]) -> None:
        self._sum.clear()
        for row in conn.execute(
            "SELECT person_id, embedding FROM faces "
            "WHERE person_id IS NOT NULL AND embedding IS NOT NULL AND model IS ?",
            (model,),
        ):
            self.add(row["person_id"], _unpack(row["embedding"]))
        self.loaded = True
        self.model = model

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


def _assign_person(conn, embedding: list[float], threshold: float, model: str) -> tuple[int, float]:
    """Closest existing person (same face model) or a new one, plus the score."""
    if not _index.loaded or _index_dirty.is_set() or _index.model != model:
        _index_dirty.clear()
        _index.load(conn, model)

    best_id, best_sim = _index.best_match(embedding)
    if best_id is not None and best_sim >= threshold:
        person_id = best_id
    else:
        person_id = conn.execute("INSERT INTO people(name) VALUES (NULL)").lastrowid
        best_sim = 1.0  # founding face of a new cluster
    _index.add(person_id, embedding)
    return person_id, best_sim


def _persist_face(conn, media_id: int, face, threshold: float, model: str) -> None:
    person_id, score = _assign_person(conn, face.embedding, threshold, model)
    conn.execute(
        """INSERT INTO faces(media_id, person_id, bbox_x, bbox_y, bbox_w, bbox_h,
                             embedding, age, gender, model, det_score, match_score)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (media_id, person_id, face.bbox.x, face.bbox.y, face.bbox.w,
         face.bbox.h, _pack(face.embedding),
         getattr(face, "age", None), getattr(face, "gender", None),
         model, getattr(face, "score", None), round(score, 4)),
    )
    conn.execute(
        "UPDATE people SET cover_media_id = ? WHERE id = ? AND cover_media_id IS NULL",
        (media_id, person_id),
    )


def _dedupe_faces(faces, threshold: float):
    """Collapse near-duplicate faces (same person across video frames)."""
    kept = []
    for f in faces:
        if any(cosine_similarity(f.embedding, k.embedding) >= threshold for k in kept):
            continue
        kept.append(f)
    return kept


def _replace_faces(conn, media_id: int, faces, ai, model: str) -> None:
    conn.execute("DELETE FROM faces WHERE media_id = ?", (media_id,))
    for face in faces:
        _persist_face(conn, media_id, face, ai.face_match_threshold, model)


def _replace_tags(conn, media_id: int, tags, model: str) -> None:
    conn.execute(
        f"DELETE FROM tags WHERE media_id = ? AND kind IN ({','.join('?' * len(_TAG_KINDS))})",
        (media_id, *_TAG_KINDS),
    )
    for tag in tags:
        conn.execute(
            "INSERT INTO tags(media_id, kind, label, confidence, model) VALUES (?, ?, ?, ?, ?)",
            (media_id, tag.kind, tag.label, tag.confidence, model),
        )


def _replace_ocr(conn, media_id: int, text: str, model: str) -> None:
    conn.execute("DELETE FROM tags WHERE media_id = ? AND kind = 'ocr'", (media_id,))
    if text:
        conn.execute(
            "INSERT INTO tags(media_id, kind, label, confidence, model) VALUES (?, 'ocr', ?, 1.0, ?)",
            (media_id, text, model),
        )


def _replace_embedding(conn, media_id: int, vec, model: str) -> None:
    conn.execute("DELETE FROM tags WHERE media_id = ? AND kind = 'embedding'", (media_id,))
    if vec:
        conn.execute(
            "INSERT INTO tags(media_id, kind, label, confidence, model) "
            "VALUES (?, 'embedding', ?, 1.0, ?)",
            (media_id, json.dumps(vec), model),
        )


def _needed(row, models: dict) -> list[str]:
    """Services whose active model hasn't produced this row's results yet."""
    return [
        svc for svc, col in _SERVICE_COLUMNS.items()
        if models[svc] is not None and row[col] != models[svc]
    ]


def _process_one(conn, row, models: dict) -> None:
    ai = get_ai()
    media_id, path, kind = row["id"], Path(row["path"]), row["kind"]
    needed = _needed(row, models)
    if not path.exists():
        raise FileNotFoundError("Original file not found")

    if kind == "video":
        from .media_utils import extract_video_frames

        frames = extract_video_frames(path)
        try:
            if frames:
                if "faces" in needed:
                    found = []
                    for frame in frames:
                        try:
                            found.extend(ai.faces.detect(frame))
                        except Exception:
                            pass
                    _replace_faces(conn, media_id,
                                   _dedupe_faces(found, ai.face_match_threshold), ai, models["faces"])
                mid = frames[len(frames) // 2]
                if "tags" in needed:
                    _replace_tags(conn, media_id, ai.tagging.tag(mid), models["tags"])
                if "embed" in needed:
                    _replace_embedding(conn, media_id, ai.embeddings.embed_image(mid), models["embed"])
            # OCR on video frames is not attempted (too noisy to be useful).
        finally:
            if frames:
                shutil.rmtree(frames[0].parent, ignore_errors=True)
    else:
        if "faces" in needed:
            _replace_faces(conn, media_id, ai.faces.detect(path), ai, models["faces"])
        if "tags" in needed:
            _replace_tags(conn, media_id, ai.tagging.tag(path), models["tags"])
        if "ocr" in needed:
            _replace_ocr(conn, media_id, ai.ocr.read_text(path), models["ocr"])
        if "embed" in needed:
            _replace_embedding(conn, media_id, ai.embeddings.embed_image(path), models["embed"])

    sets = ", ".join(f"{_SERVICE_COLUMNS[s]} = ?" for s in needed)
    conn.execute(
        f"UPDATE media SET {sets + ', ' if sets else ''}ai_processed = 1, ai_error = NULL "
        "WHERE id = ?",
        (*[models[s] for s in needed], media_id),
    )


def _pending_sql(models: dict) -> tuple[str, list]:
    """WHERE clause + params selecting media that need any active service."""
    from .media_utils import ffmpeg_path

    conds, params = [], []
    for svc, col in _SERVICE_COLUMNS.items():
        if models[svc] is not None:
            conds.append(f"{col} IS NOT ?")
            params.append(models[svc])
    if not conds:
        return "0", []
    where = f"is_missing = 0 AND ai_error IS NULL AND ({' OR '.join(conds)})"
    if not ffmpeg_path():
        where += " AND kind = 'image'"  # videos stay queued until ffmpeg exists
    return where, params


def pending_count() -> int:
    where, params = _pending_sql(get_ai().models())
    return get_conn().execute(f"SELECT COUNT(*) FROM media WHERE {where}", params).fetchone()[0]


def _next_batch(conn, models: dict, exclude: set[int]) -> list:
    where, params = _pending_sql(models)
    rows = conn.execute(
        f"""SELECT id, path, kind, faces_model, tags_model, ocr_model, embed_model
            FROM media WHERE {where} ORDER BY id LIMIT ?""",
        (*params, BATCH + len(exclude)),
    ).fetchall()
    return [r for r in rows if r["id"] not in exclude][:BATCH]


def _worker() -> None:
    conn = get_conn()
    models = get_ai().models()
    attempted: set[int] = set()
    STATUS.update(
        running=True, processed=0, total=pending_count(), failed=0,
        paused=False, cancelling=False, current=None, finished_at=None,
    )
    _index.reset()  # fresh centroids each run (people may have been edited)
    try:
        while not _cancel.is_set():
            batch = _next_batch(conn, models, attempted)
            if not batch:
                break
            for row in batch:
                if _cancel.is_set():
                    break
                # Honor a pause request without burning CPU.
                while _pause.is_set() and not _cancel.is_set():
                    STATUS["paused"] = True
                    _cancel.wait(0.3)
                STATUS["paused"] = False
                if _cancel.is_set():
                    break

                attempted.add(row["id"])
                STATUS["current"] = row["path"]
                try:
                    with transaction() as tconn:
                        _process_one(tconn, row, models)
                except Exception as e:  # record the failure so it can be retried
                    STATUS["failed"] += 1
                    # The rollback discarded this item's faces; resync centroids.
                    _index.reset()
                    try:
                        with transaction() as econn:
                            econn.execute(
                                "UPDATE media SET ai_error = ? WHERE id = ?",
                                (f"{type(e).__name__}: {e}"[:500], row["id"]),
                            )
                    except Exception:
                        pass
                STATUS["processed"] += 1
            # Items added meanwhile (watcher, rescans, retry) extend the total.
            STATUS["total"] = max(STATUS["total"], STATUS["processed"] + pending_count())
    finally:
        STATUS.update(
            running=False, paused=False, cancelling=False, current=None,
            finished_at=datetime.now().isoformat(),
        )
        _cancel.clear()
        _pause.clear()


def start_processing() -> bool:
    global _thread
    if not _lock.acquire(blocking=False):
        return False
    if STATUS["running"]:
        _lock.release()
        return False
    if not any(get_ai().models().values()):
        _lock.release()
        return False  # no model active: nothing to do
    # Never start a run already paused/cancelled by a stale request.
    _cancel.clear()
    _pause.clear()
    STATUS["running"] = True

    def _run():
        try:
            _worker()
        finally:
            _lock.release()

    _thread = threading.Thread(target=_run, daemon=True, name="memora-ai")
    _thread.start()
    return True


def wait(timeout: Optional[float] = None) -> bool:
    t = _thread
    if t is not None:
        t.join(timeout)
        return not t.is_alive()
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
    with transaction() as conn:
        n = conn.execute(
            "UPDATE media SET ai_error = NULL WHERE ai_error IS NOT NULL"
        ).rowcount
    if n:
        start_processing()
    return n


# ------------------------------------------------------- stub cleanup ------

def stub_result_counts() -> dict:
    conn = get_conn()
    return {
        "tags": conn.execute(
            "SELECT COUNT(*) FROM tags WHERE model LIKE 'stub/%'").fetchone()[0],
        "faces": conn.execute(
            "SELECT COUNT(*) FROM faces WHERE model LIKE 'stub/%'").fetchone()[0],
    }


def purge_stub_results() -> dict:
    """Delete every result produced by the placeholder stub models.

    Manual tags, favorites, albums and real-model results are untouched.
    People left without any face are removed (their faces were fabricated).
    """
    if STATUS["running"]:
        raise RuntimeError("Stop AI processing before removing placeholder results")
    with transaction() as conn:
        tags = conn.execute("DELETE FROM tags WHERE model LIKE 'stub/%'").rowcount
        faces = conn.execute("DELETE FROM faces WHERE model LIKE 'stub/%'").rowcount
        people = conn.execute(
            PRUNE_EMPTY_PEOPLE_SQL
        ).rowcount
        for col in _SERVICE_COLUMNS.values():
            conn.execute(f"UPDATE media SET {col} = NULL WHERE {col} LIKE 'stub/%'")
        conn.execute(
            "UPDATE media SET ai_processed = 0 WHERE faces_model IS NULL AND tags_model IS NULL "
            "AND ocr_model IS NULL AND embed_model IS NULL"
        )
    invalidate_person_index()
    return {"tags": tags, "faces": faces, "people": people}
