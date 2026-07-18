"""AI service layer.

The rest of the app depends only on the ``Protocol`` interfaces defined in
``interfaces.py``. The vertical slice wires in deterministic stub
implementations (``stub.py``) so the app runs end-to-end with zero model
downloads. Swapping in real InsightFace / YOLO / CLIP / PaddleOCR
implementations later means adding a module that satisfies the same protocols
and changing the factory below — no callers change.
"""
from __future__ import annotations

from .interfaces import AIServices
from .stub import build_stub_services

_services: AIServices | None = None


def get_ai() -> AIServices:
    """Return the active AI service bundle (stub by default)."""
    global _services
    if _services is None:
        _services = build_stub_services()
    return _services
