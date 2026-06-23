"""Real CLAP embeddings via HuggingFace transformers (operational only).

laion_clap won't build on Python 3.13, so for the actual corpus embedding pass we use
transformers' native CLAP (`laion/clap-htsat-unfused`, 512-d joint text/audio space). This module
is NOT wired into the unit-tested `clap_backend.get_audio_embedder` (which stays laion_clap-or-hash
so CI needs no model). `build_corpus` prefers this embedder when transformers + the checkpoint are
available, and falls back to the hash embedder otherwise.

Audio is decoded to 48 kHz mono via ffmpeg (already a pipeline dependency) and read with
soundfile, so no torchaudio backend is required.
"""

from __future__ import annotations

import hashlib
import subprocess
import tempfile
from pathlib import Path
from typing import Sequence

import numpy as np

from .clap_backend import AudioEmbedder, l2_normalize

MODEL_ID = "laion/clap-htsat-unfused"
SR = 48000


def _hash_vec(key: str, dim: int) -> np.ndarray:
    seed = int.from_bytes(hashlib.sha256(key.encode("utf-8")).digest()[:8], "big")
    rng = np.random.default_rng(seed)
    return l2_normalize(rng.standard_normal(dim).astype(np.float32))


def _decode_48k_mono(path: str) -> np.ndarray | None:
    """ffmpeg-decode any audio file to a 48 kHz mono float32 waveform. None on failure."""
    import soundfile as sf  # lazy

    with tempfile.TemporaryDirectory() as td:
        wav = Path(td) / "x.wav"
        cmd = ["ffmpeg", "-y", "-i", path, "-ar", str(SR), "-ac", "1", "-f", "wav", str(wav)]
        try:
            subprocess.run(cmd, check=True, capture_output=True)
            data, _ = sf.read(str(wav), dtype="float32")
        except (subprocess.CalledProcessError, FileNotFoundError, RuntimeError, OSError):
            return None
    if data.ndim > 1:
        data = data.mean(axis=1)
    return data.astype(np.float32)


class _TransformersClapEmbedder:
    backend = "transformers_clap"

    def __init__(self) -> None:
        import torch  # lazy
        from transformers import (
            ClapAudioModelWithProjection,
            ClapProcessor,
            ClapTextModelWithProjection,
        )

        self._torch = torch
        # transformers 5.x: the dedicated *WithProjection models expose .text_embeds/.audio_embeds
        # (the joint-space 512-d projections) directly — get_text_features now returns a raw output.
        self.text_model = ClapTextModelWithProjection.from_pretrained(MODEL_ID).eval()
        self.audio_model = ClapAudioModelWithProjection.from_pretrained(MODEL_ID).eval()
        self.processor = ClapProcessor.from_pretrained(MODEL_ID)
        self.dim = int(self.text_model.config.projection_dim)

    def embed_texts(self, texts: Sequence[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), np.float32)
        torch = self._torch
        inputs = self.processor(text=list(texts), return_tensors="pt", padding=True)
        with torch.no_grad():
            feats = self.text_model(**inputs).text_embeds.cpu().numpy()
        return l2_normalize(feats.astype(np.float32))

    def embed_audio(self, paths: Sequence[str]) -> np.ndarray:
        if not paths:
            return np.zeros((0, self.dim), np.float32)
        torch = self._torch
        out = np.zeros((len(paths), self.dim), np.float32)
        for i, p in enumerate(paths):
            wav = _decode_48k_mono(p)
            if wav is None or wav.size == 0:
                # keep row alignment; a deterministic hash vector beats a zero vector.
                out[i] = _hash_vec("ca:" + p, self.dim)
                print(f"[clap_transformers] decode failed, hash-filled: {p}")
                continue
            inputs = self.processor(audio=wav, sampling_rate=SR, return_tensors="pt")
            with torch.no_grad():
                feat = self.audio_model(**inputs).audio_embeds.cpu().numpy()
            out[i] = l2_normalize(feat.astype(np.float32))[0]
        return out


def get_transformers_audio_embedder() -> AudioEmbedder | None:
    """Return a real transformers-CLAP embedder, or None if transformers/checkpoint unavailable."""
    try:
        return _TransformersClapEmbedder()
    except Exception as exc:  # noqa: BLE001 - any import/download/load failure -> caller falls back
        print(f"[clap_transformers] unavailable ({exc}); caller will fall back")
        return None
