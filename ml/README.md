# ML sidecar

A small FastAPI service that runs the album's local models on CPU: InsightFace `buffalo_l` for faces (512-d; research-licensed weights), OpenCLIP ViT-B/32 for image embeddings (512-d) and all-MiniLM-L6-v2 for text embeddings (384-d). It publishes no host ports, sits on an internal Docker network, requires the shared `ML_TOKEN` header on every inference route, and writes nothing (image bytes, crops, embeddings) to disk or logs. Models load lazily and unload after `ML_IDLE_UNLOAD_SECONDS` of idleness; one request runs at a time.

Weights are fetched once by the `ml-init` service (`docker compose run --rm ml-init`) into the `ml-models` volume; `/health` reports `models: missing` until then. Air-gapped installs copy the volume contents instead.

Tests run without weights: `pip install -r requirements.txt && pytest` uses `ML_STUB_MODELS=1`, which returns deterministic hash-derived vectors. `pytest -m models` exercises real weights by hand.
