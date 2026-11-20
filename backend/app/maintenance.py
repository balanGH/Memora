"""Library maintenance: cache cleanup, integrity check, backups (F02 / F07).

Only Memora's own files (cache directories, database backups) are ever
deleted here. Originals are never touched.
"""
from __future__ import annotations

import os
from pathlib import Path

from . import db
from .config import DISPLAY_DIR, THUMBNAIL_DIR, WEB_SAFE_IMAGE_EXTENSIONS
from .media_utils import display_filename


def _norm(p) -> str:
    return os.path.normcase(os.path.abspath(p))


def cleanup_cache() -> dict:
    """Delete cached thumbnails / display renditions no media row refers to
    (left behind when originals changed, were removed, or by older versions).
    """
    conn = db.get_conn()
    keep_thumbs = {
        _norm(r["thumb_path"])
        for r in conn.execute("SELECT thumb_path FROM media WHERE thumb_path IS NOT NULL")
    }
    keep_display: set[str] = set()
    for r in conn.execute("SELECT path FROM media WHERE kind = 'image'"):
        p = Path(r["path"])
        if p.suffix.lower() not in WEB_SAFE_IMAGE_EXTENSIONS:
            keep_display.add(_norm(DISPLAY_DIR / display_filename(p)))

    removed, freed = 0, 0
    for folder, keep in ((THUMBNAIL_DIR, keep_thumbs), (DISPLAY_DIR, keep_display)):
        if not folder.exists():
            continue
        for f in folder.iterdir():
            if not f.is_file() or _norm(f) in keep:
                continue
            try:
                size = f.stat().st_size
                f.unlink()
                removed += 1
                freed += size
            except OSError:
                pass
    return {"removed": removed, "bytes": freed}


def health_report() -> dict:
    conn = db.get_conn()
    one = lambda sql: conn.execute(sql).fetchone()[0]  # noqa: E731
    return {
        "integrity": db.integrity_report(),
        "missing_files": one("SELECT COUNT(*) FROM media WHERE is_missing = 1"),
        "missing_thumbnails": one(
            "SELECT COUNT(*) FROM media WHERE thumb_path IS NULL AND kind = 'image'"
        ),
        "scan_failures": one("SELECT COUNT(*) FROM scan_failures"),
        "ai_failures": one("SELECT COUNT(*) FROM media WHERE ai_error IS NOT NULL"),
        "backups": db.list_backups(),
    }


def repair() -> dict:
    """Safe, non-destructive repairs (F07):

    * drop dangling references (faces/tags/album entries of deleted media are
      already cascaded; this fixes cover ids that point nowhere),
    * remove people with no faces left,
    * rebuild indexes and checkpoint the WAL.
    """
    before = db.integrity_report()
    db.backup_database("pre-repair")
    with db.transaction() as conn:
        covers_people = conn.execute(
            "UPDATE people SET cover_media_id = NULL WHERE cover_media_id IS NOT NULL "
            "AND cover_media_id NOT IN (SELECT id FROM media)"
        ).rowcount
        covers_albums = conn.execute(
            "UPDATE albums SET cover_media_id = NULL WHERE cover_media_id IS NOT NULL "
            "AND cover_media_id NOT IN (SELECT id FROM media)"
        ).rowcount
        empty_people = conn.execute(
            db.PRUNE_EMPTY_PEOPLE_SQL
        ).rowcount
    conn = db.get_conn()
    conn.execute("REINDEX")
    conn.commit()
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    return {
        "before": before,
        "after": db.integrity_report(),
        "fixed": {
            "dangling_person_covers": covers_people,
            "dangling_album_covers": covers_albums,
            "empty_people_removed": empty_people,
        },
    }
