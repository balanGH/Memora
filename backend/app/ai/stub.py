"""Deterministic stub AI implementations.

No models, no downloads, no randomness that changes across runs. Outputs are
derived from a hash of the file path so the same image always yields the same
faces/tags/embedding — enough to exercise People, Search, and similar-image UI
end-to-end. Replace these with real model-backed classes later; callers won't
change.
"""
from __future__ import annotations

import hashlib
import math
from pathlib import Path

from .interfaces import (
    AIServices,
    BBox,
    DetectedFace,
    DetectedTag,
)

# A small vocabulary the stub "detects" so search has something to match.
_OBJECTS = ["dog", "cat", "car", "laptop", "cup", "bicycle", "book", "phone", "tree", "chair"]
_SCENES = ["beach", "mountain", "city", "sunset", "indoor", "forest", "party", "food"]
_PETS = ["dog", "cat"]

_EMBED_DIM = 64


def _seed(path: Path) -> int:
    return int(hashlib.sha1(str(path).encode("utf-8")).hexdigest(), 16)


class StubFaceService:
    def detect(self, image_path: Path) -> list[DetectedFace]:
        seed = _seed(image_path)
        n = seed % 4  # 0..3 faces
        faces: list[DetectedFace] = []
        for i in range(n):
            s = seed >> (i * 8)
            # Assign to one of 6 synthetic identities via the embedding.
            identity = (s % 6)
            emb = _identity_embedding(identity, s)
            faces.append(
                DetectedFace(
                    bbox=BBox(
                        x=(s % 60) / 100.0,
                        y=((s >> 4) % 60) / 100.0,
                        w=0.15,
                        h=0.15,
                    ),
                    embedding=emb,
                )
            )
        return faces


class StubTaggingService:
    def tag(self, image_path: Path) -> list[DetectedTag]:
        seed = _seed(image_path)
        tags: list[DetectedTag] = []
        # 1-2 objects
        obj = _OBJECTS[seed % len(_OBJECTS)]
        tags.append(DetectedTag("object", obj, 0.6 + (seed % 40) / 100.0))
        if seed % 3 == 0:
            obj2 = _OBJECTS[(seed >> 8) % len(_OBJECTS)]
            if obj2 != obj:
                tags.append(DetectedTag("object", obj2, 0.55))
        # scene
        tags.append(DetectedTag("scene", _SCENES[seed % len(_SCENES)], 0.7))
        # pet, sometimes
        if obj in _PETS:
            tags.append(DetectedTag("pet", obj, 0.8))
        return tags


class StubOCRService:
    _SNIPPETS = ["", "HAPPY BIRTHDAY", "SALE 50% OFF", "WELCOME", "EXIT", "OPEN"]

    def read_text(self, image_path: Path) -> str:
        seed = _seed(image_path)
        return self._SNIPPETS[seed % len(self._SNIPPETS)]


class StubEmbeddingService:
    def embed_image(self, image_path: Path) -> list[float]:
        return _hash_vector(str(image_path))

    def embed_text(self, query: str) -> list[float]:
        # Same hashing scheme so text and image land in the same space.
        return _hash_vector(query.lower().strip())


def _hash_vector(text: str) -> list[float]:
    """Deterministic pseudo-embedding derived from a hash, L2-normalized."""
    vec: list[float] = []
    data = text.encode("utf-8")
    counter = 0
    while len(vec) < _EMBED_DIM:
        h = hashlib.sha256(data + counter.to_bytes(4, "little")).digest()
        for b in h:
            vec.append((b - 127.5) / 127.5)
            if len(vec) >= _EMBED_DIM:
                break
        counter += 1
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


def _identity_embedding(identity: int, salt: int) -> list[float]:
    base = _hash_vector(f"person-{identity}")
    # tiny jitter so faces of the same identity cluster but aren't identical
    jitter = _hash_vector(f"jitter-{salt}")
    mixed = [0.95 * b + 0.05 * j for b, j in zip(base, jitter)]
    norm = math.sqrt(sum(v * v for v in mixed)) or 1.0
    return [v / norm for v in mixed]


def build_stub_services() -> AIServices:
    return AIServices(
        faces=StubFaceService(),
        tagging=StubTaggingService(),
        ocr=StubOCRService(),
        embeddings=StubEmbeddingService(),
    )
