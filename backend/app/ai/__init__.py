"""AI service layer.

The rest of the app depends only on the ``Protocol`` interfaces defined in
``interfaces.py``. Swapping an implementation never touches any caller, only
this factory.

Face backend selection (``MEMORA_FACE_BACKEND``):

* ``auto`` (default): use InsightFace if it is installed, otherwise the
  deterministic stub. The compute device is picked automatically: a GPU when
  onnxruntime has a GPU provider for it (CUDA / DirectML / CoreML), else CPU.
  See ``device.py``.
* ``insightface`` / ``real``: require InsightFace (falls back to the stub with a
  warning if it can't load).
* ``stub``: never load models.

Install for real faces: ``pip install insightface opencv-python`` plus ONE
onnxruntime build, chosen for your hardware:
``onnxruntime-gpu`` (NVIDIA), ``onnxruntime-directml`` (any GPU on Windows) or
``onnxruntime`` (CPU / Mac). ``npm run backend:install-ai`` does this for you.
"""
from __future__ import annotations

import importlib.util
import os
import threading

from .device import describe, detect_device
from .interfaces import AIServices
from .stub import (
    StubEmbeddingService,
    StubOCRService,
    StubTaggingService,
    build_stub_services,
)

_services: AIServices | None = None
_build_lock = threading.Lock()


def _insightface_installed() -> bool:
    return importlib.util.find_spec("insightface") is not None


def _build() -> AIServices:
    face_backend = os.environ.get("MEMORA_FACE_BACKEND", "auto").strip().lower()
    want_real = face_backend in ("insightface", "real") or (
        face_backend == "auto" and _insightface_installed()
    )

    if want_real:
        try:
            from .real import RealFaceService

            faces = RealFaceService()
            # InsightFace normed embeddings: same person ≈ 0.45+. Override via
            # MEMORA_FACE_THRESHOLD if you want it looser/tighter.
            threshold = float(os.environ.get("MEMORA_FACE_THRESHOLD", "0.45"))
            print(f"[memora.ai] face backend: InsightFace, providers={faces.active_providers}")
            return AIServices(
                faces=faces,
                tagging=StubTaggingService(),
                ocr=StubOCRService(),
                embeddings=StubEmbeddingService(),
                face_match_threshold=threshold,
                backend="insightface",
                providers=list(faces.active_providers),
            )
        except Exception as e:  # missing package / model download failure
            print(f"[memora.ai] real face backend unavailable ({e}); using stub")

    print("[memora.ai] face backend: stub")
    return build_stub_services()


def get_ai() -> AIServices:
    """Return the active AI service bundle. Built once, thread-safe."""
    global _services
    if _services is None:
        with _build_lock:
            if _services is None:
                print(f"[memora.ai] hardware: {describe(detect_device())}")
                _services = _build()
    return _services


def ai_loaded() -> bool:
    """True once models are built (avoids triggering a slow load just to report)."""
    return _services is not None


def system_info() -> dict:
    """Hardware + backend status for the UI (GPU found, which one is used, hints)."""
    info = detect_device().to_dict()
    face_backend = os.environ.get("MEMORA_FACE_BACKEND", "auto").strip().lower()
    info["face_backend_setting"] = face_backend
    info["insightface_installed"] = _insightface_installed()
    if _services is not None:
        info["active_backend"] = _services.backend
        info["active_providers"] = list(_services.providers)
        # A GPU provider was requested but onnxruntime fell back to CPU.
        info["gpu_in_use"] = any(p != "CPUExecutionProvider" for p in _services.providers)
    else:
        info["active_backend"] = None
        info["active_providers"] = []
        info["gpu_in_use"] = False
    return info
