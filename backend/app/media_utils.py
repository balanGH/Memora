"""Image inspection: EXIF extraction and thumbnail generation.

Pure Pillow implementation so the vertical slice runs without OpenCV. HEIC/HEIF
support is enabled opportunistically via pillow-heif when available.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, TypedDict

from PIL import Image, ImageOps
from PIL.ExifTags import GPSTAGS, TAGS

from .config import IMAGE_EXTENSIONS, THUMBNAIL_DIR, THUMBNAIL_QUALITY, THUMBNAIL_SIZE

# Enable HEIC/HEIF if the optional plugin is installed.
try:  # pragma: no cover - depends on optional dep
    import pillow_heif  # type: ignore

    pillow_heif.register_heif_opener()
except Exception:  # pragma: no cover
    pass


class MediaMeta(TypedDict, total=False):
    width: Optional[int]
    height: Optional[int]
    taken_at: Optional[str]
    camera_make: Optional[str]
    camera_model: Optional[str]
    gps_lat: Optional[float]
    gps_lon: Optional[float]


def is_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_EXTENSIONS


def _rational_to_float(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        try:
            return value[0] / value[1]
        except Exception:
            return 0.0


def _dms_to_decimal(dms, ref: str) -> Optional[float]:
    try:
        deg = _rational_to_float(dms[0])
        minutes = _rational_to_float(dms[1])
        seconds = _rational_to_float(dms[2])
        dec = deg + minutes / 60.0 + seconds / 3600.0
        if ref in ("S", "W"):
            dec = -dec
        return round(dec, 6)
    except Exception:
        return None


def _parse_exif_datetime(raw: str) -> Optional[str]:
    # EXIF format: "YYYY:MM:DD HH:MM:SS"
    for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(raw.strip(), fmt).isoformat()
        except (ValueError, AttributeError):
            continue
    return None


def extract_metadata(path: Path) -> MediaMeta:
    """Read dimensions + EXIF. Falls back to file mtime for the date."""
    meta: MediaMeta = {}
    try:
        with Image.open(path) as img:
            meta["width"], meta["height"] = img.size
            exif = img.getexif()
            if exif:
                tags = {TAGS.get(k, k): v for k, v in exif.items()}
                meta["camera_make"] = _clean(tags.get("Make"))
                meta["camera_model"] = _clean(tags.get("Model"))

                dt = tags.get("DateTimeOriginal") or tags.get("DateTime")
                if isinstance(dt, str):
                    meta["taken_at"] = _parse_exif_datetime(dt)

                gps_ifd = exif.get_ifd(0x8825) if hasattr(exif, "get_ifd") else None
                if gps_ifd:
                    gps = {GPSTAGS.get(k, k): v for k, v in gps_ifd.items()}
                    lat = gps.get("GPSLatitude")
                    lat_ref = gps.get("GPSLatitudeRef")
                    lon = gps.get("GPSLongitude")
                    lon_ref = gps.get("GPSLongitudeRef")
                    if lat and lat_ref and lon and lon_ref:
                        meta["gps_lat"] = _dms_to_decimal(lat, lat_ref)
                        meta["gps_lon"] = _dms_to_decimal(lon, lon_ref)
    except Exception:
        # Unreadable / non-image; leave dimensions empty.
        pass

    if not meta.get("taken_at"):
        try:
            mtime = path.stat().st_mtime
            meta["taken_at"] = datetime.fromtimestamp(
                mtime, tz=timezone.utc
            ).replace(tzinfo=None).isoformat()
        except OSError:
            meta["taken_at"] = None
    return meta


def _clean(value) -> Optional[str]:
    if value is None:
        return None
    s = str(value).strip().strip("\x00")
    return s or None


def thumb_filename(path: Path) -> str:
    digest = hashlib.sha1(str(path).encode("utf-8")).hexdigest()
    return f"{digest}.webp"


def generate_thumbnail(path: Path) -> Optional[str]:
    """Create a cached thumbnail; returns the thumbnail path or None on failure.

    Idempotent: if a thumbnail already exists it is reused.
    """
    if not is_image(path):
        return None
    out = THUMBNAIL_DIR / thumb_filename(path)
    if out.exists():
        return str(out)
    try:
        with Image.open(path) as img:
            img = ImageOps.exif_transpose(img)  # honor orientation
            img = img.convert("RGB")
            img.thumbnail(THUMBNAIL_SIZE, Image.Resampling.LANCZOS)
            img.save(out, "WEBP", quality=THUMBNAIL_QUALITY, method=4)
        return str(out)
    except Exception:
        return None
