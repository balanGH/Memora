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

        from .device import detect_device

        info = detect_device()
        self.device = info
        self._app = FaceAnalysis(name=model_name, providers=info.providers)
        # ctx_id >= 0 keeps the GPU provider; -1 makes InsightFace pin to CPU.
        self._app.prepare(ctx_id=0 if info.is_gpu else -1, det_size=(det_size, det_size))
        # onnxruntime silently falls back to CPU when a GPU provider fails to
        # initialise (missing CUDA/cuDNN, old driver). Report what really runs.
        self.active_providers = self._session_providers() or info.providers

    def _session_providers(self) -> list[str]:
        for model in getattr(self._app, "models", {}).values():
            session = getattr(model, "session", None)
            if session is not None:
                try:
                    return list(session.get_providers())
                except Exception:
                    return []
        return []

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
            # buffalo_l's genderage model fills these; guard in case it's absent.
            age = getattr(f, "age", None)
            gender = None
            sex = getattr(f, "sex", None)  # 'M' / 'F'
            if sex in ("M", "F"):
                gender = sex
            else:
                g = getattr(f, "gender", None)  # 1 = male, 0 = female
                if g is not None:
                    gender = "M" if int(g) == 1 else "F"
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
                    age=float(age) if age is not None else None,
                    gender=gender,
                )
            )
        return results
