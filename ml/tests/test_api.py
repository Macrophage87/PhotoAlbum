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


def test_animals_answers_503_until_the_detector_weights_are_there(monkeypatch, tmp_path):
    import ml.models as m

    monkeypatch.setattr(m, "STUB", False)
    monkeypatch.setattr(m, "MODEL_DIR", str(tmp_path))
    r = client.post("/animals", files={"file": ("a.png", png(), "image/png")}, headers=HEADERS)
    assert r.status_code == 503
    assert "detector weights missing" in r.json()["detail"]
    # The token is still checked first: a stranger learns nothing about the weights.
    assert client.post("/animals", files={"file": ("a.png", png(), "image/png")}).status_code == 401
    (tmp_path / "detector").mkdir()
    (tmp_path / "detector" / m.DETECTOR_FILE).write_bytes(b"")
    assert m.Models.detector_present()


class _NoGrad:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Tensor:
    """Just enough of a torch tensor for Models.animals to turn the picture into the detector's input."""

    def __init__(self, arr):
        self.arr = arr

    def permute(self, *dims):
        return _Tensor(self.arr.transpose(dims))

    def float(self):
        return _Tensor(self.arr.astype("float32"))

    def __truediv__(self, n):
        return _Tensor(self.arr / n)


class _Listy:
    def __init__(self, values):
        self.values = values

    def tolist(self):
        return list(self.values)


def test_real_animals_path_maps_coco_labels_filters_scores_and_crops(monkeypatch):
    """The real (non-stub) detector path, with torch and the weights stood in for: CI has neither. What is under test
    is what the album does with the detector's answer: COCO labels to species, the minimum score, fractional boxes,
    a padded crop clamped to the frame for the embedding, and the cap of eight."""
    import sys
    import types

    import ml.models as m

    fake_torch = types.SimpleNamespace(from_numpy=_Tensor, no_grad=_NoGrad)
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setattr(m, "STUB", False)
    monkeypatch.setattr(m, "ANIMAL_MIN_SCORE", 0.6)

    seen_inputs = []
    boxes = [
        (10.0, 20.0, 30.0, 40.0),  # dog (COCO 18), inside the frame
        (0.0, 0.0, 50.0, 48.0),  # cat (COCO 17), padding would run off every edge
        (5.0, 5.0, 15.0, 15.0),  # person (COCO 1): not an animal the album knows
        (5.0, 5.0, 15.0, 15.0),  # horse (COCO 19) below the minimum score
        (1.0, 2.0, 3.0, 4.0),  # bird (COCO 16) -> CHICKEN
        (1.0, 2.0, 3.0, 4.0),  # bear (COCO 23) -> OTHER
    ]
    labels = [18, 17, 1, 19, 16, 23]
    scores = [0.95, 0.7, 0.99, 0.59, 0.6, 0.8]

    def detector(inputs):
        seen_inputs.extend(inputs)
        return [{"boxes": _Listy(boxes), "labels": _Listy(labels), "scores": _Listy(scores)}]

    crops = []

    def clip_embed(image):
        crops.append(image.size)
        return [1.0] + [0.0] * (m.IMAGE_DIM - 1)

    models = m.Models()
    models._detector = detector
    monkeypatch.setattr(models, "_clip_embed", clip_embed)

    found = models.animals(png())  # 64 x 48

    # The detector is given the picture as channels-first floats in 0..1.
    assert seen_inputs[0].arr.shape == (3, 48, 64)
    assert 0 <= seen_inputs[0].arr.min() and seen_inputs[0].arr.max() <= 1
    assert [a.species for a in found] == ["DOG", "CAT", "CHICKEN", "OTHER"]
    assert [a.confidence for a in found] == [0.95, 0.7, 0.6, 0.8]
    dog, cat = found[0], found[1]
    assert dog.box == pytest.approx((10 / 64, 20 / 48, 20 / 64, 20 / 48))
    assert cat.box == pytest.approx((0, 0, 50 / 64, 1))
    # 10 % padding of the longer side around the dog (20 px -> 2 px each way); the cat's is clamped to the frame.
    assert crops[0] == (24, 24)
    assert crops[1] == (55, 48)
    assert len(dog.embedding) == m.IMAGE_DIM

    # Never more than eight animals, however many the detector reports.
    boxes[:] = [(1.0, 1.0, 9.0, 9.0)] * 12
    labels[:] = [18] * 12
    scores[:] = [0.9] * 12
    assert len(models.animals(png())) == 8


def test_empty_and_oversized_images_are_refused():
    assert client.post("/embed/image", files={"file": ("a.png", b"", "image/png")}, headers=HEADERS).status_code == 400


@pytest.mark.models
def test_real_models_load():
    os.environ["ML_STUB_MODELS"] = "0"
    from ml.models import Models

    assert Models().weights_present()
