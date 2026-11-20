"""SQLite access layer.

Uses the stdlib ``sqlite3`` module (no ORM) to keep the dependency surface
small and startup fast. Each thread gets its own connection (WAL mode lets
readers and one writer work concurrently).

Schema changes go through numbered migrations tracked in ``PRAGMA
user_version``. Each migration runs in a single transaction (SQLite DDL is
transactional), so a failure leaves the database exactly as it was. Before an
existing database is upgraded, an online backup is written to
``<data dir>/backups``; ``restore_backup`` rolls back to it.
"""
from __future__ import annotations

import hashlib
import shutil
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Callable, Iterator, Optional

from .config import BACKUP_DIR, DB_PATH, ensure_dirs

_local = threading.local()
_registry_lock = threading.Lock()
_registry: list[sqlite3.Connection] = []
# Bumped by close_all(); a thread whose cached connection is from an older
# generation transparently opens a new one.
_generation = 0

BUSY_TIMEOUT_S = 30
MAX_BACKUPS = 5


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


# ---------------------------------------------------------------- schema ----

# Version-1 schema: exactly the tables the app shipped with before versioned
# migrations existed. Later changes live in their own migration functions.
SCHEMA_V1 = """
CREATE TABLE IF NOT EXISTS folders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    path        TEXT NOT NULL UNIQUE,
    added_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_scan   TEXT,
    watch       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS media (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id       INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    path            TEXT NOT NULL UNIQUE,
    filename        TEXT NOT NULL,
    kind            TEXT NOT NULL,
    size_bytes      INTEGER,
    width           INTEGER,
    height          INTEGER,
    taken_at        TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    thumb_path      TEXT,
    camera_make     TEXT,
    camera_model    TEXT,
    gps_lat         REAL,
    gps_lon         REAL,
    is_favorite     INTEGER NOT NULL DEFAULT 0,
    is_archived     INTEGER NOT NULL DEFAULT 0,
    is_hidden       INTEGER NOT NULL DEFAULT 0,
    is_trashed      INTEGER NOT NULL DEFAULT 0,
    trashed_at      TEXT,
    ai_processed    INTEGER NOT NULL DEFAULT 0,
    ai_error        TEXT,
    file_hash       TEXT
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
    bbox_x          REAL, bbox_y REAL, bbox_w REAL, bbox_h REAL,
    embedding       BLOB,
    age             REAL,
    gender          TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_faces_media ON faces(media_id);
CREATE INDEX IF NOT EXISTS idx_faces_person ON faces(person_id);

CREATE TABLE IF NOT EXISTS tags (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id        INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,
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
    rule            TEXT,
    cover_media_id  INTEGER REFERENCES media(id) ON DELETE SET NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS album_media (
    album_id        INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    media_id        INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    added_at        TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (album_id, media_id)
);

CREATE TABLE IF NOT EXISTS excluded_paths (
    path            TEXT PRIMARY KEY,
    excluded_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS relationships (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    person_a        INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    person_b        INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    label           TEXT NOT NULL DEFAULT '',
    directed        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (person_a, person_b)
);
"""


# ------------------------------------------------------------ connections ----

def _connect() -> sqlite3.Connection:
    ensure_dirs()
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=BUSY_TIMEOUT_S)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_S * 1000};")
    return conn


def get_conn() -> sqlite3.Connection:
    """Return this thread's connection, opening one if needed."""
    cached = getattr(_local, "conn", None)
    if cached is not None and cached[0] == _generation:
        return cached[1]
    conn = _connect()
    with _registry_lock:
        _registry.append(conn)
        gen = _generation
    _local.conn = (gen, conn)
    return conn


