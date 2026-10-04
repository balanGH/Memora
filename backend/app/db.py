"""SQLite access layer.

Uses the stdlib ``sqlite3`` module (no ORM) to keep the dependency surface
small and startup fast. A single connection is shared per-thread via a simple
helper; SQLite handles concurrency with WAL mode.
"""
from __future__ import annotations

import hashlib
import sqlite3
import threading
from contextlib import contextmanager
from typing import Iterator

from .config import DB_PATH, ensure_dirs

_local = threading.local()


def stable_media_id(path: str) -> int:
    """Deterministic media id derived from the file path.

    Using a hash of the path (instead of an auto-incrementing counter) means the
    same photo always gets the same id — even after the DB is wiped and rebuilt.
    Media bytes are served by id (/api/thumb/{id}), so a stable id prevents a
    rebuilt library from mapping an id to a different file and showing a stale,
    browser-cached thumbnail. 52 bits (13 hex chars) stays within JavaScript's
    safe-integer range (2**53); larger ids would be rounded when the frontend
    parses the JSON, breaking every media URL. Collision chance is negligible
    for a personal library.
    """
    return int(hashlib.sha1(str(path).encode("utf-8")).hexdigest()[:13], 16)


SCHEMA = """
CREATE TABLE IF NOT EXISTS folders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    path        TEXT NOT NULL UNIQUE,
    added_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_scan   TEXT,
    watch       INTEGER NOT NULL DEFAULT 0   -- auto-ingest new files in this folder
);

CREATE TABLE IF NOT EXISTS media (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id       INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    path            TEXT NOT NULL UNIQUE,
    filename        TEXT NOT NULL,
    kind            TEXT NOT NULL,              -- 'image' | 'video'
    size_bytes      INTEGER,
    width           INTEGER,
    height          INTEGER,
    taken_at        TEXT,                       -- ISO8601, from EXIF or mtime
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    thumb_path      TEXT,
    -- EXIF / metadata
    camera_make     TEXT,
    camera_model    TEXT,
    gps_lat         REAL,
    gps_lon         REAL,
    -- state
    is_favorite     INTEGER NOT NULL DEFAULT 0,
    is_archived     INTEGER NOT NULL DEFAULT 0,
    is_hidden       INTEGER NOT NULL DEFAULT 0,
    is_trashed      INTEGER NOT NULL DEFAULT 0,
    trashed_at      TEXT,
    -- AI processing
    ai_processed    INTEGER NOT NULL DEFAULT 0,
    ai_error        TEXT,                       -- last processing error (failed jobs)
    file_hash       TEXT                        -- sha1 of file bytes (exact-dup detection)
);

CREATE INDEX IF NOT EXISTS idx_media_taken_at ON media(taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_folder ON media(folder_id);
CREATE INDEX IF NOT EXISTS idx_media_state ON media(is_trashed, is_archived, is_hidden);

CREATE TABLE IF NOT EXISTS people (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT,
    cover_media_id  INTEGER REFERENCES media(id) ON DELETE SET NULL,
    is_hidden       INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS faces (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id        INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    person_id       INTEGER REFERENCES people(id) ON DELETE SET NULL,
    -- bounding box (normalized 0..1)
    bbox_x          REAL, bbox_y REAL, bbox_w REAL, bbox_h REAL,
    embedding       BLOB,                       -- float32 vector
    age             REAL,                       -- estimated age (real backend only)
    gender          TEXT,                       -- 'M' | 'F' (real backend only)
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_faces_media ON faces(media_id);
CREATE INDEX IF NOT EXISTS idx_faces_person ON faces(person_id);

-- Object / scene / OCR tags produced by the AI pipeline.
CREATE TABLE IF NOT EXISTS tags (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id        INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,              -- 'object' | 'scene' | 'ocr' | 'pet'
    label           TEXT NOT NULL,
    confidence      REAL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tags_media ON tags(media_id);
CREATE INDEX IF NOT EXISTS idx_tags_label ON tags(kind, label);

CREATE TABLE IF NOT EXISTS albums (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    is_smart        INTEGER NOT NULL DEFAULT 0,
    rule            TEXT,                       -- JSON for smart albums
    cover_media_id  INTEGER REFERENCES media(id) ON DELETE SET NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS album_media (
    album_id        INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    media_id        INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    added_at        TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (album_id, media_id)
);

-- Manual, free-form relationships between people (friend, cousin, colleague…).
-- Undirected: stored with person_a < person_b so each pair is unique.
CREATE TABLE IF NOT EXISTS relationships (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    person_a        INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    person_b        INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    label           TEXT NOT NULL DEFAULT '',
    directed        INTEGER NOT NULL DEFAULT 0,   -- 1: person_a -> person_b (e.g. parent->child)
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (person_a, person_b)
);
"""


def _connect() -> sqlite3.Connection:
    ensure_dirs()
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    return conn


def get_conn() -> sqlite3.Connection:
    """Return a thread-local connection."""
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = _connect()
        _local.conn = conn
    return conn


@contextmanager
def transaction() -> Iterator[sqlite3.Connection]:
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def _migrate_stable_ids(conn: sqlite3.Connection) -> None:
    """Remap any media rows whose id doesn't match their path-derived id.

    One-time upgrade for libraries created before ids were path-stable. Updates
    the media PK and every table that references it. New ids are ~60-bit values,
    so they never collide with the small legacy ids being replaced.
    """
    rows = conn.execute("SELECT id, path FROM media").fetchall()
    remap = [
        (r["id"], stable_media_id(r["path"]))
        for r in rows
        if r["id"] != stable_media_id(r["path"])
    ]
    if not remap:
        return

    conn.commit()  # PRAGMA foreign_keys is a no-op inside a transaction
    conn.execute("PRAGMA foreign_keys=OFF;")
    try:
        for old, new in remap:
            conn.execute("UPDATE media SET id=? WHERE id=?", (new, old))
            conn.execute("UPDATE faces SET media_id=? WHERE media_id=?", (new, old))
            conn.execute("UPDATE tags SET media_id=? WHERE media_id=?", (new, old))
            conn.execute(
                "UPDATE album_media SET media_id=? WHERE media_id=?", (new, old)
            )
            conn.execute(
                "UPDATE people SET cover_media_id=? WHERE cover_media_id=?", (new, old)
            )
            conn.execute(
                "UPDATE albums SET cover_media_id=? WHERE cover_media_id=?", (new, old)
            )
        conn.commit()
    finally:
        conn.execute("PRAGMA foreign_keys=ON;")


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, decl: str) -> None:
    """Add a column to an existing table if it's missing (lightweight migration)."""
    cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
        conn.commit()


def init_db() -> None:
    """Create tables if they don't exist."""
    conn = get_conn()
    conn.executescript(SCHEMA)
    conn.commit()
    # Upgrade older relationship tables created before `directed` existed.
    _ensure_column(conn, "relationships", "directed", "INTEGER NOT NULL DEFAULT 0")
    # Age/gender columns for family (parent/child) suggestions (real backend).
    _ensure_column(conn, "faces", "age", "REAL")
    _ensure_column(conn, "faces", "gender", "TEXT")
    # Processing Center + Watch Folders + duplicate detection columns.
    _ensure_column(conn, "media", "ai_error", "TEXT")
    _ensure_column(conn, "media", "file_hash", "TEXT")
    _ensure_column(conn, "folders", "watch", "INTEGER NOT NULL DEFAULT 0")
    _migrate_stable_ids(conn)
