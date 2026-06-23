"""The lower video cutoff keeps films an image-strength cutoff would drop."""
from __future__ import annotations

from embed.curate import VIDEO_CUTOFF, curate


def _vid(score: float, id_: str) -> dict:
    return {"id": id_, "type": "video", "tags": ["film"], "mood": {"uncanny": score, "ominous": 0.0}}


def test_video_cutoff_is_lower_than_image_default():
    from embed.curate import DEFAULT_CUTOFF
    assert VIDEO_CUTOFF < DEFAULT_CUTOFF
    assert VIDEO_CUTOFF == 0.45


def test_curate_keeps_video_at_video_cutoff():
    assets = [_vid(0.47, "vid-0"), _vid(0.30, "vid-1")]
    kept, dropped = curate(assets, cutoff=VIDEO_CUTOFF)
    assert {a["id"] for a in kept} == {"vid-0"}
    assert {a["id"] for a in dropped} == {"vid-1"}
