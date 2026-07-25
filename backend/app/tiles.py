"""Map-tile proxy with an on-disk cache.

The Places map requests tiles from the local backend instead of the internet.
On a cache miss we fetch the tile from the provider once, store it under
``~/.memora/tiles/<style>/z/x/y.png``, and serve it. Later views — offline or
after a restart — are served from disk with no network access.

Provider: CARTO basemaps (rendered from OpenStreetMap data). CARTO's basemaps
are usable by applications without an API key, unlike the OSMF tile servers,
whose usage policy disallows this kind of app client and returns a "blocked"
tile. We send a descriptive User-Agent, and caching keeps request volume low.
Override the provider with MEMORA_TILE_URL if you have your own tile source.
"""
from __future__ import annotations

import os
import shutil
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

from .config import TILES_DIR

_USER_AGENT = "Memora/0.1 (local desktop photo manager; https://memora.local)"
_TIMEOUT = 10

# Style -> upstream URL template. CARTO serves subdomains a-d; we use one
# server-side (no browser subdomain sharding needed). {z}/{x}/{y} are filled in.
_PROVIDERS = {
    "light": "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    "dark": "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    "voyager": "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
}
# Optional override: a single custom template used for every style.
_CUSTOM_URL = os.environ.get("MEMORA_TILE_URL")


def _valid(z: int, x: int, y: int) -> bool:
    if not (0 <= z <= 20):
        return False
    n = 1 << z
    return 0 <= x < n and 0 <= y < n


def _upstream(style: str, z: int, x: int, y: int) -> str:
    template = _CUSTOM_URL or _PROVIDERS.get(style, _PROVIDERS["voyager"])
    return template.format(z=z, x=x, y=y)


def _cache_path(style: str, z: int, x: int, y: int) -> Path:
    return TILES_DIR / style / str(z) / str(x) / f"{y}.png"


def get_tile(style: str, z: int, x: int, y: int) -> Optional[bytes]:
    """PNG bytes for a tile, fetching + caching on miss. None if offline and
    uncached, or on error (caller serves a blank tile)."""
    if style not in _PROVIDERS:
        style = "voyager"
    if not _valid(z, x, y):
        return None

    path = _cache_path(style, z, x, y)
    if path.exists() and path.stat().st_size > 0:
        try:
            return path.read_bytes()
        except OSError:
            pass

    req = urllib.request.Request(
        _upstream(style, z, x, y),
        headers={"User-Agent": _USER_AGENT, "Referer": "https://memora.local/"},
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            data = resp.read()
    except (urllib.error.URLError, TimeoutError, OSError):
        return None
    if not data:
        return None

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)
    except OSError:
        pass
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
