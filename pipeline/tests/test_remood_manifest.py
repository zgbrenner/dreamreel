"""Tests for the 12-axis mood re-projection helper (no network, hash embedders only)."""

from audio.clap_backend import get_audio_embedder
from embed.clip_backend import get_embedder
from embed.mood_axes import MOOD_AXES
from embed.remood_manifest import remood_manifest


def _mini_manifest() -> dict:
    clip = get_embedder()
    vec = clip.embed_texts(["test"])[0].tolist()
    mood = {a: 0.5 for a in MOOD_AXES}
    mood["melancholy"] = 0.9
    return {
        "version": "2026.01.01-0000",
        "createdAt": "2026-01-01T00:00:00+00:00",
        "embeddingDim": len(vec),
        "audioEmbeddingDim": len(vec),
        "moodAxes": {"melancholy": vec},
        "assets": [
            {
                "id": "img-0000",
                "type": "image",
                "src": "https://example/img.webp",
                "embedding": vec,
                "mood": dict(mood),
                "tags": [],
                "dwellBase": 6,
                "source": "test",
                "license": "CC0",
            }
        ],
        "texts": [],
        "audio": [
            {
                "id": "aud-0000",
                "kind": "music",
                "src": "https://example/a.m4a",
                "embedding": vec,
                "mood": dict(mood),
                "tags": [],
                "durationSec": 10,
                "loopable": False,
                "dwellBase": 60,
                "source": "test",
                "license": "PD",
            }
        ],
    }


def test_remood_expands_axes_and_reprojects():
    clip = get_embedder()
    audio = get_audio_embedder(allow_fallback=True)
    out = remood_manifest(_mini_manifest(), clip_embedder=clip, audio_embedder=audio)
    assert set(out["moodAxes"].keys()) == set(MOOD_AXES)
    assert out["assets"][0]["mood"].keys() == set(MOOD_AXES)
    assert out["audio"][0]["mood"].keys() == set(MOOD_AXES)
    assert out["version"] != "2026.01.01-0000"


def test_remood_is_deterministic_for_fixed_embedders():
    clip = get_embedder()
    audio = get_audio_embedder(allow_fallback=True)
    m = _mini_manifest()
    a = remood_manifest(m, clip_embedder=clip, audio_embedder=audio)
    b = remood_manifest(m, clip_embedder=clip, audio_embedder=audio)
    assert a["assets"][0]["mood"] == b["assets"][0]["mood"]
    assert a["moodAxes"].keys() == b["moodAxes"].keys()
