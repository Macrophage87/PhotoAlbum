"""One-time weight download, run by the `ml-init` compose service on the default network:
`docker compose run --rm ml-init`. The `ml` service itself sits on an internal network with no outbound access.
"""
from __future__ import annotations

import os
import sys

MODEL_DIR = os.environ.get("ML_MODEL_DIR", "/models")


def main() -> int:
    os.makedirs(MODEL_DIR, exist_ok=True)
    print(f"[ml-init] downloading weights into {MODEL_DIR}")
    import open_clip
    from huggingface_hub import hf_hub_download
    from insightface.app import FaceAnalysis
    from sentence_transformers import SentenceTransformer

    clip_dir = os.path.join(MODEL_DIR, "clip")
    os.makedirs(clip_dir, exist_ok=True)
    hf_hub_download("laion/CLIP-ViT-B-32-laion2B-s34B-b79K", "open_clip_pytorch_model.bin", local_dir=clip_dir)
    open_clip.create_model_and_transforms("ViT-B-32", pretrained=os.path.join(clip_dir, "open_clip_pytorch_model.bin"))
    SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2").save(os.path.join(MODEL_DIR, "minilm"))
    FaceAnalysis(name="buffalo_l", root=os.path.join(MODEL_DIR, "insightface"), providers=["CPUExecutionProvider"]).prepare(ctx_id=0)
    # Animals: torchvision's small Faster R-CNN (COCO), saved as a plain state dict so the runtime never needs the hub.
    import torch
    from torchvision.models.detection import fasterrcnn_mobilenet_v3_large_320_fpn

    detector_dir = os.path.join(MODEL_DIR, "detector")
    os.makedirs(detector_dir, exist_ok=True)
    detector = fasterrcnn_mobilenet_v3_large_320_fpn(weights="DEFAULT")
    torch.save(detector.state_dict(), os.path.join(detector_dir, "fasterrcnn_mobilenet_v3_large_320_fpn.pth"))
    print("[ml-init] done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
