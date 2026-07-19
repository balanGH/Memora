"""OpenStreetMap tile proxy with an on-disk cache.

The Places map requests tiles from the local backend instead of the internet.
On a cache miss we fetch the tile from OpenStreetMap once, store it under
``~/.memora/tiles/z/x/y.png``, and serve it. On later views — including fully
offline and after an app restart — the cached tile is served with no network
access. A miss while offline simply returns None (the map shows a blank tile).

Only the backend ever contacts the internet, and only for map tiles; your
photos and metadata never leave the machine.
"""
from __future__ import annotations

import shutil
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

from .config import TILES_DIR

# OSM's tile-usage policy requires a descriptive User-Agent identifying the app.
_USER_AGENT = "Memora/0.1 (local offline photo manager; tile cache)"
_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
_TIMEOUT = 10


def _valid(z: int, x: int, y: int) -> bool:
    if not (0 <= z <= 19):
        return False
    n = 1 << z
    return 0 <= x < n and 0 <= y < n


def _cache_path(z: int, x: int, y: int) -> Path:
    return TILES_DIR / str(z) / str(x) / f"{y}.png"


def get_tile(z: int, x: int, y: int) -> Optional[bytes]:
    """Return PNG bytes for a tile, fetching + caching on miss. None if offline
    and uncached, or on any error."""
    if not _valid(z, x, y):
        return None

    path = _cache_path(z, x, y)
    if path.exists() and path.stat().st_size > 0:
        try:
            return path.read_bytes()
        except OSError:
            pass  # fall through and re-fetch

    url = _TILE_URL.format(z=z, x=x, y=y)
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            data = resp.read()
    except (urllib.error.URLError, TimeoutError, OSError):
        return None  # offline or fetch failed — caller serves a blank tile
    if not data:
        return None

    # Atomic write so a partial download never becomes a corrupt cache entry.
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)
    except OSError:
        pass  # cache write failed; still return the bytes we have
    return data


def cache_stats() -> dict:
    tiles, total = 0, 0
    if TILES_DIR.exists():
        for p in TILES_DIR.rglob("*.png"):
            try:
                total += p.stat().st_size
                tiles += 1
            except OSError:
                pass
    return {"tiles": tiles, "bytes": total}


def clear_cache() -> dict:
    freed = cache_stats()
    if TILES_DIR.exists():
        shutil.rmtree(TILES_DIR, ignore_errors=True)
    TILES_DIR.mkdir(parents=True, exist_ok=True)
    return freed
