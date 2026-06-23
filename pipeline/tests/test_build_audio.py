import numpy as np

from audio.build_audio import build_audio_assets, claptext_for, _dwell_for_audio
from audio.clap_backend import get_audio_embedder
from embed.mood_axes import build_axes


def test_build_audio_assets_shape_and_internal_fields():
    emb = get_audio_embedder(allow_fallback=True)
    axes = build_axes(emb)  # CLAP-space mood axes
    cands = [
        {"id": "m1", "kind": "music", "source_url": "https://r/x.m4a",
         "source": "Musopen", "license": "PD", "tags": ["piano"],
         "duration_sec": 80.0, "loopable": False, "_local": "/tmp/x.m4a"},
    ]
    out = build_audio_assets(emb, axes, cands)
    a = out[0]
    assert a["id"] == "m1" and a["kind"] == "music"
    assert len(a["embedding"]) == 512
    assert set(a["mood"]) == {"melancholy", "uncanny", "nostalgic", "ominous", "tender", "mechanical"}
    assert a["durationSec"] == 80.0 and a["loopable"] is False
    assert a["dwellBase"] == 60.0
    assert a["_local"] == "/tmp/x.m4a"  # internal path retained for transcode/upload
    assert a["src"] == "https://r/x.m4a"


def test_claptext_deterministic_and_empty_for_no_tags():
    emb = get_audio_embedder(allow_fallback=True)
    v1 = claptext_for(emb, ["steam", "train"])
    v2 = claptext_for(emb, ["steam", "train"])
    assert len(v1) == 512 and v1 == v2
    assert claptext_for(emb, []) == []


def test_dwell_by_kind():
    assert _dwell_for_audio("music") == 60.0
    assert _dwell_for_audio("voice") == 7.0
    assert _dwell_for_audio("foley") == 12.0
