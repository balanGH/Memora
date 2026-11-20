"""Typed contracts for every AI subsystem.

These Protocols are the seam between the app and the models. Real
implementations (InsightFace, YOLO, CLIP, PaddleOCR) must satisfy them; the
stub implementations in ``stub.py`` do too. Nothing outside ``app.ai`` imports
concrete AI classes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Protocol, Sequence


@dataclass
class BBox:
    """Normalized bounding box (0..1)."""
    x: float
    y: float
    w: float
    h: float


@dataclass
class DetectedFace:
    bbox: BBox
    embedding: list[float]
    # Estimated by the real backend; None for the stub (no age/gender signal).
    age: Optional[float] = None
    gender: Optional[str] = None  # 'M' | 'F'
    # Detector confidence (0..1) when the model reports one.
    score: Optional[float] = None


@dataclass
class DetectedTag:
    kind: str          # 'object' | 'scene' | 'pet'
    label: str
    confidence: float


@dataclass
class AIResult:
    """Everything the pipeline extracted from a single image."""
    faces: list[DetectedFace] = field(default_factory=list)
    tags: list[DetectedTag] = field(default_factory=list)
    ocr_text: str = ""
    clip_embedding: list[float] = field(default_factory=list)


class FaceService(Protocol):
    def detect(self, image_path: Path) -> list[DetectedFace]: ...


class TaggingService(Protocol):
    """Object detection + scene/pet classification."""
    def tag(self, image_path: Path) -> list[DetectedTag]: ...


class OCRService(Protocol):
    def read_text(self, image_path: Path) -> str: ...


class EmbeddingService(Protocol):
    """CLIP-style image/text embeddings for semantic + similar-image search."""
    def embed_image(self, image_path: Path) -> list[float]: ...
    def embed_text(self, query: str) -> list[float]: ...


class DisabledService:
    """Stand-in for a service with no model available: produces nothing.

    Writing *nothing* is the honest result when no model is installed; the
    stub's made-up faces and tags must never reach a real library by default.
    """

    def detect(self, image_path: Path) -> list[DetectedFace]:
        return []

    def tag(self, image_path: Path) -> list[DetectedTag]:
        return []

    def read_text(self, image_path: Path) -> str:
        return ""

    def embed_image(self, image_path: Path) -> list[float]:
        return []

    def embed_text(self, query: str) -> list[float]:
        return []


@dataclass
class AIServices:
    faces: FaceService
    tagging: TaggingService
    ocr: OCRService
    embeddings: EmbeddingService
    # Cosine-similarity threshold above which two faces are the same person.
    # Depends on the embedding space: stub uses ~0.92, InsightFace ~0.45.
    face_match_threshold: float = 0.92
    # Matches within this margin above the threshold are "uncertain" and are
    # listed for manual review instead of being trusted silently (B31).
    face_review_margin: float = 0.08
    # Human-readable name of the face backend ('stub' | 'insightface' | 'none').
    backend: str = "stub"
    # Execution providers actually in use, e.g. ['DmlExecutionProvider', 'CPUExecutionProvider'].
    providers: list[str] = field(default_factory=lambda: ["CPUExecutionProvider"])
    # Model identifier per service ("<family>/<version>"), None = disabled.
    # Stored with every result so incompatible outputs are never mixed (B29).
    face_model: Optional[str] = "stub/v1"
    tags_model: Optional[str] = "stub/v1"
    ocr_model: Optional[str] = "stub/v1"
    embed_model: Optional[str] = "stub/v1"
    # True only for a real image-text model (CLIP-like). Stub hash vectors
    # carry no meaning and must not drive search results.
    semantic_embeddings: bool = False
    # Model initialisation failures, shown in Settings / Processing (B08).
    init_errors: list[str] = field(default_factory=list)

    def models(self) -> dict[str, Optional[str]]:
        return {
            "faces": self.face_model,
            "tags": self.tags_model,
            "ocr": self.ocr_model,
            "embed": self.embed_model,
        }

    def analyze(self, image_path: Path) -> AIResult:
        return AIResult(
            faces=self.faces.detect(image_path) if self.face_model else [],
            tags=self.tagging.tag(image_path) if self.tags_model else [],
            ocr_text=self.ocr.read_text(image_path) if self.ocr_model else "",
            clip_embedding=self.embeddings.embed_image(image_path) if self.embed_model else [],
        )


def cosine_similarity(a: Sequence[float], b: Sequence[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)
