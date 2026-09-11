"""Model loading with a deterministic stub mode.

Real mode loads InsightFace buffalo_l (faces, 512-d), OpenCLIP ViT-B/32 (image embeddings, 512-d) and
all-MiniLM-L6-v2 (text embeddings, 384-d) lazily on first use and unloads them after ML_IDLE_UNLOAD_SECONDS.
Stub mode (ML_STUB_MODELS=1) returns embeddings derived from a hash of the input, so the same bytes always
produce the same vector and tests never need weights.
"""
from __future__ import annotations

import hashlib
import io
import os
import threading
import time
from dataclasses import dataclass

import numpy as np
from PIL import Image

IMAGE_DIM = 512
FACE_DIM = 512
TEXT_DIM = 384

STUB = os.environ.get("ML_STUB_MODELS", "0") in {"1", "true", "yes"}
MODEL_DIR = os.environ.get("ML_MODEL_DIR", "/models")
IDLE_UNLOAD_SECONDS = int(os.environ.get("ML_IDLE_UNLOAD_SECONDS", "300"))


@dataclass
class Face:
    box: tuple[float, float, float, float]  # x, y, w, h as fractions of the image
    confidence: float
    embedding: list[float]
    age: float | None


def _unit(vec: np.ndarray) -> list[float]:
    norm = np.linalg.norm(vec)
    return (vec / norm if norm else vec).astype(float).tolist()


def _seeded(seed_bytes: bytes, dim: int, salt: str) -> list[float]:
    digest = hashlib.sha256(salt.encode() + seed_bytes).digest()
    rng = np.random.default_rng(int.from_bytes(digest[:8], "little"))
    return _unit(rng.standard_normal(dim))


def _open(image_bytes: bytes) -> Image.Image:
    return Image.open(io.BytesIO(image_bytes)).convert("RGB")


class Models:
    """Holds the loaded models behind one lock; only one request runs inference at a time."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.last_used = time.monotonic()
        self._clip = None
        self._text = None
        self._faces = None

    # ---- lifecycle ----
    def status(self) -> str:
        if STUB:
            return "stub"
        return "loaded" if (self._clip or self._text or self._faces) else ("missing" if not self.weights_present() else "idle")

    @staticmethod
    def weights_present() -> bool:
        return STUB or os.path.isdir(os.path.join(MODEL_DIR, "insightface")) and os.path.isdir(os.path.join(MODEL_DIR, "clip"))

    def maybe_unload(self) -> None:
        if STUB or time.monotonic() - self.last_used < IDLE_UNLOAD_SECONDS:
            return
        # Never wait on a running inference: /health must answer within its timeout.
        if not self.lock.acquire(blocking=False):
            return
        try:
            self._clip = self._text = self._faces = None
        finally:
            self.lock.release()

    def _touch(self) -> None:
        self.last_used = time.monotonic()

    # ---- image embeddings ----
    def embed_image(self, image_bytes: bytes) -> list[float]:
        self._touch()
        if STUB:
            # Stable per input, but stable across renditions of the same picture is not required in stub mode.
            return _seeded(image_bytes, IMAGE_DIM, "image")
        import torch  # noqa: WPS433 (heavy import kept local)

        if self._clip is None:
            import open_clip

            model, _, preprocess = open_clip.create_model_and_transforms("ViT-B-32", pretrained=os.path.join(MODEL_DIR, "clip", "open_clip_pytorch_model.bin"))
            model.eval()
            self._clip = (model, preprocess)
        model, preprocess = self._clip
        with torch.no_grad():
            tensor = preprocess(_open(image_bytes)).unsqueeze(0)
            vec = model.encode_image(tensor)[0].cpu().numpy()
        return _unit(vec)

    # ---- text embeddings ----
    def embed_text(self, texts: list[str]) -> list[list[float]]:
        self._touch()
        if STUB:
            return [_seeded(t.strip().lower().encode(), TEXT_DIM, "text") for t in texts]
        if self._text is None:
            from sentence_transformers import SentenceTransformer

            self._text = SentenceTransformer(os.path.join(MODEL_DIR, "minilm"), device="cpu")
        vecs = self._text.encode(texts, normalize_embeddings=True)
        return [v.astype(float).tolist() for v in vecs]

    # ---- faces ----
    def faces(self, image_bytes: bytes) -> list[Face]:
        self._touch()
        if STUB:
            # One face per image, derived from the bytes so the same picture always yields the same template;
            # pictures whose bytes hash to an even first byte get a second, different face.
            digest = hashlib.sha256(image_bytes).digest()
            faces = [Face(box=(0.3, 0.2, 0.25, 0.35), confidence=0.98, embedding=_seeded(image_bytes, FACE_DIM, "face"), age=34.0)]
            if digest[0] % 2 == 0:
                faces.append(Face(box=(0.6, 0.25, 0.2, 0.3), confidence=0.91, embedding=_seeded(image_bytes, FACE_DIM, "face2"), age=7.0))
            return faces
        if self._faces is None:
            from insightface.app import FaceAnalysis

            app = FaceAnalysis(name="buffalo_l", root=os.path.join(MODEL_DIR, "insightface"), providers=["CPUExecutionProvider"])
            app.prepare(ctx_id=0, det_size=(640, 640))
            self._faces = app
        img = np.asarray(_open(image_bytes))[:, :, ::-1]  # RGB -> BGR for insightface
        h, w = img.shape[:2]
        out: list[Face] = []
        for f in self._faces.get(img):
            x1, y1, x2, y2 = [float(v) for v in f.bbox]
            out.append(Face(box=(x1 / w, y1 / h, (x2 - x1) / w, (y2 - y1) / h), confidence=float(f.det_score), embedding=_unit(np.asarray(f.normed_embedding)), age=float(f.age) if getattr(f, "age", None) is not None else None))
        return out
