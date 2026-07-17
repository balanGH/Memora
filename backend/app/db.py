"""SQLite access layer.

Uses the stdlib ``sqlite3`` module (no ORM) to keep the dependency surface
small and startup fast. A single connection is shared per-thread via a simple
helper; SQLite handles concurrency with WAL mode.
"""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from typing import Iterator

from .config import DB_PATH, ensure_dirs

_local = threading.local()


SCHEMA = """
CREATE TABLE IF NOT EXISTS folders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    path        TEXT NOT NULL UNIQUE,
    added_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_scan   TEXT
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
    -- AI processing flag
    ai_processed    INTEGER NOT NULL DEFAULT 0
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


def init_db() -> None:
    """Create tables if they don't exist."""
    conn = get_conn()
    conn.executescript(SCHEMA)
    conn.commit()
