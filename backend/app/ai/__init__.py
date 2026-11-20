"""AI service layer.

The rest of the app depends only on the ``Protocol`` interfaces defined in
``interfaces.py``. Swapping an implementation never touches any caller, only
this factory.

Backend selection
-----------------

``MEMORA_AI_BACKEND`` (all services):

* ``auto`` (default): real models where installed, otherwise the service is
  **disabled** (produces nothing). Never fabricates results.
* ``stub``: deterministic fake models for every service (demos, UI work,
  tests). Its output is labelled ``stub/v1`` and can be purged later.
* ``none``: every service disabled.

``MEMORA_FACE_BACKEND`` (faces only, overrides the above for faces):

* ``auto`` (default): InsightFace if installed, else follow MEMORA_AI_BACKEND.
* ``insightface`` / ``real``: require InsightFace (disabled, with the error
  shown in the UI, if it can't load).
* ``stub`` / ``none``: as above.

Install for real faces: ``npm run backend:install-ai`` (InsightFace + the
onnxruntime build that matches your GPU). Object detection, OCR and semantic
search have no real model wired yet; see AI_SETUP.md.
"""
from __future__ import annotations

import importlib.util
import os
import threading

from .device import describe, detect_device
from .interfaces import AIServices, DisabledService
from .stub import (
    StubEmbeddingService,
    StubFaceService,
    StubOCRService,
    StubTaggingService,
)

STUB_MODEL = "stub/v1"
INSIGHTFACE_MODEL = "insightface/buffalo_l"

_services: AIServices | None = None
_build_lock = threading.Lock()


def _insightface_installed() -> bool:
    return importlib.util.find_spec("insightface") is not None


def _setting(name: str, default: str = "auto") -> str:
    return os.environ.get(name, default).strip().lower() or default


def _build() -> AIServices:
    ai_backend = _setting("MEMORA_AI_BACKEND")
    face_backend = _setting("MEMORA_FACE_BACKEND")
    errors: list[str] = []
    disabled = DisabledService()

    stub_all = ai_backend == "stub"
    services = AIServices(
        faces=disabled, tagging=disabled, ocr=disabled, embeddings=disabled,
        face_model=None, tags_model=None, ocr_model=None, embed_model=None,
        backend="none", providers=[], semantic_embeddings=False,
    )

    # ---- faces
    want_real = face_backend in ("insightface", "real") or (
        face_backend == "auto" and ai_backend != "none" and _insightface_installed()
    )
    if want_real:
        try:
            from .real import RealFaceService

            faces = RealFaceService()
            services.faces = faces
            services.face_model = INSIGHTFACE_MODEL
            # InsightFace normed embeddings: same person ≈ 0.45+.
            services.face_match_threshold = float(os.environ.get("MEMORA_FACE_THRESHOLD", "0.45"))
            services.backend = "insightface"
            services.providers = list(faces.active_providers)
            print(f"[memora.ai] face backend: InsightFace, providers={faces.active_providers}")
        except Exception as e:  # missing package / model download failure
            errors.append(f"Face recognition (InsightFace) failed to load: {type(e).__name__}: {e}")
            print(f"[memora.ai] real face backend unavailable ({type(e).__name__})")
    elif face_backend == "stub" or (face_backend == "auto" and stub_all):
        services.faces = StubFaceService()
        services.face_model = STUB_MODEL
        services.face_match_threshold = 0.92
        services.backend = "stub"
        services.providers = ["CPUExecutionProvider"]

    # ---- tagging / OCR / embeddings: only the stub exists today.
    if stub_all:
        services.tagging, services.tags_model = StubTaggingService(), STUB_MODEL
        services.ocr, services.ocr_model = StubOCRService(), STUB_MODEL
        services.embeddings, services.embed_model = StubEmbeddingService(), STUB_MODEL

    if os.environ.get("MEMORA_FACE_THRESHOLD") and services.face_model:
        services.face_match_threshold = float(os.environ["MEMORA_FACE_THRESHOLD"])
    services.init_errors = errors
    print(f"[memora.ai] models: {services.models()}")
    return services


def get_ai() -> AIServices:
    """Return the active AI service bundle. Built once, thread-safe."""
    global _services
    if _services is None:
        with _build_lock:
            if _services is None:
                print(f"[memora.ai] hardware: {describe(detect_device())}")
                _services = _build()
    return _services


def reset_services() -> None:
    """Forget the built services (tests; settings changes)."""
    global _services
    with _build_lock:
        _services = None


def ai_loaded() -> bool:
    """True once models are built (avoids triggering a slow load just to report)."""
    return _services is not None


def system_info() -> dict:
    """Hardware + backend status for the UI (GPU found, which one is used, hints)."""
    info = detect_device().to_dict()
    info["face_backend_setting"] = _setting("MEMORA_FACE_BACKEND")
    info["ai_backend_setting"] = _setting("MEMORA_AI_BACKEND")
    info["insightface_installed"] = _insightface_installed()
    if _services is not None:
        info["active_backend"] = _services.backend
        info["active_providers"] = list(_services.providers)
        # A GPU provider was requested but onnxruntime fell back to CPU.
        info["gpu_in_use"] = any(p != "CPUExecutionProvider" for p in _services.providers)
        info["models"] = _services.models()
        info["semantic_search"] = _services.semantic_embeddings
        info["ai_init_errors"] = list(_services.init_errors)
    else:
        info["active_backend"] = None
        info["active_providers"] = []
        info["gpu_in_use"] = False
        info["models"] = None
        info["semantic_search"] = False
        info["ai_init_errors"] = []
    return info