def close_all(checkpoint: bool = True) -> None:
    """Close every connection opened by any thread (shutdown / restore / tests).

    Threads that use the DB afterwards get a fresh connection automatically.
    """
    global _generation
    with _registry_lock:
        conns = list(_registry)
        _registry.clear()
        _generation += 1
    for i, c in enumerate(conns):
        try:
            if checkpoint and i == 0:
                c.execute("PRAGMA wal_checkpoint(TRUNCATE);")
        except sqlite3.Error:
            pass
        try:
            c.close()
        except sqlite3.Error:
            pass


@contextmanager
def transaction() -> Iterator[sqlite3.Connection]:
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise


# ------------------------------------------------------------- migrations ----

def _statements(script: str) -> list[str]:
    """Split a SQL script into complete statements (keeps them in one tx)."""
    out, buf = [], ""
    for line in script.splitlines(keepends=True):
        buf += line
        if sqlite3.complete_statement(buf):
            if buf.strip():
                out.append(buf.strip())
            buf = ""
    if buf.strip():
        out.append(buf.strip())
    return out


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, decl: str) -> None:
    """Add a column if missing. Runs inside the caller's transaction."""
    if column not in _columns(conn, table):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


def _m1_baseline(conn: sqlite3.Connection) -> None:
    """The pre-versioning schema, plus the ad-hoc upgrades it used to run on
    every start, plus the path-stable media id remap. Idempotent."""
    for stmt in _statements(SCHEMA_V1):
        conn.execute(stmt)
    _ensure_column(conn, "relationships", "directed", "INTEGER NOT NULL DEFAULT 0")
    _ensure_column(conn, "faces", "age", "REAL")
    _ensure_column(conn, "faces", "gender", "TEXT")
    _ensure_column(conn, "media", "ai_error", "TEXT")
    _ensure_column(conn, "media", "file_hash", "TEXT")
    _ensure_column(conn, "folders", "watch", "INTEGER NOT NULL DEFAULT 0")

    # Remap legacy auto-increment ids to path-derived ids. Foreign keys are
    # checked at COMMIT (defer_foreign_keys) so every referencing table can be
    # updated inside this same transaction.
    rows = conn.execute("SELECT id, path FROM media").fetchall()
    remap = [(r["id"], stable_media_id(r["path"])) for r in rows
             if r["id"] != stable_media_id(r["path"])]
    if remap:
        conn.execute("PRAGMA defer_foreign_keys=ON;")
        for old, new in remap:
            conn.execute("UPDATE media SET id=? WHERE id=?", (new, old))
            conn.execute("UPDATE faces SET media_id=? WHERE media_id=?", (new, old))
            conn.execute("UPDATE tags SET media_id=? WHERE media_id=?", (new, old))
            conn.execute("UPDATE album_media SET media_id=? WHERE media_id=?", (new, old))
            conn.execute("UPDATE people SET cover_media_id=? WHERE cover_media_id=?", (new, old))
            conn.execute("UPDATE albums SET cover_media_id=? WHERE cover_media_id=?", (new, old))


# Model identifiers recorded for legacy AI output (see _m2).
LEGACY_STUB_MODEL = "stub/v1"
LEGACY_INSIGHTFACE_MODEL = "insightface/buffalo_l"


