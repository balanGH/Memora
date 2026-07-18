"""AI service layer.

The rest of the app depends only on the ``Protocol`` interfaces defined in
``interfaces.py``. By default the app wires in deterministic stub
implementations (``stub.py``) so it runs end-to-end with zero model downloads.

To turn on REAL face recognition, set an environment variable before starting
the backend:

    MEMORA_FACE_BACKEND=insightface

(requires ``pip install insightface onnxruntime opencv-python`` — or
``onnxruntime-gpu`` for CUDA). Everything else stays stubbed unless you enable
it too. Swapping an implementation never touches any caller — only this factory.
"""
from __future__ import annotations

import os

from .interfaces import AIServices
from .stub import (
    StubEmbeddingService,
    StubOCRService,
    StubTaggingService,
    build_stub_services,
)

_services: AIServices | None = None


def _build() -> AIServices:
    face_backend = os.environ.get("MEMORA_FACE_BACKEND", "stub").lower()

    if face_backend in ("insightface", "real"):
        try:
            from .real import RealFaceService

            faces = RealFaceService()
            # InsightFace normed embeddings: same person ≈ 0.45+. Override via
            # MEMORA_FACE_THRESHOLD if you want it looser/tighter.
            threshold = float(os.environ.get("MEMORA_FACE_THRESHOLD", "0.45"))
            print("[memora.ai] face backend: InsightFace (real)")
            return AIServices(
                faces=faces,
                tagging=StubTaggingService(),
                ocr=StubOCRService(),
                embeddings=StubEmbeddingService(),
                face_match_threshold=threshold,
            )
        except Exception as e:  # missing package / model download failure
            print(f"[memora.ai] real face backend unavailable ({e}); using stub")

    print("[memora.ai] face backend: stub")
    return build_stub_services()


def get_ai() -> AIServices:
    """Return the active AI service bundle (stub unless a real one is enabled)."""
    global _services
    if _services is None:
        _services = _build()
    return _services
