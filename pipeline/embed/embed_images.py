"""Compute L2-normalized CLIP image embeddings for fetched assets."""

from __future__ import annotations

import numpy as np

from .clip_backend import Embedder, l2_normalize


def embed_image_paths(embedder: Embedder, paths: list[str]) -> np.ndarray:
    """Return an (N, dim) array of L2-normalized image embeddings."""
    if not paths:
        return np.zeros((0, embedder.dim), dtype=np.float32)
    return l2_normalize(embedder.embed_images(paths))
