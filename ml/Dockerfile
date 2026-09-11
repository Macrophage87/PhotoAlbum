# syntax=docker/dockerfile:1
# Family Album ML sidecar: CPU-only inference, no host ports, internal network only. Weights live in the ml-models volume.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 ML_MODEL_DIR=/models HF_HOME=/models/hf
WORKDIR /srv
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt requirements-models.txt ./
RUN pip install --no-cache-dir -r requirements.txt && pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu -r requirements-models.txt
COPY ml ./ml
RUN useradd -r -u 10001 mluser && mkdir -p /models && chown -R mluser /models
USER mluser
VOLUME ["/models"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/health')" || exit 1
CMD ["uvicorn", "ml.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
