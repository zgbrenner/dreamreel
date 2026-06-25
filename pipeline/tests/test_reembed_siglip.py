"""Tests for embed.reembed_siglip — the pure manifest transform runs with a fake embedder."""

from __future__ import annotations

import hashlib

import numpy as np

from embed.mood_axes import MOOD_AXES
from embed.reembed_siglip import reembed_manifest


class FakeEmbedder:
    """Deterministic 4-d stand-in: hashes text/image keys to unit vectors (no torch)."""

    backend = "fake"
    dim = 4

    def _vec(self, s: str) -> np.ndarray:
        seed = int.from_bytes(hashlib.sha256(s.encode()).digest()[:8], "big")
        v = np.random.default_rng(seed).standard_normal(4).astype(np.float32)
        return v / (np.linalg.norm(v) + 1e-9)

    def embed_texts(self, texts):
        if not texts:
            return np.zeros((0, 4), np.float32)
        return np.array([self._vec("t:" + t) for t in texts], dtype=np.float32)

    def embed_images(self, paths):
        return [self._vec("i:" + p) for p in paths]


def _manifest():
    def asset(aid, atype, **extra):
        return {"id": aid, "type": atype, "embedding": [0.1, 0.2, 0.3], "mood": {}, "tags": ["x"],
                "dwellBase": 5, "source": "s", "license": "PD", "src": f"https://r/{aid}", **extra}
    return {
        "version": "old",
        "embeddingDim": 3,
        "moodAxes": {a: [0.0, 0.0, 0.0] for a in MOOD_AXES},
        "assets": [
            asset("img-1", "image", aesthetic=6.1),
            asset("vid-1", "video"),
            {"id": "proc-1", "type": "procedural", "embedding": [0.1, 0.2, 0.3], "mood": {},
             "tags": ["fog", "haze"], "dwellBase": 5, "source": "s", "license": "CC0"},
        ],
        "texts": [
            {"id": "txt-1", "type": "titlecard", "text": "the tide forgets", "embedding": [0.1, 0.2, 0.3],
             "mood": {}, "tags": ["drift"], "dwellBase": 4, "source": "s", "license": "CC0"},
        ],
        "audioEmbeddingDim": 2,
        "audio": [{"id": "aud-1", "kind": "music", "src": "https://r/a", "embedding": [0.6, 0.8],
                   "mood": {}, "tags": [], "durationSec": 10, "loopable": True, "dwellBase": 60,
                   "source": "s", "license": "PD", "bpm": 120.0, "energy": 0.4}],
    }


def test_reembed_updates_dim_and_all_visual_text_embeddings():
    emb = FakeEmbedder()
    image_for = lambda a: f"/fake/{a['id']}.png" if a.get("type") in ("image", "video") else None
    out, n = reembed_manifest(_manifest(), emb, image_for)

    assert out["embeddingDim"] == 4
    assert n == 4  # 3 assets + 1 text
    for a in out["assets"]:
        assert len(a["embedding"]) == 4
        assert set(a["mood"].keys()) == set(MOOD_AXES)  # reprojected onto all axes
    for t in out["texts"]:
        assert len(t["embedding"]) == 4
    for axis in MOOD_AXES:
        assert len(out["moodAxes"][axis]) == 4
    assert out["version"] != "old"


def test_procedural_uses_tag_text_embedding_not_image():
    emb = FakeEmbedder()
    image_for = lambda a: f"/fake/{a['id']}.png" if a.get("type") in ("image", "video") else None
    out, _ = reembed_manifest(_manifest(), emb, image_for)
    proc = next(a for a in out["assets"] if a["id"] == "proc-1")
    # procedural has no image_for → it must equal the SigLIP-text embedding of its tags
    expected = emb.embed_texts(["fog, haze"])[0]
    assert np.allclose(proc["embedding"], [round(float(x), 6) for x in expected], atol=1e-6)


def test_audio_aesthetic_and_claptext_preserved():
    emb = FakeEmbedder()
    image_for = lambda a: f"/fake/{a['id']}.png" if a.get("type") in ("image", "video") else None
    src = _manifest()
    out, _ = reembed_manifest(src, emb, image_for)

    # Audio pool untouched (CLAP space, bpm/energy intact).
    assert out["audio"] == src["audio"]
    assert out["audioEmbeddingDim"] == 2
    # Aesthetic scalar preserved on the image asset.
    img = next(a for a in out["assets"] if a["id"] == "img-1")
    assert img["aesthetic"] == 6.1
