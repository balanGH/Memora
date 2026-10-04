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
            "SELECT id, kind, label, confidence FROM tags WHERE media_id = ? AND kind != 'embedding'",
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


def add_tag(media_id: int, label: str, kind: str = "user") -> Optional[dict]:
    """Add a manual tag to a photo, ignoring blank or exact-duplicate labels.

    Returns the new tag row, or the existing one if the same label is already
    present (case-insensitive), so the UI can render it without a reload.
    """
    label = label.strip()
    if not label:
        raise ValueError("Empty tag")
    with transaction() as conn:
        existing = conn.execute(
            "SELECT id, kind, label, confidence FROM tags "
            "WHERE media_id = ? AND kind != 'embedding' AND lower(label) = lower(?)",
            (media_id, label),
        ).fetchone()
        if existing:
            return dict(existing)
        cur = conn.execute(
            "INSERT INTO tags (media_id, kind, label, confidence) VALUES (?, ?, ?, ?)",
            (media_id, kind, label, 1.0),
        )
        return {"id": cur.lastrowid, "kind": kind, "label": label, "confidence": 1.0}


def delete_tag(media_id: int, tag_id: int) -> bool:
    """Remove a single tag from a photo. Never touches embedding rows."""
    with transaction() as conn:
        cur = conn.execute(
            "DELETE FROM tags WHERE id = ? AND media_id = ? AND kind != 'embedding'",
            (tag_id, media_id),
        )
    return cur.rowcount > 0


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


_FLAGS = {"is_favorite", "is_archived", "is_hidden", "is_trashed"}


def set_flag_bulk(media_ids: list[int], flag: str, value: bool) -> int:
    """Set one flag on many media rows at once. Returns rows changed."""
    if flag not in _FLAGS:
        raise ValueError(f"Invalid flag: {flag}")
    if not media_ids:
        return 0
    placeholders = ",".join("?" * len(media_ids))
    with transaction() as conn:
        if flag == "is_trashed":
            cur = conn.execute(
                f"""UPDATE media SET is_trashed = ?,
                        trashed_at = CASE WHEN ? THEN datetime('now') ELSE NULL END
                    WHERE id IN ({placeholders})""",
                (int(value), int(value), *media_ids),
            )
        else:
            cur = conn.execute(
                f"UPDATE media SET {flag} = ? WHERE id IN ({placeholders})",
                (int(value), *media_ids),
            )
    return cur.rowcount


def restore_all_trash() -> int:
    with transaction() as conn:
        cur = conn.execute(
            "UPDATE media SET is_trashed = 0, trashed_at = NULL WHERE is_trashed = 1"
        )
    return cur.rowcount


def empty_trash() -> int:
    """Remove trashed items from the library. Original files are NOT deleted.

    Their paths go into ``excluded_paths`` so a rescan won't bring them back,
    and cached thumbnails / display renditions are cleaned up.
    """
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, path, thumb_path FROM media WHERE is_trashed = 1"
    ).fetchall()
    if not rows:
        return 0
    from .media_utils import display_filename
    from .config import DISPLAY_DIR

    with transaction() as tx:
        tx.executemany(
            "INSERT OR IGNORE INTO excluded_paths(path) VALUES (?)",
            [(r["path"],) for r in rows],
        )
        tx.execute("DELETE FROM media WHERE is_trashed = 1")
        tx.execute(
            "DELETE FROM people WHERE id NOT IN "
            "(SELECT DISTINCT person_id FROM faces WHERE person_id IS NOT NULL)"
        )
    for r in rows:
        for cached in (r["thumb_path"], str(DISPLAY_DIR / display_filename(Path(r["path"])))):
            if cached:
                try:
                    Path(cached).unlink(missing_ok=True)
                except OSError:
                    pass
    from .ai_pipeline import invalidate_person_index

    invalidate_person_index()
    return len(rows)


