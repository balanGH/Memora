"""Read/write queries backing the API routes."""
from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Literal, Optional

from .ai import get_ai
from .ai.interfaces import cosine_similarity
from .db import get_conn, transaction

SortKey = Literal["newest", "oldest", "favorites", "added"]

_SORT_SQL = {
    "newest": "taken_at DESC, id DESC",
    "oldest": "taken_at ASC, id ASC",
    "favorites": "is_favorite DESC, taken_at DESC",
    "added": "created_at DESC, id DESC",
}

# Which library "bucket" a media row belongs to.
_VIEW_FILTER = {
    "photos": "is_trashed = 0 AND is_archived = 0 AND is_hidden = 0",
    "favorites": "is_trashed = 0 AND is_hidden = 0 AND is_favorite = 1",
    "archive": "is_trashed = 0 AND is_archived = 1",
    "hidden": "is_trashed = 0 AND is_hidden = 1",
    "trash": "is_trashed = 1",
}


def _media_dict(row) -> dict:
    d = dict(row)
    for flag in ("is_favorite", "is_archived", "is_hidden", "is_trashed", "ai_processed"):
        if flag in d:
            d[flag] = bool(d[flag])
    return d


def list_media(
    view: str = "photos",
    sort: SortKey = "newest",
    limit: int = 200,
    offset: int = 0,
) -> dict:
    conn = get_conn()
    where = _VIEW_FILTER.get(view, _VIEW_FILTER["photos"])
    order = _SORT_SQL.get(sort, _SORT_SQL["newest"])

    total = conn.execute(
        f"SELECT COUNT(*) AS c FROM media WHERE {where}"
    ).fetchone()["c"]

    rows = conn.execute(
        f"""SELECT id, filename, kind, width, height, taken_at, thumb_path,
                   is_favorite, is_archived, is_hidden, gps_lat, gps_lon
            FROM media WHERE {where}
            ORDER BY {order} LIMIT ? OFFSET ?""",
        (limit, offset),
    ).fetchall()

    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "items": [_media_dict(r) for r in rows],
    }


def get_media(media_id: int) -> Optional[dict]:
    conn = get_conn()
    row = conn.execute("SELECT * FROM media WHERE id = ?", (media_id,)).fetchone()
    if not row:
        return None
    d = _media_dict(row)
    d["tags"] = [
        dict(t)
        for t in conn.execute(
            "SELECT kind, label, confidence FROM tags WHERE media_id = ? AND kind != 'embedding'",
            (media_id,),
        ).fetchall()
    ]
    d["people"] = [
        dict(p)
        for p in conn.execute(
            """SELECT DISTINCT p.id, p.name FROM faces f
               JOIN people p ON p.id = f.person_id WHERE f.media_id = ?""",
            (media_id,),
        ).fetchall()
    ]
    return d


def set_flag(media_id: int, flag: str, value: bool) -> bool:
    valid = {"is_favorite", "is_archived", "is_hidden", "is_trashed"}
    if flag not in valid:
        raise ValueError(f"Invalid flag: {flag}")
    with transaction() as conn:
        if flag == "is_trashed":
            conn.execute(
                "UPDATE media SET is_trashed = ?, trashed_at = CASE WHEN ? THEN datetime('now') ELSE NULL END WHERE id = ?",
                (int(value), int(value), media_id),
            )
        else:
            conn.execute(
                f"UPDATE media SET {flag} = ? WHERE id = ?", (int(value), media_id)
            )
    return True


# ---------------------------------------------------------------- People ----

def list_people(include_hidden: bool = False) -> list[dict]:
    conn = get_conn()
    hidden_clause = "" if include_hidden else "WHERE p.is_hidden = 0"
    rows = conn.execute(
        f"""
        SELECT p.id, p.name, p.cover_media_id, p.is_hidden,
               COUNT(DISTINCT f.media_id) AS photo_count,
               m.thumb_path AS cover_thumb
        FROM people p
        JOIN faces f ON f.person_id = p.id
        LEFT JOIN media m ON m.id = p.cover_media_id
        {hidden_clause}
        GROUP BY p.id
        HAVING photo_count > 0
        ORDER BY photo_count DESC
        """
    ).fetchall()
    return [dict(r) for r in rows]


def rename_person(person_id: int, name: Optional[str]) -> bool:
    with transaction() as conn:
        conn.execute("UPDATE people SET name = ? WHERE id = ?", (name, person_id))
    return True


def set_person_hidden(person_id: int, hidden: bool) -> bool:
    with transaction() as conn:
        conn.execute(
            "UPDATE people SET is_hidden = ? WHERE id = ?", (int(hidden), person_id)
        )
    return True


def merge_people(source_id: int, target_id: int) -> bool:
    """Reassign all faces from source person to target, then delete source."""
    if source_id == target_id:
        return False
    with transaction() as conn:
        conn.execute(
            "UPDATE faces SET person_id = ? WHERE person_id = ?", (target_id, source_id)
        )
        conn.execute("DELETE FROM people WHERE id = ?", (source_id,))
    return True


