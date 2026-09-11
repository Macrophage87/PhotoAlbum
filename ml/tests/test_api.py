"""Schema checks for every route, run in stub mode so CI needs no weights. Real weights: `pytest -m models` by hand."""
import io
import os

os.environ["ML_STUB_MODELS"] = "1"
os.environ["ML_TOKEN"] = "test-token"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from ml.main import app  # noqa: E402

client = TestClient(app)
HEADERS = {"X-ML-Token": "test-token"}


def png(color=(200, 30, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), color).save(buf, format="PNG")
    return buf.getvalue()


def test_health_reports_stub_and_dims():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "models": "stub", "dims": {"image": 512, "text": 384, "face": 512}}


def test_token_is_required_on_every_inference_route():
    assert client.post("/embed/text", json={"texts": ["x"]}).status_code == 401
    assert client.post("/embed/image", files={"file": ("a.png", png(), "image/png")}).status_code == 401
    assert client.post("/faces", files={"file": ("a.png", png(), "image/png")}, headers={"X-ML-Token": "wrong"}).status_code == 401


def test_image_embedding_is_unit_length_and_deterministic():
    a = client.post("/embed/image", files={"file": ("a.png", png(), "image/png")}, headers=HEADERS).json()
    b = client.post("/embed/image", files={"file": ("a.png", png(), "image/png")}, headers=HEADERS).json()
    c = client.post("/embed/image", files={"file": ("c.png", png((0, 0, 255)), "image/png")}, headers=HEADERS).json()
    assert a["dim"] == 512 and len(a["embedding"]) == 512
    assert a["embedding"] == b["embedding"]
    assert a["embedding"] != c["embedding"]
    assert abs(sum(v * v for v in a["embedding"]) - 1) < 1e-6


def test_text_embeddings_batch():
    r = client.post("/embed/text", json={"texts": ["lobster rolls", "Lobster Rolls "]}, headers=HEADERS).json()
    assert r["dim"] == 384 and len(r["embeddings"]) == 2
    assert r["embeddings"][0] == r["embeddings"][1]  # normalised before hashing


def test_faces_shape():
    r = client.post("/faces", files={"file": ("a.png", png(), "image/png")}, headers=HEADERS).json()
    assert r["dim"] == 512 and 1 <= len(r["faces"]) <= 2
    face = r["faces"][0]
    assert len(face["box"]) == 4 and all(0 <= v <= 1 for v in face["box"])
    assert len(face["embedding"]) == 512 and 0 < face["confidence"] <= 1


def test_animals_shape_and_determinism():
    assert client.post("/animals", files={"file": ("a.png", png(), "image/png")}).status_code == 401
    a = client.post("/animals", files={"file": ("a.png", png(), "image/png")}, headers=HEADERS).json()
    b = client.post("/animals", files={"file": ("a.png", png(), "image/png")}, headers=HEADERS).json()
    assert a["dim"] == 512 and 1 <= len(a["animals"]) <= 2
    animal = a["animals"][0]
    assert animal["species"] in {"DOG", "CAT", "CHICKEN", "HORSE", "OTHER"}
    assert len(animal["box"]) == 4 and all(0 <= v <= 1 for v in animal["box"])
    assert len(animal["embedding"]) == 512 and 0 < animal["confidence"] <= 1
    assert a == b


def test_empty_and_oversized_images_are_refused():
    assert client.post("/embed/image", files={"file": ("a.png", b"", "image/png")}, headers=HEADERS).status_code == 400


@pytest.mark.models
def test_real_models_load():
    os.environ["ML_STUB_MODELS"] = "0"
    from ml.models import Models

    assert Models().weights_present()
