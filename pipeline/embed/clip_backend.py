"""CLIP backend with a deterministic offline fallback.

Production uses open_clip (ViT-B/32, 512-dim) for real image+text embeddings in a shared
space. When torch/open_clip aren't installed (CI, or a quick offline manifest build), we fall
back to a deterministic hashing embedder so the pipeline still produces a *structurally valid*
manifest the app's zod loader accepts. The fallback is clearly not semantic — it exists so the
end-to-end plumbing and schema can be exercised without a GPU.
"""

from __future__ import annotations

import hashlib
from typing import Protocol, Sequence

import numpy as np


def l2_normalize(x: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(x, axis=-1, keepdims=True)
    n[n == 0] = 1.0
    return x / n


class Embedder(Protocol):
    dim: int
    backend: str

    def embed_texts(self, texts: Sequence[str]) -> np.ndarray: ...
    def embed_images(self, paths: Sequence[str]) -> np.ndarray: ...


class _HashEmbedder:
    """Deterministic, non-semantic embeddings derived from content hashes (offline fallback)."""

    backend = "hash-fallback"

    def __init__(self, dim: int = 512) -> None:
        self.dim = dim

    def _vec(self, key: str) -> np.ndarray:
        seed = int.from_bytes(hashlib.sha256(key.encode("utf-8")).digest()[:8], "big")
        rng = np.random.default_rng(seed)
        return l2_normalize(rng.standard_normal(self.dim).astype(np.float32))

    def embed_texts(self, texts: Sequence[str]) -> np.ndarray:
        return np.stack([self._vec("t:" + t) for t in texts]) if texts else np.zeros((0, self.dim), np.float32)

    def embed_images(self, paths: Sequence[str]) -> np.ndarray:
        out = []
        for p in paths:
            try:
                with open(p, "rb") as f:
                    h = hashlib.sha256(f.read()).hexdigest()
            except OSError:
                h = p
            out.append(self._vec("i:" + h))
        return np.stack(out) if out else np.zeros((0, self.dim), np.float32)


class _OpenClipEmbedder:
    backend = "open_clip"

    def __init__(self, model_name: str = "ViT-B-32", pretrained: str = "laion2b_s34b_b79k") -> None:
        import torch  # lazy
        import open_clip

        self._torch = torch
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model, _, self.preprocess = open_clip.create_model_and_transforms(
            model_name, pretrained=pretrained
        )
        self.model.eval().to(self.device)
        self.tokenizer = open_clip.get_tokenizer(model_name)
        self.dim = self.model.text_projection.shape[1]

    def embed_texts(self, texts: Sequence[str]) -> np.ndarray:
        torch = self._torch
        with torch.no_grad():
            tok = self.tokenizer(list(texts)).to(self.device)
            feats = self.model.encode_text(tok).float().cpu().numpy()
        return l2_normalize(feats)

    def embed_images(self, paths: Sequence[str]) -> np.ndarray:
        from PIL import Image

        torch = self._torch
        tensors = []
        for p in paths:
            img = Image.open(p).convert("RGB")
            tensors.append(self.preprocess(img))
        if not tensors:
            return np.zeros((0, self.dim), np.float32)
        with torch.no_grad():
            batch = torch.stack(tensors).to(self.device)
            feats = self.model.encode_image(batch).float().cpu().numpy()
        return l2_normalize(feats)


def get_embedder(allow_fallback: bool = True) -> Embedder:
    try:
        return _OpenClipEmbedder()
    except Exception as exc:  # noqa: BLE001 - any import/runtime failure -> fallback
        if not allow_fallback:
            raise
        print(f"[clip_backend] open_clip unavailable ({exc}); using deterministic hash fallback")
        return _HashEmbedder()
