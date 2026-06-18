"""build_manifest applies mood curation to image assets only."""

from __future__ import annotations

from embed import build_manifest


def _img(tags, uncanny):
    return {"id": "img", "type": "image", "tags": list(tags), "mood": {"uncanny": uncanny, "ominous": 0.0}}


def test_curate_image_assets_filters_only_images():
    weird = _img(["death mask"], 0.9)
    bland = _img(["botanical"], 0.05)
    anchor = _img(["ruins"], 0.0)
    kept = build_manifest.curate_image_assets([weird, bland, anchor])
    assert weird in kept and anchor in kept and bland not in kept
