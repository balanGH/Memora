"""Runtime configuration and on-disk data locations.

Everything Memora stores lives under a single data directory in the user's
home folder. Nothing ever leaves the machine.
"""
from __future__ import annotations

import os
from pathlib import Path

APP_NAME = "Memora"

# Allow overriding the data dir (useful for tests / portable installs).
DATA_DIR = Path(os.environ.get("MEMORA_DATA_DIR", Path.home() / ".memora"))
THUMBNAIL_DIR = DATA_DIR / "thumbnails"
# Web-safe JPEG renditions for formats browsers can't decode (HEIC, TIFF, ...).
DISPLAY_DIR = DATA_DIR / "display"
# Cached OpenStreetMap tiles for the Places map (downloaded once, reused offline).
TILES_DIR = DATA_DIR / "tiles"
DB_PATH = DATA_DIR / "memora.db"

# Server
HOST = os.environ.get("MEMORA_HOST", "127.0.0.1")
PORT = int(os.environ.get("MEMORA_PORT", "8756"))

# Media handling
IMAGE_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp",
    ".tif", ".tiff", ".heic", ".heif",
}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}
MEDIA_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS

# Formats a Chromium <img> can render directly; everything else in
# IMAGE_EXTENSIONS gets a converted JPEG rendition for the viewer.
WEB_SAFE_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}

THUMBNAIL_SIZE = (400, 400)   # max box for grid thumbnails
THUMBNAIL_QUALITY = 82
DISPLAY_SIZE = (2560, 2560)   # max box for full-view JPEG renditions
DISPLAY_QUALITY = 88


def ensure_dirs() -> None:
    """Create the data directories if they do not exist."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    THUMBNAIL_DIR.mkdir(parents=True, exist_ok=True)
    DISPLAY_DIR.mkdir(parents=True, exist_ok=True)
    TILES_DIR.mkdir(parents=True, exist_ok=True)
