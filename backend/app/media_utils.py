"""Image/video inspection: metadata extraction, hashing and cached renditions.

Pure Pillow implementation so the app runs without OpenCV. HEIC/HEIF support
is enabled opportunistically via pillow-heif when available; video metadata
uses ffprobe and video thumbnails ffmpeg, both optional.

Originals are only ever *read* here. Every file this module writes goes into
Memora's own cache directories, via a temp file + atomic rename.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import re
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
    HEIF_SUPPORTED = True
except Exception:  # pragma: no cover
    HEIF_SUPPORTED = False

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class MediaMeta(TypedDict, total=False):
    width: Optional[int]
    height: Optional[int]
    taken_at: Optional[str]
    # Where taken_at came from (see TIMESTAMP_SOURCES) and the EXIF UTC offset
    # recorded by the camera, kept verbatim and never applied to taken_at.
    taken_at_source: Optional[str]
    tz_offset: Optional[str]
    camera_make: Optional[str]
    camera_model: Optional[str]
    gps_lat: Optional[float]
    gps_lon: Optional[float]
    duration: Optional[float]
    video_codec: Optional[str]


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


def ffprobe_path() -> Optional[str]:
    """Locate ffprobe on PATH (video duration / dimensions / creation time)."""
    return shutil.which("ffprobe")


def unsupported_reason(path: Path) -> Optional[str]:
    """Human-readable reason a known extension can't be decoded here, if any."""
    if path.suffix.lower() in (".heic", ".heif") and not HEIF_SUPPORTED:
        return "HEIC/HEIF needs the optional 'pillow-heif' package"
    return None


# --------------------------------------------------------------- dates -----

# Capture-date fallback order (B17). taken_at always holds the camera's local
# wall-clock time; it is never shifted between time zones (B16).
TIMESTAMP_SOURCES = (
    "exif_original",    # EXIF DateTimeOriginal (Exif IFD 0x9003)
    "exif_digitized",   # EXIF DateTimeDigitized (0x9004)
    "video_metadata",   # container creation_time (UTC converted to local)
    "filename",         # e.g. IMG_20210314_101500.jpg
    "exif_datetime",    # IFD0 DateTime: last modification by software
    "file_mtime",       # filesystem modification time: NOT a capture date
)
_MIN_YEAR = 1826  # oldest surviving photograph


def _sane_year(dt: datetime) -> bool:
    return _MIN_YEAR <= dt.year <= datetime.now().year + 1


def _as_text(raw) -> Optional[str]:
    if isinstance(raw, bytes):
        raw = raw.decode("ascii", "ignore")
    if not isinstance(raw, str):
        return None
    return raw.strip().strip("\x00").strip()


def _parse_exif_datetime(raw) -> Optional[str]:
    """EXIF "YYYY:MM:DD HH:MM:SS" -> ISO local time; None if blank/invalid."""
    text = _as_text(raw)
    if not text:
        return None
    for fmt, n in (("%Y:%m:%d %H:%M:%S", 19), ("%Y-%m-%d %H:%M:%S", 19), ("%Y:%m:%d %H:%M", 16)):
        try:
            dt = datetime.strptime(text[:n], fmt)
        except ValueError:
            continue
        return dt.isoformat() if _sane_year(dt) else None
    return None


_TZ_RE = re.compile(r"^[+-](0\d|1[0-4]):[0-5]\d$")


def _parse_offset(raw) -> Optional[str]:
    text = _as_text(raw)
    return text if text and _TZ_RE.match(text) else None


# Date (and optional time) embedded in common camera/phone file names:
# IMG_20210314_101500, PXL_20210314_101500123, VID-20210314-WA0001,
# Screenshot_2021-03-14-10-15-00, 2021-03-14 10.15.00.
_NAME_DT = re.compile(
    r"(?<!\d)((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])"
    r"(?:[-_ T.]?([01]\d|2[0-3])[-_.:]?([0-5]\d)[-_.:]?([0-5]\d))?"
)


def filename_datetime(name: str) -> Optional[str]:
    m = _NAME_DT.search(name)
    if not m:
        return None
    y, mo, d, hh, mm, ss = m.groups()
    try:
        dt = datetime(int(y), int(mo), int(d), int(hh or 0), int(mm or 0), int(ss or 0))
    except ValueError:
        return None
    return dt.isoformat() if _sane_year(dt) else None


def _mtime_iso(path: Path) -> Optional[str]:
    try:
        # Local time, matching EXIF's camera-local convention.
        return datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds")
    except (OSError, ValueError, OverflowError):
        return None