def _m2_integrity_and_versioning(conn: sqlite3.Connection) -> None:
    """Change detection, missing-file tracking, capture-date provenance,
    video metadata, scan failures, AI model versioning, undo journal, indexes."""
    media_cols = [
        ("mtime_ns", "INTEGER"),
        ("taken_at_source", "TEXT"),   # exif_original | exif_digitized | video_metadata | filename | exif_datetime | file_mtime
        ("tz_offset", "TEXT"),         # EXIF OffsetTimeOriginal, verbatim (e.g. +05:30)
        ("is_missing", "INTEGER NOT NULL DEFAULT 0"),
        ("missing_since", "TEXT"),
        ("duration", "REAL"),          # seconds (video)
        ("video_codec", "TEXT"),
        ("phash", "TEXT"),             # 64-bit dHash, hex (near-duplicate / similar)
        ("thumb_attempts", "INTEGER NOT NULL DEFAULT 0"),
        ("faces_model", "TEXT"),       # model that produced this item's faces
        ("tags_model", "TEXT"),
        ("ocr_model", "TEXT"),
        ("embed_model", "TEXT"),
    ]
    for col, decl in media_cols:
        _ensure_column(conn, "media", col, decl)
    for col, decl in [("model", "TEXT"), ("det_score", "REAL"), ("match_score", "REAL")]:
        _ensure_column(conn, "faces", col, decl)
    _ensure_column(conn, "tags", "model", "TEXT")

    for stmt in _statements(
        """
        CREATE TABLE IF NOT EXISTS scan_failures (
            path         TEXT PRIMARY KEY,
            folder_id    INTEGER REFERENCES folders(id) ON DELETE CASCADE,
            error        TEXT NOT NULL,
            attempts     INTEGER NOT NULL DEFAULT 1,
            last_attempt TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS operations (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            kind        TEXT NOT NULL,
            payload     TEXT NOT NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            undone_at   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_media_hash ON media(file_hash);
        CREATE INDEX IF NOT EXISTS idx_media_missing ON media(is_missing);
        CREATE INDEX IF NOT EXISTS idx_media_gps ON media(gps_lat, gps_lon);
        CREATE INDEX IF NOT EXISTS idx_tags_kind_media ON tags(kind, media_id);
        """
    ):
        conn.execute(stmt)

    # Legacy hashes were SHA-1; duplicates are now grouped by SHA-256. Mixing
    # the two would split real duplicate groups, so the derived value is
    # cleared and recomputed by the next scan.
    conn.execute("UPDATE media SET file_hash = NULL")

    # Label legacy AI output with the model that produced it. Before this
    # version only the face service could be real (InsightFace, 512-d
    # embeddings); tagging, OCR and embeddings were always the stub.
    conn.execute(
        "UPDATE faces SET model = CASE WHEN length(embedding) = 512 * 4 THEN ? ELSE ? END "
        "WHERE model IS NULL",
        (LEGACY_INSIGHTFACE_MODEL, LEGACY_STUB_MODEL),
    )
    conn.execute(
        "UPDATE tags SET model = ? WHERE model IS NULL AND kind != 'user'",
        (LEGACY_STUB_MODEL,),
    )
    any_real = conn.execute(
        "SELECT 1 FROM faces WHERE model = ? LIMIT 1", (LEGACY_INSIGHTFACE_MODEL,)
    ).fetchone()
    face_model = LEGACY_INSIGHTFACE_MODEL if any_real else LEGACY_STUB_MODEL
    conn.execute(
        """UPDATE media SET faces_model = ?, tags_model = ?, ocr_model = ?, embed_model = ?
           WHERE ai_processed = 1""",
        (face_model, LEGACY_STUB_MODEL, LEGACY_STUB_MODEL, LEGACY_STUB_MODEL),
    )


# Delete people that have no faces left.
PRUNE_EMPTY_PEOPLE_SQL = (
    "DELETE FROM people WHERE id NOT IN "
    "(SELECT DISTINCT person_id FROM faces WHERE person_id IS NOT NULL)"
)


MIGRATIONS: list[tuple[int, str, Callable[[sqlite3.Connection], None]]] = [
    (1, "baseline schema + stable media ids", _m1_baseline),
    (2, "integrity, provenance, missing files, AI versioning", _m2_integrity_and_versioning),
]
LATEST_VERSION = MIGRATIONS[-1][0]


def schema_version(conn: Optional[sqlite3.Connection] = None) -> int:
    conn = conn or get_conn()
    return conn.execute("PRAGMA user_version").fetchone()[0]


def _has_user_tables(conn: sqlite3.Connection) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='media'"
    ).fetchone() is not None


