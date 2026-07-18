"""Real, model-backed AI implementations.

Only imported when a real backend is explicitly enabled (see ``get_ai`` in
``__init__.py``), so the stub build never needs these heavy packages. Each class
satisfies the same Protocol as its stub counterpart, so nothing else changes.

Face recognition uses InsightFace (buffalo_l): detection + 512-d normalized
embeddings. On first use InsightFace downloads its model (~300 MB) to
``~/.insightface/models`` — that one download needs internet; everything after
is fully offline.
"""
from __future__ import annotations

from pathlib import Path

from .interfaces import BBox, DetectedFace


class RealFaceService:
    """InsightFace-backed face detection + embeddings."""

    def __init__(self, model_name: str = "buffalo_l", det_size: int = 640) -> None:
        # Imports are deferred to construction so the module is importable even
        # when the packages are missing (we only build this when enabled).
        from insightface.app import FaceAnalysis  # type: ignore
        import onnxruntime as ort  # type: ignore

        available = ort.get_available_providers()
        # Prefer GPU if the CUDA provider is present; always keep CPU fallback.
        providers = (
            ["CUDAExecutionProvider", "CPUExecutionProvider"]
            if "CUDAExecutionProvider" in available
            else ["CPUExecutionProvider"]
        )
        self._app = FaceAnalysis(name=model_name, providers=providers)
        self._app.prepare(ctx_id=0, det_size=(det_size, det_size))

    def _read_bgr(self, image_path: Path):
        import cv2  # type: ignore
        import numpy as np  # type: ignore

        img = cv2.imread(str(image_path))  # BGR, handles most formats
        if img is None:
            # Fallback for formats OpenCV can't decode (e.g. some HEIC/WebP).
            from PIL import Image

            with Image.open(image_path) as im:
                img = cv2.cvtColor(np.array(im.convert("RGB")), cv2.COLOR_RGB2BGR)
        return img

    def detect(self, image_path: Path) -> list[DetectedFace]:
        try:
            img = self._read_bgr(image_path)
        except Exception:
            return []
        if img is None:
            return []

        h, w = img.shape[:2]
        if not h or not w:
            return []

        faces = self._app.get(img)
        results: list[DetectedFace] = []
        for f in faces:
            x1, y1, x2, y2 = [float(v) for v in f.bbox]
            bw = max(0.0, x2 - x1)
            bh = max(0.0, y2 - y1)
            results.append(
                DetectedFace(
                    bbox=BBox(
                        x=min(max(x1 / w, 0.0), 1.0),
                        y=min(max(y1 / h, 0.0), 1.0),
                        w=min(bw / w, 1.0),
                        h=min(bh / h, 1.0),
                    ),
                    # normed_embedding is already L2-normalized (512-d).
                    embedding=f.normed_embedding.astype(float).tolist(),
                )
            )
        return results