def _fallback_date(meta: MediaMeta, path: Path, ifd0_datetime: Optional[str] = None) -> None:
    """Fill taken_at from the lower-priority sources if nothing better was found."""
    if meta.get("taken_at"):
        return
    for source, value in (
        ("filename", filename_datetime(path.name)),
        ("exif_datetime", ifd0_datetime),
        ("file_mtime", _mtime_iso(path)),
    ):
        if value:
            meta["taken_at"], meta["taken_at_source"] = value, source
            return
    meta["taken_at"], meta["taken_at_source"] = None, None


# ----------------------------------------------------------------- GPS -----

def _rational_to_float(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError, ZeroDivisionError):
        try:
            return value[0] / value[1]
        except Exception:
            return float("nan")


def _dms_to_decimal(dms, ref) -> Optional[float]:
    try:
        ref = (_as_text(ref) or "").upper()
        deg = _rational_to_float(dms[0])
        minutes = _rational_to_float(dms[1])
        seconds = _rational_to_float(dms[2])
        dec = deg + minutes / 60.0 + seconds / 3600.0
        if not math.isfinite(dec):
            return None
        if ref in ("S", "W"):
            dec = -dec
        return round(dec, 6)
    except Exception:
        return None


def valid_gps(lat, lon) -> bool:
    """Finite, in range, and not the (0, 0) "null island" written by cameras
    that had no fix (B18)."""
    if lat is None or lon is None:
        return False
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        return False
    if not (math.isfinite(lat) and math.isfinite(lon)):
        return False
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return False
    return not (lat == 0.0 and lon == 0.0)


# ------------------------------------------------------------ metadata -----

_EXIF_IFD = 0x8769
_GPS_IFD = 0x8825


def extract_metadata(path: Path) -> MediaMeta:
    """Read dimensions + EXIF (capture date, camera, GPS) from an image.

    Capture date priority: DateTimeOriginal > DateTimeDigitized (both live in
    the Exif sub-IFD, not IFD0) > date in the file name > IFD0 DateTime (last
    modified by software) > file mtime. ``taken_at_source`` records which one
    won; ``tz_offset`` keeps the camera's OffsetTimeOriginal verbatim.
    """
    meta: MediaMeta = {}
    ifd0_dt: Optional[str] = None
    try:
        with Image.open(path) as img:
            meta["width"], meta["height"] = img.size
            exif = img.getexif()
            # Orientations 5-8 are rotated 90/270 degrees: the displayed image
            # (thumbnails use exif_transpose) is portrait, so swap to match.
            if exif and exif.get(0x0112) in (5, 6, 7, 8):
                meta["width"], meta["height"] = meta["height"], meta["width"]
            if exif:
                tags = {TAGS.get(k, k): v for k, v in exif.items()}
                meta["camera_make"] = _clean(tags.get("Make"))
                meta["camera_model"] = _clean(tags.get("Model"))
                ifd0_dt = _parse_exif_datetime(tags.get("DateTime"))

                try:
                    sub = exif.get_ifd(_EXIF_IFD)
                except Exception:
                    sub = {}
                for tag_id, offset_id, source in (
                    (0x9003, 0x9011, "exif_original"),
                    (0x9004, 0x9012, "exif_digitized"),
                ):
                    value = _parse_exif_datetime(sub.get(tag_id))
                    if value:
                        meta["taken_at"], meta["taken_at_source"] = value, source
                        meta["tz_offset"] = _parse_offset(sub.get(offset_id))
                        break

                try:
                    gps_ifd = exif.get_ifd(_GPS_IFD)
                except Exception:
                    gps_ifd = {}
                if gps_ifd:
                    gps = {GPSTAGS.get(k, k): v for k, v in gps_ifd.items()}
                    lat = gps.get("GPSLatitude")
                    lat_ref = gps.get("GPSLatitudeRef")
                    lon = gps.get("GPSLongitude")
                    lon_ref = gps.get("GPSLongitudeRef")
                    if lat and lat_ref and lon and lon_ref:
                        la = _dms_to_decimal(lat, lat_ref)
                        lo = _dms_to_decimal(lon, lon_ref)
                        if valid_gps(la, lo):
                            meta["gps_lat"], meta["gps_lon"] = la, lo
    except Exception:
        # Unreadable / corrupt / non-image: dimensions stay empty.
        pass

    _fallback_date(meta, path, ifd0_dt)
    return meta


