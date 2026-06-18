"""The mood-score curation filter keeps weird assets and the familiar anchors, drops the rest."""

from __future__ import annotations

from embed.curate import DEFAULT_CUTOFF, curate
from ingest.themes import ANCHOR_THEMES


def _asset(tags, uncanny=0.0, ominous=0.0):
    return {"id": "x", "tags": list(tags), "mood": {"uncanny": uncanny, "ominous": ominous}}


def test_drops_below_cutoff():
    weird = _asset(["death mask"], uncanny=0.9)
    bland = _asset(["death mask"], uncanny=0.1, ominous=0.1)
    kept, dropped = curate([weird, bland], cutoff=0.55)
    assert weird in kept and bland in dropped


def test_max_of_uncanny_or_ominous_counts():
    ominous_only = _asset(["cave"], uncanny=0.1, ominous=0.8)
    kept, dropped = curate([ominous_only], cutoff=0.55)
    assert ominous_only in kept


def test_anchor_is_exempt_even_when_bland():
    anchor = ANCHOR_THEMES[0]
    bland_anchor = _asset([anchor], uncanny=0.0, ominous=0.0)
    kept, dropped = curate([bland_anchor], cutoff=0.55)
    assert bland_anchor in kept and not dropped


def test_returns_partition_with_default_cutoff():
    a = _asset(["fungus"], uncanny=DEFAULT_CUTOFF)  # exactly at cutoff is kept
    kept, dropped = curate([a])
    assert a in kept
