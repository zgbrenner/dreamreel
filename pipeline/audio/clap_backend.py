"""CLAP backend with a deterministic offline fallback.

Production uses laion CLAP (htsat, 512-dim joint text/audio space) for real audio + text
embeddings. When laion_clap/torch aren't installed (CI, or a quick offline manifest build), we
fall back to a deterministic hashing embedder so the pipeline still produces a structurally
valid manifest. The fallback is not semantic — it exists to exercise the plumbing without a GPU.

This mirrors embed/clip_backend.py but indexes a DIFFERENT (CLAP) space. CLAP vectors must never
be compared against CLIP vectors.
"""

from __future__ import annotations

import hashlib
from typing import Protocol, Sequence

import numpy as np


def l2_normalize(x: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(x, axis=-1, keepdims=True)
    n[n == 0] = 1.0
    return x / n


class AudioEmbedder(Protocol):
    dim: int
    backend: str

    def embed_texts(self, texts: Sequence[str]) -> np.ndarray: ...
    def embed_audio(self, paths: Sequence[str]) -> np.ndarray: ...


class _HashEmbedder:
    """Deterministic, non-semantic CLAP-space embeddings from content hashes (offline fallback)."""

    backend = "hash-fallback"

    def __init__(self, dim: int = 512) -> None:
        self.dim = dim

    def _vec(self, key: str) -> np.ndarray:
        seed = int.from_bytes(hashlib.sha256(key.encode("utf-8")).digest()[:8], "big")
        rng = np.random.default_rng(seed)
        return l2_normalize(rng.standard_normal(self.dim).astype(np.float32))

    def embed_texts(self, texts: Sequence[str]) -> np.ndarray:
        return (
            np.stack([self._vec("ct:" + t) for t in texts])
            if texts
            else np.zeros((0, self.dim), np.float32)
        )

    def embed_audio(self, paths: Sequence[str]) -> np.ndarray:
        out = []
        for p in paths:
            try:
                with open(p, "rb") as f:
                    h = hashlib.sha256(f.read()).hexdigest()
            except OSError:
                h = p
            out.append(self._vec("ca:" + h))
        return np.stack(out) if out else np.zeros((0, self.dim), np.float32)


class _LaionClapEmbedder:
    backend = "laion_clap"

    def __init__(self) -> None:
        import laion_clap  # lazy
        import torch

        self._torch = torch
        self.dim = 512
        self.model = laion_clap.CLAP_Module(enable_fusion=False)
        self.model.load_ckpt()  # downloads the default 630k checkpoint
        self.model.eval()

    def embed_texts(self, texts: Sequence[str]) -> np.ndarray:
        feats = self.model.get_text_embedding(list(texts), use_tensor=False)
        return l2_normalize(np.asarray(feats, dtype=np.float32))

    def embed_audio(self, paths: Sequence[str]) -> np.ndarray:
        if not paths:
            return np.zeros((0, self.dim), np.float32)
        feats = self.model.get_audio_embedding_from_filelist(list(paths), use_tensor=False)
        return l2_normalize(np.asarray(feats, dtype=np.float32))


def get_audio_embedder(allow_fallback: bool = True) -> AudioEmbedder:
    try:
        return _LaionClapEmbedder()
    except Exception as exc:  # noqa: BLE001 - any import/runtime failure -> fallback
        if not allow_fallback:
            raise
        print(f"[clap_backend] laion_clap unavailable ({exc}); using deterministic hash fallback")
        return _HashEmbedder()