def parse_ffprobe(data: dict) -> MediaMeta:
    """Pure parser for ``ffprobe -print_format json -show_format -show_streams``."""
    meta: MediaMeta = {}
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video:
        w, h = video.get("width"), video.get("height")
        if isinstance(w, int) and isinstance(h, int) and w > 0 and h > 0:
            rotation = 0
            try:
                rotation = int(float((video.get("tags") or {}).get("rotate", 0)))
            except (TypeError, ValueError):
                pass
            for sd in video.get("side_data_list") or []:
                if "rotation" in sd:
                    try:
                        rotation = int(float(sd["rotation"]))
                    except (TypeError, ValueError):
                        pass
            if abs(rotation) % 180 == 90:
                w, h = h, w
            meta["width"], meta["height"] = w, h
        if video.get("codec_name"):
            meta["video_codec"] = str(video["codec_name"])
    fmt = data.get("format") or {}
    try:
        duration = float(fmt.get("duration"))
        if math.isfinite(duration) and duration >= 0:
            meta["duration"] = round(duration, 3)
    except (TypeError, ValueError):
        pass
    created = (fmt.get("tags") or {}).get("creation_time") or (
        ((video or {}).get("tags") or {}).get("creation_time")
    )
    if created:
        try:
            dt = datetime.fromisoformat(str(created).replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)  # QuickTime/MP4 store UTC
            local = dt.astimezone().replace(tzinfo=None)
            # 1904-01-01 / 1970-01-01 are "unset" placeholders in many files.
            if _sane_year(local) and local.year not in (1904, 1970):
                meta["taken_at"] = local.isoformat(timespec="seconds")
                meta["taken_at_source"] = "video_metadata"
        except (ValueError, OverflowError, OSError):
            pass
    return meta


def extract_video_metadata(path: Path) -> MediaMeta:
    """Duration / dimensions / codec / creation time via ffprobe when it is
    installed; otherwise only the date fallbacks (file name, mtime)."""
    meta: MediaMeta = {}
    probe = ffprobe_path()
    if probe:
        try:
            res = subprocess.run(
                [probe, "-v", "error", "-print_format", "json",
                 "-show_format", "-show_streams", str(path)],
                capture_output=True, timeout=30, creationflags=_NO_WINDOW,
            )
            if res.returncode == 0 and res.stdout:
                meta = parse_ffprobe(json.loads(res.stdout.decode("utf-8", "replace")))
        except (OSError, subprocess.SubprocessError, ValueError):
            meta = {}
    _fallback_date(meta, path)
    return meta


def _clean(value) -> Optional[str]:
    if value is None:
        return None
    s = str(value).strip().strip("\x00")
    return s or None


# ------------------------------------------------------- hashing/cache -----

def _cache_key(path: Path, size: Optional[int] = None, mtime_ns: Optional[int] = None) -> str:
    """Content-aware cache key: path + size + mtime, so an edited original
    gets a new rendition instead of a stale cached one (B20)."""
    if size is None or mtime_ns is None:
        try:
            st = path.stat()
            size, mtime_ns = st.st_size, st.st_mtime_ns
        except OSError:
            size, mtime_ns = -1, -1
    return hashlib.sha1(f"{path}|{size}|{mtime_ns}".encode("utf-8")).hexdigest()


def thumb_filename(path: Path, size: Optional[int] = None, mtime_ns: Optional[int] = None) -> str:
    return f"{_cache_key(path, size, mtime_ns)}.webp"


def display_filename(path: Path, size: Optional[int] = None, mtime_ns: Optional[int] = None) -> str:
    return f"{_cache_key(path, size, mtime_ns)}.jpg"


def file_sha256(path: Path) -> Optional[str]:
    """SHA-256 of the file's bytes (exact duplicates / moved files). None on error."""
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def _save_atomic(img: Image.Image, out: Path, fmt: str, **kwargs) -> None:
    """Write to a temp file then rename, so a crash or a concurrent writer
    never leaves a truncated cache file behind."""
    fd, tmp = tempfile.mkstemp(prefix=out.stem + ".", suffix=".tmp", dir=out.parent)
    os.close(fd)
    try:
        img.save(tmp, fmt, **kwargs)
        os.replace(tmp, out)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def dhash(img: Image.Image, size: int = 8) -> str:
    """64-bit difference hash (hex). Near-identical images differ by few bits."""
    small = img.convert("L").resize((size + 1, size), Image.Resampling.LANCZOS)
    px = list(small.getdata())
    bits = 0
    for row in range(size):
        for col in range(size):
            left = px[row * (size + 1) + col]
            right = px[row * (size + 1) + col + 1]
            bits = (bits << 1) | (1 if left > right else 0)
    return f"{bits:016x}"


