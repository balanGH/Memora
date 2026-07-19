"""Image inspection: EXIF extraction and thumbnail generation.

Pure Pillow implementation so the vertical slice runs without OpenCV. HEIC/HEIF
support is enabled opportunistically via pillow-heif when available.
"""
from __future__ import annotations

import hashlib
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, TypedDict

from PIL import Image, ImageOps
from PIL.ExifTags import GPSTAGS, TAGS

from .config import (
    DISPLAY_DIR,
    DISPLAY_QUALITY,
    DISPLAY_SIZE,
    IMAGE_EXTENSIONS,
    THUMBNAIL_DIR,
    THUMBNAIL_QUALITY,
    THUMBNAIL_SIZE,
    VIDEO_EXTENSIONS,
    WEB_SAFE_IMAGE_EXTENSIONS,
)

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


def is_video(path: Path) -> bool:
    return path.suffix.lower() in VIDEO_EXTENSIONS


def is_web_safe(path: Path) -> bool:
    """True if a browser <img> can render the file directly (no conversion)."""
    return path.suffix.lower() in WEB_SAFE_IMAGE_EXTENSIONS


def ffmpeg_path() -> Optional[str]:
    """Locate ffmpeg on PATH (used for video thumbnails + frame sampling)."""
    return shutil.which("ffmpeg")


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


def crop_face(
    path: Path,
    bbox: tuple[float, float, float, float],
    out_size: int = 256,
    pad: float = 0.4,
) -> Optional[bytes]:
    """Crop a square face thumbnail from ``path`` given a normalized bbox.

    ``bbox`` is (x, y, w, h) in 0..1. ``pad`` adds margin around the face so the
    circular avatar isn't cropped too tight. Returns WEBP bytes, or None.
    """
    try:
        with Image.open(path) as img:
            img = ImageOps.exif_transpose(img).convert("RGB")
            W, H = img.size
            x, y, w, h = bbox
            cx, cy = (x + w / 2) * W, (y + h / 2) * H
            side = max(w * W, h * H) * (1 + pad)
            half = side / 2
            box = (
                int(max(cx - half, 0)),
                int(max(cy - half, 0)),
                int(min(cx + half, W)),
                int(min(cy + half, H)),
            )
            face = img.crop(box)
            face.thumbnail((out_size, out_size), Image.Resampling.LANCZOS)
            import io

            buf = io.BytesIO()
            face.save(buf, "WEBP", quality=85)
            return buf.getvalue()
    except Exception:
        return None


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


def display_filename(path: Path) -> str:
    digest = hashlib.sha1(str(path).encode("utf-8")).hexdigest()
    return f"{digest}.jpg"


def generate_display(path: Path) -> Optional[str]:
    """Return a browser-renderable JPEG for a non-web-safe image (HEIC/TIFF/...).

    Cached under DISPLAY_DIR. Web-safe files don't need this — the caller serves
    the original directly. Returns the JPEG path, or None on failure.
    """
    if not is_image(path):
        return None
    out = DISPLAY_DIR / display_filename(path)
    if out.exists():
        return str(out)
    try:
        with Image.open(path) as img:
            img = ImageOps.exif_transpose(img).convert("RGB")
            img.thumbnail(DISPLAY_SIZE, Image.Resampling.LANCZOS)
            img.save(out, "JPEG", quality=DISPLAY_QUALITY, progressive=True)
        return str(out)
    except Exception:
        return None


def generate_video_thumbnail(path: Path) -> Optional[str]:
    """Grab a representative frame from a video via ffmpeg and cache a thumbnail.

    No-op (returns None) when ffmpeg isn't installed — the UI then shows a video
    placeholder tile instead.
    """
    ff = ffmpeg_path()
    if ff is None:
        return None
    out = THUMBNAIL_DIR / thumb_filename(path)
    if out.exists():
        return str(out)
    tmp = out.with_suffix(".frame.jpg")
    try:
        # Seek ~1s in to skip black intro frames; scale to thumbnail width.
        subprocess.run(
            [ff, "-y", "-ss", "1", "-i", str(path), "-frames:v", "1",
             "-vf", f"scale={THUMBNAIL_SIZE[0]}:-1", str(tmp)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30,
        )
        if not tmp.exists():
            return None
        with Image.open(tmp) as img:
            img = img.convert("RGB")
            img.thumbnail(THUMBNAIL_SIZE, Image.Resampling.LANCZOS)
            img.save(out, "WEBP", quality=THUMBNAIL_QUALITY, method=4)
        return str(out)
    except Exception:
        return None
    finally:
        tmp.unlink(missing_ok=True)


def extract_video_frames(path: Path, count: int = 8) -> list[Path]:
    """Sample up to ``count`` frames evenly across a video for face detection.

    Returns paths to temporary JPEG frames (caller deletes the parent dir).
    Empty list if ffmpeg is missing or extraction fails.
    """
    ff = ffmpeg_path()
    if ff is None:
        return []
    tmpdir = Path(tempfile.mkdtemp(prefix="memora_frames_"))
    try:
        # fps filter that yields roughly `count` frames regardless of length is
        # hard without probing; sample 1 frame every 2s and cap at `count`.
        subprocess.run(
            [ff, "-y", "-i", str(path), "-vf", "fps=1/2",
             "-frames:v", str(count), str(tmpdir / "f_%03d.jpg")],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120,
        )
        return sorted(tmpdir.glob("f_*.jpg"))
    except Exception:
        return []