def media_for_person(person_id: int, limit: int = 500) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        """SELECT DISTINCT m.id, m.filename, m.kind, m.width, m.height,
                  m.taken_at, m.thumb_path, m.is_favorite
           FROM media m JOIN faces f ON f.media_id = m.id
           WHERE f.person_id = ? AND m.is_trashed = 0
           ORDER BY m.taken_at DESC LIMIT ?""",
        (person_id, limit),
    ).fetchall()
    return [_media_dict(r) for r in rows]


# ---------------------------------------------------------------- Search ----

def search(query: str, limit: int = 200) -> dict:
    """Blended search: object/scene/OCR tags, people names, and semantic (CLIP).

    Every matching media id gets a score; results are ranked by score.
    """
    conn = get_conn()
    q = query.strip().lower()
    if not q:
        return {"query": query, "items": []}

    scores: dict[int, float] = {}

    def bump(mid: int, amount: float):
        scores[mid] = scores.get(mid, 0.0) + amount

    # 1. Tag matches (object / scene / pet / ocr)
    for row in conn.execute(
        """SELECT media_id, kind, label, confidence FROM tags
           WHERE kind != 'embedding' AND LOWER(label) LIKE ?""",
        (f"%{q}%",),
    ).fetchall():
        weight = 2.0 if row["kind"] in ("object", "pet") else 1.5
        bump(row["media_id"], weight * (row["confidence"] or 0.5))

    # 2. Person-name matches
    for row in conn.execute(
        """SELECT f.media_id FROM faces f JOIN people p ON p.id = f.person_id
           WHERE p.name IS NOT NULL AND LOWER(p.name) LIKE ?""",
        (f"%{q}%",),
    ).fetchall():
        bump(row["media_id"], 3.0)

    # 3. Semantic similarity via CLIP-style embedding
    query_vec = get_ai().embeddings.embed_text(q)
    for row in conn.execute(
        "SELECT media_id, label FROM tags WHERE kind = 'embedding'"
    ).fetchall():
        try:
            vec = json.loads(row["label"])
        except (json.JSONDecodeError, TypeError):
            continue
        sim = cosine_similarity(query_vec, vec)
        if sim > 0.15:
            bump(row["media_id"], sim)

    if not scores:
        return {"query": query, "items": []}

    top_ids = sorted(scores, key=lambda k: scores[k], reverse=True)[:limit]
    placeholders = ",".join("?" * len(top_ids))
    rows = conn.execute(
        f"""SELECT id, filename, kind, width, height, taken_at, thumb_path, is_favorite
            FROM media WHERE id IN ({placeholders}) AND is_trashed = 0""",
        top_ids,
    ).fetchall()
    by_id = {r["id"]: _media_dict(r) for r in rows}
    items = [
        {**by_id[i], "score": round(scores[i], 3)} for i in top_ids if i in by_id
    ]
    return {"query": query, "items": items}


def similar_media(media_id: int, limit: int = 60) -> list[dict]:
    """Find visually similar media via CLIP embedding cosine similarity."""
    conn = get_conn()
    base = conn.execute(
        "SELECT label FROM tags WHERE media_id = ? AND kind = 'embedding'",
        (media_id,),
    ).fetchone()
    if not base:
        return []
    try:
        base_vec = json.loads(base["label"])
    except (json.JSONDecodeError, TypeError):
        return []

    scored: list[tuple[int, float]] = []
    for row in conn.execute(
        "SELECT media_id, label FROM tags WHERE kind = 'embedding' AND media_id != ?",
        (media_id,),
    ).fetchall():
        try:
            vec = json.loads(row["label"])
        except (json.JSONDecodeError, TypeError):
            continue
        scored.append((row["media_id"], cosine_similarity(base_vec, vec)))

    scored.sort(key=lambda t: t[1], reverse=True)
    top = [mid for mid, _ in scored[:limit]]
    if not top:
        return []
    placeholders = ",".join("?" * len(top))
    rows = conn.execute(
        f"""SELECT id, filename, kind, width, height, taken_at, thumb_path, is_favorite
            FROM media WHERE id IN ({placeholders}) AND is_trashed = 0""",
        top,
    ).fetchall()
    return [_media_dict(r) for r in rows]


# ---------------------------------------------------------------- Albums ----

def list_albums() -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        """SELECT a.id, a.name, a.is_smart, a.cover_media_id, a.created_at,
                  m.thumb_path AS cover_thumb,
                  (SELECT COUNT(*) FROM album_media am WHERE am.album_id = a.id) AS count
           FROM albums a LEFT JOIN media m ON m.id = a.cover_media_id
           ORDER BY a.created_at DESC"""
    ).fetchall()
    return [dict(r) for r in rows]


def create_album(name: str) -> int:
    with transaction() as conn:
        cur = conn.execute("INSERT INTO albums(name) VALUES (?)", (name,))
        return cur.lastrowid


