"""Typed contracts for every AI subsystem.

These Protocols are the seam between the app and the models. Real
implementations (InsightFace, YOLO, CLIP, PaddleOCR) must satisfy them; the
stub implementations in ``stub.py`` do too. Nothing outside ``app.ai`` imports
concrete AI classes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, Sequence


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


@dataclass
class AIServices:
    faces: FaceService
    tagging: TaggingService
    ocr: OCRService
    embeddings: EmbeddingService
    # Cosine-similarity threshold above which two faces are the same person.
    # Depends on the embedding space: stub uses ~0.92, InsightFace ~0.45.
    face_match_threshold: float = 0.92

    def analyze(self, image_path: Path) -> AIResult:
        return AIResult(
            faces=self.faces.detect(image_path),
            tags=self.tagging.tag(image_path),
            ocr_text=self.ocr.read_text(image_path),
            clip_embedding=self.embeddings.embed_image(image_path),
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