def duplicate_groups(limit: int = 500) -> list[dict]:
    """Exact duplicates (same file bytes) among non-trashed media."""
    conn = get_conn()
    rows = conn.execute(
        """SELECT id, filename, kind, width, height, taken_at, thumb_path,
                  is_favorite, path, size_bytes, file_hash
           FROM media
           WHERE is_trashed = 0 AND file_hash IN (
               SELECT file_hash FROM media
               WHERE file_hash IS NOT NULL AND is_trashed = 0
               GROUP BY file_hash HAVING COUNT(*) > 1
           )
           ORDER BY file_hash, is_favorite DESC, taken_at ASC, id ASC"""
    ).fetchall()
    groups: dict[str, list[dict]] = {}
    for r in rows:
        groups.setdefault(r["file_hash"], []).append(_media_dict(r))
    out = [{"hash": h, "items": items} for h, items in groups.items()]
    out.sort(key=lambda g: (g["items"][0].get("size_bytes") or 0), reverse=True)
    return out[:limit]


def timeline(view: str = "photos", sort: str = "newest") -> list[dict]:
    """Month buckets in list order, each with the offset of its first item.

    Lets the UI jump to any month: load pages up to ``offset`` then scroll.
    Matches ``list_media`` ordering for the 'newest' and 'oldest' sorts.
    """
    conn = get_conn()
    where = _VIEW_FILTER.get(view, _VIEW_FILTER["photos"])
    order = "ASC" if sort == "oldest" else "DESC"
    rows = conn.execute(
        f"""SELECT substr(taken_at, 1, 7) AS month, COUNT(*) AS count
            FROM media WHERE {where}
            GROUP BY month
            ORDER BY month {order}"""
    ).fetchall()
    out: list[dict] = []
    offset = 0
    for r in rows:
        out.append({"month": r["month"], "count": r["count"], "offset": offset})
        offset += r["count"]
    return out


def search_suggestions(query: str, limit: int = 6) -> dict:
    """Quick matches for the search box: people names and tag labels."""
    q = query.strip().lower()
    if not q:
        return {"people": [], "tags": []}
    like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    conn = get_conn()
    people = [
        dict(r)
        for r in conn.execute(
            """SELECT p.id, p.name, COUNT(DISTINCT f.media_id) AS count
               FROM people p JOIN faces f ON f.person_id = p.id
               WHERE p.is_hidden = 0 AND p.name IS NOT NULL
                 AND LOWER(p.name) LIKE ? ESCAPE '\\'
               GROUP BY p.id ORDER BY count DESC LIMIT ?""",
            (like, limit),
        ).fetchall()
    ]
    tags = [
        dict(r)
        for r in conn.execute(
            """SELECT LOWER(label) AS label, COUNT(DISTINCT media_id) AS count
               FROM tags
               WHERE kind IN ('object', 'scene', 'pet', 'user')
                 AND LOWER(label) LIKE ? ESCAPE '\\'
               GROUP BY LOWER(label) ORDER BY count DESC LIMIT ?""",
            (like, limit),
        ).fetchall()
    ]
    return {"people": people, "tags": tags}


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


