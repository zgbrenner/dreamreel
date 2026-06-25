"""Tests for embed.sprites pure helpers — target selection + mask cutout (no transformers/torch)."""

from __future__ import annotations

import numpy as np
from PIL import Image

from embed.sprites import cutout_from_mask, pick_targets


def _img(aid, entities, aes=5.0):
    return {"id": aid, "type": "image", "entities": entities, "aesthetic": aes,
            "src": "x", "source": "s", "license": "PD"}


def test_pick_targets_skips_styles_and_ranks_by_frequency():
    m = {"assets": [
        _img("a", ["clock", "drawing"], 6.0),  # 'drawing' is a skip word
        _img("b", ["clock", "bird"], 7.0),
        _img("c", ["bird"], 5.0),
        _img("d", ["black"], 5.0),  # 'black' is a skip word
    ]}
    targets = pick_targets(m, 10)
    ents = [e for e, _ in targets]
    assert "drawing" not in ents and "black" not in ents
    assert set(ents) == {"clock", "bird"}  # both freq 2


def test_pick_targets_chooses_highest_aesthetic_source():
    m = {"assets": [_img("a", ["clock"], 4.0), _img("b", ["clock"], 8.0), _img("c", ["clock"], 6.0)]}
    targets = pick_targets(m, 5)
    clock_src = [a for e, a in targets if e == "clock"][0]
    assert clock_src["id"] == "b"  # aesthetic 8.0


def test_pick_targets_respects_max():
    m = {"assets": [_img(f"a{i}", [f"thing{i}"]) for i in range(20)]}
    assert len(pick_targets(m, 5)) == 5


def test_cutout_applies_mask_as_alpha_and_crops_to_box():
    img = Image.new("RGB", (10, 10), (255, 0, 0))
    mask = np.zeros((10, 10), dtype=bool)
    mask[2:5, 3:6] = True  # a 3x3 region
    cut = cutout_from_mask(img, (3, 2, 6, 5), mask)
    assert cut.size == (3, 3)
    arr = np.array(cut)
    assert (arr[..., 3] == 255).all()  # whole box is masked → opaque
    assert (arr[..., 0] == 255).all()  # red preserved


def test_cutout_partial_mask_makes_transparent_pixels():
    img = Image.new("RGB", (8, 8), (0, 128, 255))
    mask = np.zeros((8, 8), dtype=bool)
    mask[0:4, 0:2] = True  # only the left half of the box
    cut = cutout_from_mask(img, (0, 0, 4, 4), mask)  # 4x4 box
    arr = np.array(cut)
    assert (arr[:, 0:2, 3] == 255).all()  # masked → opaque
    assert (arr[:, 2:4, 3] == 0).all()  # unmasked → transparent