def add_to_album(album_id: int, media_ids: list[int]) -> int:
    with transaction() as conn:
        added = 0
        for mid in media_ids:
            cur = conn.execute(
                "INSERT OR IGNORE INTO album_media(album_id, media_id) VALUES (?, ?)",
                (album_id, mid),
            )
            added += cur.rowcount
            conn.execute(
                "UPDATE albums SET cover_media_id = COALESCE(cover_media_id, ?) WHERE id = ?",
                (mid, album_id),
            )
        return added


def album_media(album_id: int) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        """SELECT m.id, m.filename, m.kind, m.width, m.height, m.taken_at,
                  m.thumb_path, m.is_favorite
           FROM album_media am JOIN media m ON m.id = am.media_id
           WHERE am.album_id = ? AND m.is_trashed = 0
           ORDER BY m.taken_at DESC""",
        (album_id,),
    ).fetchall()
    return [_media_dict(r) for r in rows]


# ---------------------------------------------------------------- Places ----

# Grid size in degrees for grouping geotagged photos into "places" (~11 km).
_PLACE_PRECISION = 1


def _place_key(lat: float, lon: float) -> str:
    return f"{round(lat, _PLACE_PRECISION)}_{round(lon, _PLACE_PRECISION)}"


def list_places() -> list[dict]:
    """Cluster geotagged media into places on a coarse lat/lon grid."""
    conn = get_conn()
    rows = conn.execute(
        """SELECT id, thumb_path, gps_lat, gps_lon, taken_at
           FROM media
           WHERE gps_lat IS NOT NULL AND gps_lon IS NOT NULL AND is_trashed = 0
           ORDER BY taken_at DESC"""
    ).fetchall()

    clusters: dict[str, dict] = {}
    for r in rows:
        key = _place_key(r["gps_lat"], r["gps_lon"])
        c = clusters.get(key)
        if c is None:
            clusters[key] = {
                "key": key,
                "lat": r["gps_lat"],
                "lon": r["gps_lon"],
                "count": 1,
                "cover_id": r["id"],
                "latest": r["taken_at"],
            }
        else:
            c["count"] += 1
    return sorted(clusters.values(), key=lambda c: c["count"], reverse=True)


def media_for_place(key: str, limit: int = 500) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        """SELECT id, filename, kind, width, height, taken_at, thumb_path,
                  is_favorite, gps_lat, gps_lon
           FROM media
           WHERE gps_lat IS NOT NULL AND gps_lon IS NOT NULL AND is_trashed = 0
           ORDER BY taken_at DESC"""
    ).fetchall()
    matched = [
        _media_dict(r)
        for r in rows
        if _place_key(r["gps_lat"], r["gps_lon"]) == key
    ]
    return matched[:limit]


# ---------------------------------------------------------------- Export ----

def export_person(person_id: int, dest: str) -> dict:
    """Copy all of a person's photos to ``dest``, mirroring their original
    folder structure relative to each photo's library root.

    Example: a library folder ``.../all_photos`` containing
    ``Events/college/IndustrialVisit/x.jpg`` and ``Events/college/Symposium/y.jpg``
    both featuring the same person exports to::

        dest/Events/college/IndustrialVisit/x.jpg
        dest/Events/college/Symposium/y.jpg

    so the person's appearances are preserved under each event folder.
    """
    conn = get_conn()
    dest_root = Path(dest).expanduser()
    if not dest_root.exists():
        dest_root.mkdir(parents=True, exist_ok=True)

    rows = conn.execute(
        """SELECT DISTINCT m.path AS path, fo.path AS root
           FROM media m
           JOIN faces f ON f.media_id = m.id
           LEFT JOIN folders fo ON fo.id = m.folder_id
           WHERE f.person_id = ? AND m.is_trashed = 0""",
        (person_id,),
    ).fetchall()

    exported, skipped = 0, 0
    for r in rows:
        src = Path(r["path"])
        if not src.exists():
            skipped += 1
            continue
        # Path relative to the library root preserves the event subfolders.
        try:
            rel = src.relative_to(Path(r["root"])) if r["root"] else Path(src.name)
        except ValueError:
            rel = Path(src.name)
        target = dest_root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copy2(src, target)
            exported += 1
        except Exception:
            skipped += 1

    return {"exported": exported, "skipped": skipped, "dest": str(dest_root)}


def library_stats() -> dict:
    conn = get_conn()
    row = conn.execute(
        """SELECT
             COUNT(*) AS total,
             SUM(CASE WHEN is_favorite = 1 AND is_trashed = 0 THEN 1 ELSE 0 END) AS favorites,
             SUM(CASE WHEN is_archived = 1 AND is_trashed = 0 THEN 1 ELSE 0 END) AS archived,
             SUM(CASE WHEN is_hidden = 1 AND is_trashed = 0 THEN 1 ELSE 0 END) AS hidden,
             SUM(CASE WHEN is_trashed = 1 THEN 1 ELSE 0 END) AS trashed
           FROM media"""
    ).fetchone()
    people = conn.execute(
        "SELECT COUNT(*) AS c FROM (SELECT DISTINCT person_id FROM faces WHERE person_id IS NOT NULL)"
    ).fetchone()["c"]
    return {**{k: (row[k] or 0) for k in row.keys()}, "people": people}
