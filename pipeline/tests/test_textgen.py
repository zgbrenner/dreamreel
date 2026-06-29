"""Tests for embed.textgen — the grammar + expander are pure (no torch)."""

from __future__ import annotations

from embed.textgen import expand_lines


def test_deterministic_per_seed():
    assert expand_lines("alpha", 50) == expand_lines("alpha", 50)


def test_different_seeds_diverge():
    assert expand_lines("alpha", 50) != expand_lines("beta", 50)


def test_lines_are_wellformed_and_unique():
    lines = expand_lines("voice", 120)
    assert len(lines) == len(set(lines))  # unique
    for ln in lines:
        assert "#" not in ln  # all grammar tokens resolved
        assert 18 <= len(ln) <= 90  # reasonable drift-line length
        assert ln == ln.strip()


def test_count_is_respected():
    assert len(expand_lines("n", 25)) == 25


def test_build_text_assets_tolerates_dim_mismatch():
    # CLIP-512 embedder against a SigLIP 768-d corpus must NOT crash: provisional embeddings + neutral
    # moods, to be replaced by a later SigLIP re-embed (the augment-then-reembed lineage).
    import numpy as np
    from embed.textgen import build_text_assets

    axes_names = (
        "melancholy", "uncanny", "nostalgic", "ominous", "tender", "mechanical",
        "love", "loss", "joy", "fear", "absurdity", "strange",
    )
    axes = {a: np.zeros(768, dtype=np.float32) for a in axes_names}

    class FakeEmb:
        def embed_texts(self, texts):
            return np.ones((len(texts), 512), dtype=np.float32)

    assets = build_text_assets(FakeEmb(), axes, ["the clock forgets the hour it was promising"])
    assert len(assets) == 1
    assert len(assets[0]["embedding"]) == 512
    assert set(assets[0]["mood"].values()) == {0.5}
    assert assets[0]["license"] == "CC0"