def set_person_cover(person_id: int, media_id: int) -> bool:
    """Pick which photo supplies the person's avatar face crop.

    Only succeeds if the person actually has a detected face in that photo, so
    the crop endpoint always has a bbox to work with.
    """
    with transaction() as conn:
        has_face = conn.execute(
            "SELECT 1 FROM faces WHERE person_id = ? AND media_id = ? LIMIT 1",
            (person_id, media_id),
        ).fetchone()
        if not has_face:
            return False
        conn.execute(
            "UPDATE people SET cover_media_id = ? WHERE id = ?", (media_id, person_id)
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
        # Re-point the source's relationships at the target instead of letting
        # ON DELETE CASCADE silently drop them. Skip links that would become
        # self-links or duplicate a link the target already has.
        for rel in conn.execute(
            "SELECT id, person_a, person_b, label, directed FROM relationships "
            "WHERE person_a = ? OR person_b = ?",
            (source_id, source_id),
        ).fetchall():
            a = target_id if rel["person_a"] == source_id else rel["person_a"]
            b = target_id if rel["person_b"] == source_id else rel["person_b"]
            if a == b:
                continue
            if not rel["directed"] and a > b:
                a, b = b, a
            dup = conn.execute(
                "SELECT 1 FROM relationships WHERE (person_a = ? AND person_b = ?) "
                "OR (person_a = ? AND person_b = ?)",
                (a, b, b, a),
            ).fetchone()
            if not dup:
                conn.execute(
                    "UPDATE relationships SET person_a = ?, person_b = ? WHERE id = ?",
                    (a, b, rel["id"]),
                )
        conn.execute(
            """UPDATE people SET cover_media_id = (
                   SELECT cover_media_id FROM people WHERE id = ?)
               WHERE id = ? AND cover_media_id IS NULL""",
            (source_id, target_id),
        )
        conn.execute("DELETE FROM people WHERE id = ?", (source_id,))
    from .ai_pipeline import invalidate_person_index

    invalidate_person_index()
    return True


def split_person(person_id: int, media_ids: list[int]) -> Optional[int]:
    """Move this person's faces in the given photos to a brand-new person.

    Used to correct a cluster that wrongly groups different people: select the
    photos that don't belong and they become a separate person. Returns the new
    person id, or None if nothing moved.
    """
    if not media_ids:
        return None
    with transaction() as conn:
        new_id = conn.execute("INSERT INTO people (name) VALUES (NULL)").lastrowid
        placeholders = ",".join("?" * len(media_ids))
        moved = conn.execute(
            f"""UPDATE faces SET person_id = ?
                WHERE person_id = ? AND media_id IN ({placeholders})""",
            (new_id, person_id, *media_ids),
        ).rowcount
        if moved == 0:
            conn.execute("DELETE FROM people WHERE id = ?", (new_id,))
            return None
        # If the source's chosen cover moved out, clear it (crop falls back to
        # the largest remaining face).
        conn.execute(
            f"""UPDATE people SET cover_media_id = NULL
                WHERE id = ? AND cover_media_id IN ({placeholders})""",
            (person_id, *media_ids),
        )
        conn.execute(
            "UPDATE people SET cover_media_id = ? WHERE id = ?",
            (media_ids[0], new_id),
        )
    from .ai_pipeline import invalidate_person_index

    invalidate_person_index()
    return new_id


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

def search(query: str, limit: int = 200, person_id: Optional[int] = None) -> dict:
    """Blended search: object/scene/OCR tags, people names, and semantic (CLIP).

    Every matching media id gets a score; results are ranked by score.
    """
    conn = get_conn()
    q = query.strip().lower()
    if not q:
        return {"query": query, "items": []}

    scores: dict[int, float] = {}
    like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"

    def bump(mid: int, amount: float):
        scores[mid] = scores.get(mid, 0.0) + amount

    # 1. Tag matches (object / scene / pet / ocr)
    for row in conn.execute(
        """SELECT media_id, kind, label, confidence FROM tags
           WHERE kind != 'embedding' AND LOWER(label) LIKE ? ESCAPE '\\'""",
        (like,),
    ).fetchall():
        weight = 2.0 if row["kind"] in ("object", "pet") else 1.5
        bump(row["media_id"], weight * (row["confidence"] or 0.5))

    # 2. Person-name matches
    for row in conn.execute(
        """SELECT f.media_id FROM faces f JOIN people p ON p.id = f.person_id
           WHERE p.name IS NOT NULL AND LOWER(p.name) LIKE ? ESCAPE '\\'""",
        (like,),
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

    if person_id is not None:
        with_person = {
            r["media_id"]
            for r in conn.execute(
                "SELECT DISTINCT media_id FROM faces WHERE person_id = ?", (person_id,)
            ).fetchall()
        }
        scores = {k: v for k, v in scores.items() if k in with_person}
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
    # SQL IN () returns rows in arbitrary order; restore most-similar-first.
    by_id = {r["id"]: _media_dict(r) for r in rows}
    return [by_id[mid] for mid in top if mid in by_id]


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


def geotagged_media(limit: int = 5000, sort: str = "newest") -> list[dict]:
    """All geotagged photos — the timeline that drives the map.

    ``sort`` is 'newest' (latest photo leads the filmstrip) or 'oldest'
    (chronological). Anything else falls back to newest.
    """
    order = "ASC, id ASC" if sort == "oldest" else "DESC, id DESC"
    conn = get_conn()
    rows = conn.execute(
        f"""SELECT id, filename, kind, width, height, taken_at, thumb_path,
                  is_favorite, gps_lat, gps_lon
           FROM media
           WHERE gps_lat IS NOT NULL AND gps_lon IS NOT NULL AND is_trashed = 0
           ORDER BY taken_at {order}
           LIMIT ?""",
        (limit,),
    ).fetchall()
    return [_media_dict(r) for r in rows]


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


# ------------------------------------------------------------- Relations ----

def add_relation(
    person_a: int, person_b: int, label: str = "", directed: bool = False
) -> dict:
    """Create/update a labeled link between two people.

    Directed links (parent->child) keep the given a->b order; undirected links
    (spouse, friend…) are stored with person_a < person_b so each pair is unique
    regardless of which side the user picked first.
    """
    if person_a == person_b:
        raise ValueError("A person can't be related to themselves")
    if directed:
        a, b = person_a, person_b
    else:
        a, b = (person_a, person_b) if person_a < person_b else (person_b, person_a)
    label = label.strip()
    with transaction() as conn:
        # A pair is unique in either order — replace an existing reverse row too.
        conn.execute(
            "DELETE FROM relationships WHERE (person_a = ? AND person_b = ?) "
            "OR (person_a = ? AND person_b = ?)",
            (a, b, b, a),
        )
        cur = conn.execute(
            "INSERT INTO relationships (person_a, person_b, label, directed) "
            "VALUES (?, ?, ?, ?)",
            (a, b, label, int(directed)),
        )
        rid = cur.lastrowid
        row = conn.execute(
            "SELECT id, person_a, person_b, label, directed FROM relationships WHERE id = ?",
            (rid,),
        ).fetchone()
    return dict(row)


def delete_relation(rel_id: int) -> bool:
    with transaction() as conn:
        cur = conn.execute("DELETE FROM relationships WHERE id = ?", (rel_id,))
    return cur.rowcount > 0


def relation_graph() -> dict:
    """Nodes (people involved in any relationship) + edges for the graph view."""
    conn = get_conn()
    edges = [
        dict(e)
        for e in conn.execute(
            "SELECT id, person_a, person_b, label, directed FROM relationships"
        ).fetchall()
    ]
    ids: set[int] = set()
    for e in edges:
        ids.add(e["person_a"])
        ids.add(e["person_b"])
    nodes: list[dict] = []
    if ids:
        placeholders = ",".join("?" * len(ids))
        nodes = [
            dict(r)
            for r in conn.execute(
                f"""SELECT p.id, p.name, p.cover_media_id,
                          COUNT(DISTINCT f.media_id) AS photo_count
                   FROM people p LEFT JOIN faces f ON f.person_id = p.id
                   WHERE p.id IN ({placeholders})
                   GROUP BY p.id""",
                tuple(ids),
            ).fetchall()
        ]
    return {"nodes": nodes, "edges": edges}


def auto_connect(min_shared: int = 2, label: str = "appears with") -> int:
    """Auto-create undirected links for people who appear together in at least
    ``min_shared`` photos and aren't already related. Returns the count created.

    Only who-is-connected is inferred (photos can't reveal the relationship
    type), so the links get a generic label the user can rename afterwards.
    """
    conn = get_conn()
    existing: set[tuple[int, int]] = set()
    for r in conn.execute("SELECT person_a, person_b FROM relationships").fetchall():
        existing.add((r["person_a"], r["person_b"]))
        existing.add((r["person_b"], r["person_a"]))

    pairs = conn.execute(
        """SELECT f1.person_id AS a, f2.person_id AS b,
                  COUNT(DISTINCT f1.media_id) AS shared
           FROM faces f1
           JOIN faces f2
             ON f1.media_id = f2.media_id AND f1.person_id < f2.person_id
           WHERE f1.person_id IS NOT NULL AND f2.person_id IS NOT NULL
           GROUP BY f1.person_id, f2.person_id
           HAVING shared >= ?""",
        (max(1, min_shared),),
    ).fetchall()

    created = 0
    with transaction() as tx:
        for r in pairs:
            if (r["a"], r["b"]) in existing:
                continue
            cur = tx.execute(
                "INSERT OR IGNORE INTO relationships (person_a, person_b, label, directed) "
                "VALUES (?, ?, ?, 0)",
                (r["a"], r["b"], label),
            )
            created += cur.rowcount
    return created


def family_suggestions(min_gap: float = 15.0, min_shared: int = 1, limit: int = 12) -> list[dict]:
    """Heuristic parent->child suggestions from estimated ages.

    Requires the real (InsightFace) backend, which fills faces.age. For each pair
    that appears together, if their median ages differ by at least ``min_gap``
    years we suggest the older as parent of the younger. It's a hint to confirm,
    never a certainty — returns [] when there's no age data (stub backend).
    """
    conn = get_conn()
    rows = conn.execute(
        "SELECT person_id, age, gender FROM faces "
        "WHERE person_id IS NOT NULL AND age IS NOT NULL"
    ).fetchall()
    if not rows:
        return []

    ages: dict[int, list[float]] = {}
    genders: dict[int, list[str]] = {}
    for r in rows:
        ages.setdefault(r["person_id"], []).append(r["age"])
        if r["gender"]:
            genders.setdefault(r["person_id"], []).append(r["gender"])

    def median(xs: list[float]) -> float:
        xs = sorted(xs)
        n = len(xs)
        return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2

    med_age = {pid: median(v) for pid, v in ages.items()}
    dom_gender = {
        pid: max(set(g), key=g.count) for pid, g in genders.items() if g
    }

    existing: set[tuple[int, int]] = set()
    for r in conn.execute("SELECT person_a, person_b FROM relationships").fetchall():
        existing.add((r["person_a"], r["person_b"]))
        existing.add((r["person_b"], r["person_a"]))

    pairs = conn.execute(
        """SELECT f1.person_id AS a, f2.person_id AS b,
                  COUNT(DISTINCT f1.media_id) AS shared
           FROM faces f1
           JOIN faces f2
             ON f1.media_id = f2.media_id AND f1.person_id < f2.person_id
           WHERE f1.person_id IS NOT NULL AND f2.person_id IS NOT NULL
           GROUP BY f1.person_id, f2.person_id
           HAVING shared >= ?""",
        (max(1, min_shared),),
    ).fetchall()

    out: list[dict] = []
    for r in pairs:
        a, b = r["a"], r["b"]
        if (a, b) in existing or a not in med_age or b not in med_age:
            continue
        gap = abs(med_age[a] - med_age[b])
        if gap < min_gap:
            continue
        parent, child = (a, b) if med_age[a] > med_age[b] else (b, a)
        out.append(
            {
                "parent": parent,
                "child": child,
                "parent_age": round(med_age[parent]),
                "child_age": round(med_age[child]),
                "gap": round(gap),
                "shared": r["shared"],
                "parent_gender": dom_gender.get(parent),
            }
        )

    out.sort(key=lambda s: (s["shared"], s["gap"]), reverse=True)
    out = out[:limit]

    ids: set[int] = set()
    for s in out:
        ids.add(s["parent"])
        ids.add(s["child"])
    names: dict[int, Optional[str]] = {}
    if ids:
        placeholders = ",".join("?" * len(ids))
        for r in conn.execute(
            f"SELECT id, name FROM people WHERE id IN ({placeholders})", tuple(ids)
        ).fetchall():
            names[r["id"]] = r["name"]
    for s in out:
        s["parent_name"] = names.get(s["parent"])
        s["child_name"] = names.get(s["child"])
    return out


def relation_suggestions(limit: int = 8) -> list[dict]:
    """Suggest links from face co-occurrence: people photographed together most,
    excluding pairs that already have a relationship."""
    conn = get_conn()
    existing: set[tuple[int, int]] = set()
    for r in conn.execute("SELECT person_a, person_b FROM relationships").fetchall():
        existing.add((r["person_a"], r["person_b"]))
        existing.add((r["person_b"], r["person_a"]))

    rows = conn.execute(
        """SELECT f1.person_id AS a, f2.person_id AS b,
                  COUNT(DISTINCT f1.media_id) AS shared
           FROM faces f1
           JOIN faces f2
             ON f1.media_id = f2.media_id AND f1.person_id < f2.person_id
           WHERE f1.person_id IS NOT NULL AND f2.person_id IS NOT NULL
           GROUP BY f1.person_id, f2.person_id
           HAVING shared > 0
           ORDER BY shared DESC
           LIMIT ?""",
        (limit * 4,),
    ).fetchall()

    picked = [
        {"a": r["a"], "b": r["b"], "shared": r["shared"]}
        for r in rows
        if (r["a"], r["b"]) not in existing
    ][:limit]

    ids: set[int] = set()
    for p in picked:
        ids.add(p["a"])
        ids.add(p["b"])
    names: dict[int, Optional[str]] = {}
    if ids:
        placeholders = ",".join("?" * len(ids))
        for r in conn.execute(
            f"SELECT id, name FROM people WHERE id IN ({placeholders})", tuple(ids)
        ).fetchall():
            names[r["id"]] = r["name"]
    for p in picked:
        p["a_name"] = names.get(p["a"])
        p["b_name"] = names.get(p["b"])
    return picked


# ----------------------------------------------------------- Processing ----

def processing_stats() -> dict:
    """Per-stage counts for the Processing Center."""
    conn = get_conn()

    def one(sql: str) -> int:
        return conn.execute(sql).fetchone()[0]

    total = one("SELECT COUNT(*) FROM media WHERE is_trashed = 0")
    images = one("SELECT COUNT(*) FROM media WHERE kind = 'image' AND is_trashed = 0")
    videos = one("SELECT COUNT(*) FROM media WHERE kind = 'video' AND is_trashed = 0")
    dupes = one(
        """SELECT COUNT(*) FROM media WHERE file_hash IN (
               SELECT file_hash FROM media
               WHERE file_hash IS NOT NULL GROUP BY file_hash HAVING COUNT(*) > 1
           )"""
    )
    return {
        "total": total,
        "images": images,
        "videos": videos,
        "thumbnails": one("SELECT COUNT(*) FROM media WHERE thumb_path IS NOT NULL AND is_trashed = 0"),
        "hashed": one("SELECT COUNT(*) FROM media WHERE file_hash IS NOT NULL AND is_trashed = 0"),
        "faces_media": one("SELECT COUNT(DISTINCT media_id) FROM faces"),
        "faces_total": one("SELECT COUNT(*) FROM faces"),
        "ocr": one("SELECT COUNT(DISTINCT media_id) FROM tags WHERE kind = 'ocr'"),
        "embeddings": one("SELECT COUNT(DISTINCT media_id) FROM tags WHERE kind = 'embedding'"),
        "ai_processed": one("SELECT COUNT(*) FROM media WHERE ai_processed = 1"),
        "failed": one("SELECT COUNT(*) FROM media WHERE ai_error IS NOT NULL"),
        "duplicates": dupes,
    }


def failed_media(limit: int = 100) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, filename, ai_error FROM media WHERE ai_error IS NOT NULL LIMIT ?",
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]


# ------------------------------------------------------------- Privacy ------

def privacy_info() -> dict:
    """Local-only status, network activity, and storage locations."""
    from . import tiles
    from .config import DATA_DIR, DB_PATH, DISPLAY_DIR, THUMBNAIL_DIR, TILES_DIR

    def dir_bytes(p: Path) -> int:
        total = 0
        if p.exists():
            for f in p.rglob("*"):
                try:
                    if f.is_file():
                        total += f.stat().st_size
                except OSError:
                    pass
        return total

    from .ai import system_info

    sysinfo = system_info()
    real = sysinfo["active_backend"] == "insightface" or (
        sysinfo["active_backend"] is None
        and sysinfo["insightface_installed"]
        and sysinfo["face_backend_setting"] != "stub"
    )
    device = "GPU" if sysinfo["is_gpu"] else "CPU"
    tile_stats = tiles.cache_stats()

    def file_bytes(p: Path) -> int:
        try:
            return p.stat().st_size if p.exists() else 0
        except OSError:
            return 0

    return {
        "local_ai": True,
        "ai_backend": f"InsightFace (real, {device})" if real else "Stub (deterministic)",
        "compute": sysinfo,
        "uploads_enabled": False,
        "cloud_services": [],
        "network": {
            "tile_requests": tiles.request_count(),
            "tiles_cached": tile_stats["tiles"],
            "tiles_bytes": tile_stats["bytes"],
            "description": "Only outbound traffic is map-tile fetches on a cache miss.",
        },
        "storage": [
            {"name": "Database", "path": str(DB_PATH), "bytes": file_bytes(DB_PATH)},
            {"name": "Thumbnails", "path": str(THUMBNAIL_DIR), "bytes": dir_bytes(THUMBNAIL_DIR)},
            {"name": "Display renditions", "path": str(DISPLAY_DIR), "bytes": dir_bytes(DISPLAY_DIR)},
            {"name": "Map tiles", "path": str(TILES_DIR), "bytes": dir_bytes(TILES_DIR)},
            {"name": "Data directory", "path": str(DATA_DIR), "bytes": dir_bytes(DATA_DIR)},
        ],
    }


# ------------------------------------------------------- Folder watching ----

def set_folder_watch(folder_id: int, watch: bool) -> bool:
    with transaction() as conn:
        conn.execute(
            "UPDATE folders SET watch = ? WHERE id = ?", (int(watch), folder_id)
        )
    return True


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