def migrate(conn: Optional[sqlite3.Connection] = None) -> dict:
    """Bring the schema to LATEST_VERSION. Returns what was done."""
    conn = conn or get_conn()
    conn.commit()
    current = schema_version(conn)
    if current > LATEST_VERSION:
        raise RuntimeError(
            f"Database schema v{current} is newer than this Memora build "
            f"(supports up to v{LATEST_VERSION}). Refusing to modify it."
        )
    applied: list[int] = []
    backup: Optional[str] = None
    if current < LATEST_VERSION and _has_user_tables(conn):
        backup = str(backup_database(f"pre-v{LATEST_VERSION}-from-v{current}", conn))

    for version, _name, fn in MIGRATIONS:
        if version <= current:
            continue
        try:
            conn.execute("BEGIN IMMEDIATE")
            fn(conn)
            conn.execute(f"PRAGMA user_version = {version}")
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        applied.append(version)
    return {"from": current, "to": schema_version(conn), "applied": applied, "backup": backup}


def init_db() -> dict:
    """Create/upgrade the schema. Safe to call on every start."""
    return migrate(get_conn())


# ------------------------------------------------------- integrity/backup ----

def integrity_report(conn: Optional[sqlite3.Connection] = None, full: bool = False) -> dict:
    conn = conn or get_conn()
    pragma = "integrity_check" if full else "quick_check"
    rows = [r[0] for r in conn.execute(f"PRAGMA {pragma}").fetchall()]
    fk = conn.execute("PRAGMA foreign_key_check").fetchall()
    return {
        "ok": rows == ["ok"] and not fk,
        "check": pragma,
        "messages": rows[:50],
        "foreign_key_violations": len(fk),
        "schema_version": schema_version(conn),
    }


def backup_database(reason: str = "manual", conn: Optional[sqlite3.Connection] = None) -> Path:
    """Consistent online copy of the database (sqlite3 backup API)."""
    conn = conn or get_conn()
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in reason)[:40]
    dest = BACKUP_DIR / f"memora-{stamp}-{safe}.db"
    target = sqlite3.connect(dest)
    try:
        conn.backup(target)
    finally:
        target.close()
    _prune_backups()
    return dest


def _prune_backups() -> None:
    backups = sorted(BACKUP_DIR.glob("memora-*.db"))
    for old in backups[:-MAX_BACKUPS]:
        try:
            old.unlink()
        except OSError:
            pass


def list_backups() -> list[dict]:
    if not BACKUP_DIR.exists():
        return []
    out = []
    for p in sorted(BACKUP_DIR.glob("memora-*.db"), reverse=True):
        try:
            out.append({"name": p.name, "bytes": p.stat().st_size})
        except OSError:
            pass
    return out


def restore_backup(name: str) -> dict:
    """Replace the live database with a backup from BACKUP_DIR.

    The current database is itself backed up first, so a restore can be undone.
    Callers must make sure no background job is writing.
    """
    src = (BACKUP_DIR / name).resolve()
    if src.parent != BACKUP_DIR.resolve() or not src.is_file():
        raise ValueError("Unknown backup")
    check = sqlite3.connect(f"file:{src.as_posix()}?mode=ro", uri=True)
    try:
        ok = check.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        version = check.execute("PRAGMA user_version").fetchone()[0]
    finally:
        check.close()
    if not ok:
        raise ValueError("Backup failed its integrity check")
    if version > LATEST_VERSION:
        raise ValueError("Backup is from a newer Memora version")
    safety = backup_database("pre-restore")
    close_all(checkpoint=True)
    for suffix in ("-wal", "-shm"):
        Path(str(DB_PATH) + suffix).unlink(missing_ok=True)
    tmp = DB_PATH.with_suffix(".restore-tmp")
    shutil.copy2(src, tmp)
    tmp.replace(DB_PATH)
    result = init_db()  # bring an older backup up to date
    return {"restored": name, "safety_backup": safety.name, "migration": result}
