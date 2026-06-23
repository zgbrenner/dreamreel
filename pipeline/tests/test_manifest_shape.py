"""End-to-end shape test: build_manifest (fallback embedder) yields a schema-shaped manifest
with consistent dims and L2-normalized embeddings — the same invariants the app's zod loader
enforces."""

import math
from pathlib import Path

from embed.build_manifest import build

MOOD_AXES = {"melancholy", "uncanny", "nostalgic", "ominous", "tender", "mechanical"}


def _norm(v):
    return math.sqrt(sum(x * x for x in v))


def test_build_manifest_shape(tmp_path: Path):
    out = build(tmp_path, fetched_path=None)
    import json

    m = json.loads(out.read_text())

    assert m["embeddingDim"] > 0
    assert set(m["moodAxes"]) == MOOD_AXES
    for axis, vec in m["moodAxes"].items():
        assert len(vec) == m["embeddingDim"]

    assert len(m["assets"]) >= 9  # the procedural placeholders at minimum
    assert len(m["texts"]) >= 10

    for a in m["assets"] + m["texts"]:
        assert len(a["embedding"]) == m["embeddingDim"]
        assert abs(_norm(a["embedding"]) - 1.0) < 1e-3
        assert set(a["mood"]) == MOOD_AXES
        assert a["license"]
        assert a["source"]
        # CC-BY assets must carry attribution
        if a["license"].upper().startswith("CC-BY"):
            assert a.get("attribution")


def test_procedural_assets_present(tmp_path: Path):
    import json

    m = json.loads(build(tmp_path, fetched_path=None).read_text())
    kinds = {a.get("kind") for a in m["assets"] if a["type"] == "procedural"}
    assert {"leader", "fog", "static"} <= kinds


def test_manifest_includes_audio_pool_and_claptext(tmp_path):
    from embed.build_manifest import build
    out = build(tmp_path, fetched_path=None, videos_path=None)
    import json
    m = json.loads(out.read_text())
    assert "audio" in m and isinstance(m["audio"], list)
    assert "audioEmbeddingDim" in m and m["audioEmbeddingDim"] == 512
    # claptext is present on visual assets that have tags (procedural assets have tag lists too)
    assert all(("claptext" in a) for a in m["assets"])
