"""HTTP surface of the sidecar. Every request needs the shared token; nothing is written to disk or logs."""
from __future__ import annotations

import os
import threading

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from .models import FACE_DIM, IMAGE_DIM, TEXT_DIM, Models

TOKEN = os.environ.get("ML_TOKEN", "")
MAX_IMAGE_BYTES = int(os.environ.get("ML_MAX_IMAGE_BYTES", str(20 * 1024 * 1024)))

app = FastAPI(title="Family Album ML sidecar", docs_url=None, redoc_url=None, openapi_url=None)
models = Models()


def require_token(x_ml_token: str | None = Header(default=None)) -> None:
    """Fail closed: with no ML_TOKEN configured the sidecar answers nothing but /health."""
    if not TOKEN or x_ml_token != TOKEN:
        raise HTTPException(status_code=401, detail="missing or wrong token")


async def read_image(file: UploadFile) -> bytes:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty image")
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="image too large")
    return data


class TextRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=64)


class Health(BaseModel):
    ok: bool
    models: str
    dims: dict[str, int]


def _locked(fn, *args):
    """Run one inference call under the model lock (one request at a time keeps memory flat)."""
    with models.lock:
        return fn(*args)


@app.get("/health", response_model=Health)
def health() -> Health:
    models.maybe_unload()
    return Health(ok=True, models=models.status(), dims={"image": IMAGE_DIM, "text": TEXT_DIM, "face": FACE_DIM})


@app.post("/embed/image", dependencies=[Depends(require_token)])
async def embed_image(file: UploadFile = File(...)) -> dict:
    data = await read_image(file)
    # Inference (and the first lazy model load) runs off the event loop so /health keeps answering meanwhile.
    vec = await run_in_threadpool(_locked, models.embed_image, data)
    return {"embedding": vec, "dim": IMAGE_DIM}


@app.post("/embed/text", dependencies=[Depends(require_token)])
def embed_text(body: TextRequest) -> dict:
    with models.lock:
        vecs = models.embed_text(body.texts)
    return {"embeddings": vecs, "dim": TEXT_DIM}


@app.post("/faces", dependencies=[Depends(require_token)])
async def faces(file: UploadFile = File(...)) -> dict:
    data = await read_image(file)
    found = await run_in_threadpool(_locked, models.faces, data)
    return {"faces": [{"box": list(f.box), "confidence": f.confidence, "embedding": f.embedding, "age": f.age} for f in found], "dim": FACE_DIM}


@app.post("/animals", dependencies=[Depends(require_token)])
async def animals(file: UploadFile = File(...)) -> dict:
    """Animals with species and a crop embedding. Needs the detector weights from ml-init (503 until then)."""
    data = await read_image(file)
    if not models.detector_present():
        raise HTTPException(status_code=503, detail="animal detector weights missing; run ml-init again")
    found = await run_in_threadpool(_locked, models.animals, data)
    return {"animals": [{"box": list(a.box), "species": a.species, "confidence": a.confidence, "embedding": a.embedding} for a in found], "dim": IMAGE_DIM}


def _unloader() -> None:
    import time

    while True:
        time.sleep(30)
        models.maybe_unload()


threading.Thread(target=_unloader, daemon=True).start()
