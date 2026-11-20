"""Test harness.

Every test runs against a throwaway data directory and throwaway photo folders
under pytest's tmp dir. Nothing here ever touches ~/.memora or a real library.
MEMORA_DATA_DIR must be set before ``app`` is imported (config reads it once).
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

_SESSION_DIR = Path(tempfile.mkdtemp(prefix="memora_tests_"))
os.environ["MEMORA_DATA_DIR"] = str(_SESSION_DIR / "data")
os.environ.pop("MEMORA_API_TOKEN", None)
os.environ["MEMORA_AI_BACKEND"] = "none"
os.environ["MEMORA_FACE_BACKEND"] = "none"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from PIL import Image  # noqa: E402

from app import config, db  # noqa: E402


def _reset_modules() -> None:
    from app import ai, ai_pipeline, scanner, watcher

    ai.reset_services()
    ai_pipeline.reset_state()
    scanner.reset_state()
    watcher.reset_state()


@pytest.fixture(autouse=True)
def fresh_db():
    """Empty data dir + freshly migrated DB for every test."""
    db.close_all(checkpoint=False)
    shutil.rmtree(config.DATA_DIR, ignore_errors=True)
    _reset_modules()
    db.init_db()
    yield
    _reset_modules()
    db.close_all(checkpoint=False)


@pytest.fixture
def library(tmp_path) -> Path:
    root = tmp_path / "library"
    root.mkdir()
    return root


def make_jpeg(path: Path, color=(200, 30, 30), size=(64, 48), exif=None) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    im = Image.new("RGB", size, color)
    if exif is not None:
        im.save(path, "JPEG", exif=exif)
    else:
        im.save(path, "JPEG")
    return path


@pytest.fixture
def jpeg():
    return make_jpeg


def pytest_sessionfinish(session, exitstatus):
    db.close_all(checkpoint=False)
    shutil.rmtree(_SESSION_DIR, ignore_errors=True)
