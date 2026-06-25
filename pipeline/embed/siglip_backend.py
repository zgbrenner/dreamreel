"""SigLIP 2 image+text embeddings via HuggingFace transformers (operational only, Apache-2.0).

SigLIP 2 (google/siglip2-so400m-patch14-384) is a stronger image-text encoder than the production
OpenCLIP ViT-B/32 — higher zero-shot accuracy and retrieval — so it yields better mood-axis
projections and better walk neighbours. It is a DIFFERENT, higher-dimensional space (so re-embedding
replaces every visual+text embedding and the 12 mood axes; see embed/reembed_siglip.py).

Like clap_transformers, this is NOT wired into the unit-tested backend; it lazy-imports torch +
transformers (the `embed` extra) and is used only by the operational re-embed tool. The `embed_texts`
duck-types embed/mood_axes.build_axes, and `embed_images` mirrors the CLIP image path.
"""

from __future__ import annotations

from typing import Sequence

import numpy as np

from .clip_backend import l2_normalize

# Default to the base checkpoint (768-d, ~375 MB) — it downloads reliably and already beats the
# production OpenCLIP ViT-B/32 substantially. The so400m-patch14-384 (1152-d) is stronger still but
# ~3.5 GB; pass it via reembed_siglip --model when bandwidth allows.
MODEL_ID = "google/siglip2-base-patch16-224"
MODEL_ID_SO400M = "google/siglip2-so400m-patch14-384"


class SiglipEmbedder:
    backend = "siglip2"

    def __init__(self, model_id: str = MODEL_ID) -> None:
        import torch  # lazy
        from transformers import AutoModel, AutoProcessor

        self._torch = torch
        self.model = AutoModel.from_pretrained(model_id).eval()
        self.processor = AutoProcessor.from_pretrained(model_id)
        self.dim = 0
        # Probe the joint-space dimension once (so400m → 1152).
        self.dim = int(self.embed_texts(["a calibration probe"]).shape[1])

    def _pool(self, out):
        # transformers 5.x returns a BaseModelOutputWithPooling for SigLIP2's get_*_features;
        # the joint-space embedding is pooler_output. Older versions return the tensor directly.
        if self._torch.is_tensor(out):
            return out
        if getattr(out, "pooler_output", None) is not None:
            return out.pooler_output
        return out.last_hidden_state[:, 0]

    def embed_texts(self, texts: Sequence[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), np.float32)
        torch = self._torch
        # SigLIP text tower expects fixed-length ("max_length") padding.
        inputs = self.processor(
            text=list(texts), padding="max_length", truncation=True, return_tensors="pt"
        )
        with torch.no_grad():
            feats = self._pool(self.model.get_text_features(**inputs)).cpu().numpy()
        return l2_normalize(feats.astype(np.float32))

    def embed_images(self, paths: Sequence[str]) -> list[np.ndarray | None]:
        """Embed each image path; a row is None on read/decode failure (caller keeps alignment)."""
        from PIL import Image

        torch = self._torch
        out: list[np.ndarray | None] = []
        for p in paths:
            try:
                img = Image.open(p).convert("RGB")
                inputs = self.processor(images=img, return_tensors="pt")
                with torch.no_grad():
                    f = self._pool(self.model.get_image_features(**inputs)).cpu().numpy()
                out.append(l2_normalize(f.astype(np.float32))[0])
            except Exception:
                out.append(None)
        return out


def get_siglip_embedder(model_id: str = MODEL_ID) -> SiglipEmbedder | None:
    """Return a SigLIP 2 embedder, or None if transformers/torch/checkpoint are unavailable."""
    try:
        return SiglipEmbedder(model_id)
    except Exception as exc:  # noqa: BLE001 — any import/download/load failure → caller reports
        print(f"[siglip] unavailable ({exc})")
        return None