def phash_file(path: Path) -> Optional[str]:
    """dHash of an image file (use the small thumbnail: fast and identical
    for every rendition of the same picture)."""
    try:
        with Image.open(path) as img:
            return dhash(img)
    except Exception:
        return None


def hamming(a: str, b: str) -> int:
    return bin(int(a, 16) ^ int(b, 16)).count("1")


# ---------------------------------------------------------- renditions -----

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
            buf = io.BytesIO()
            face.save(buf, "WEBP", quality=85)
            return buf.getvalue()
    except Exception:
        return None


def generate_thumbnail(
    path: Path, size: Optional[int] = None, mtime_ns: Optional[int] = None
) -> Optional[str]:
    """Create a cached thumbnail; returns the thumbnail path or None on failure.

    Idempotent for unchanged files: the cache key includes size + mtime, so an
    existing thumbnail is reused only while the original is unchanged.
    """
    if not is_image(path):
        return None
    THUMBNAIL_DIR.mkdir(parents=True, exist_ok=True)
    out = THUMBNAIL_DIR / thumb_filename(path, size, mtime_ns)
    if out.exists() and out.stat().st_size > 0:
        return str(out)
    try:
        with Image.open(path) as img:
            # Decode at reduced size where the codec supports it (JPEG): a big
            # memory saving for very large photos (B06).
            img.draft("RGB", (THUMBNAIL_SIZE[0] * 2, THUMBNAIL_SIZE[1] * 2))
            img = ImageOps.exif_transpose(img)  # honor orientation
            img = img.convert("RGB")
            img.thumbnail(THUMBNAIL_SIZE, Image.Resampling.LANCZOS)
            _save_atomic(img, out, "WEBP", quality=THUMBNAIL_QUALITY, method=4)
        return str(out)
    except Exception:
        return None


def generate_display(path: Path) -> Optional[str]:
    """Return a browser-renderable JPEG for a non-web-safe image (HEIC/TIFF/...).

    Cached under DISPLAY_DIR. Web-safe files don't need this — the caller serves
    the original directly. Returns the JPEG path, or None on failure.
    """
    if not is_image(path):
        return None
    DISPLAY_DIR.mkdir(parents=True, exist_ok=True)
    out = DISPLAY_DIR / display_filename(path)
    if out.exists() and out.stat().st_size > 0:
        return str(out)
    try:
        with Image.open(path) as img:
            img = ImageOps.exif_transpose(img).convert("RGB")
            img.thumbnail(DISPLAY_SIZE, Image.Resampling.LANCZOS)
            _save_atomic(img, out, "JPEG", quality=DISPLAY_QUALITY, progressive=True)
        return str(out)
    except Exception:
        return None


def generate_video_thumbnail(
    path: Path, size: Optional[int] = None, mtime_ns: Optional[int] = None
) -> Optional[str]:
    """Grab a representative frame from a video via ffmpeg and cache a thumbnail.

    No-op (returns None) when ffmpeg isn't installed — the UI then shows a video
    placeholder tile instead.
    """
    ff = ffmpeg_path()
    if ff is None:
        return None
    THUMBNAIL_DIR.mkdir(parents=True, exist_ok=True)
    out = THUMBNAIL_DIR / thumb_filename(path, size, mtime_ns)
    if out.exists() and out.stat().st_size > 0:
        return str(out)
    tmp = out.with_suffix(f".{os.getpid()}.frame.jpg")
    try:
        # Seek ~1s in to skip black intro frames; scale to thumbnail width.
        subprocess.run(
            [ff, "-y", "-ss", "1", "-i", str(path), "-frames:v", "1",
             "-vf", f"scale={THUMBNAIL_SIZE[0]}:-1", str(tmp)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30,
            creationflags=_NO_WINDOW,
        )
        if not tmp.exists():
            return None
        with Image.open(tmp) as img:
            img = img.convert("RGB")
            img.thumbnail(THUMBNAIL_SIZE, Image.Resampling.LANCZOS)
            _save_atomic(img, out, "WEBP", quality=THUMBNAIL_QUALITY, method=4)
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
            creationflags=_NO_WINDOW,
        )
        frames = sorted(tmpdir.glob("f_*.jpg"))
    except Exception:
        frames = []
    if not frames:
        shutil.rmtree(tmpdir, ignore_errors=True)
    return frames
