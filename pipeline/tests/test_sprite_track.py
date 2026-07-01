"""Tests for embed.sprite_track pure helpers (target/entity/track selection).

These avoid the `track` extra: no torch/trackfx/supervision imported, matching the
license-scoped CI venv (pydantic/numpy/requests/Pillow only).
"""

from __future__ import annotations

import numpy as np

from embed.sprite_track import (
    dominant_class_id,
    longest_track,
    pick_track_targets,
    resolve_entity,
)


def _asset(id_, type_="video", shots=True, entities=("dog",)):
    a = {"id": id_, "type": type_, "source": "s", "license": "CC0"}
    if shots:
        a["shots"] = [{"start": 0.0, "end": 2.0}]
    if entities is not None:
        a["entities"] = list(entities)
    return a


def test_pick_track_targets_filters_and_limits():
    manifest = {
        "assets": [
            _asset("v1"),
            _asset("img", type_="image"),  # not video
            _asset("v2", shots=False),  # no shots
            _asset("v3", entities=None),  # no entities
            _asset("v4"),
            _asset("v5"),
        ]
    }
    picked = pick_track_targets(manifest, max_n=2)
    assert [a["id"] for a in picked] == ["v1", "v4"]  # order-preserving, capped at 2


def test_resolve_entity_direct_match_returns_asset_tag():
    assert resolve_entity("dog", ["Dog", "grass"]) == "Dog"  # preserves original casing


def test_resolve_entity_synonym_match():
    # COCO 'person' should match a RAM++ 'man' tag via the synonym table.
    assert resolve_entity("person", ["man", "hat"]) == "man"
    assert resolve_entity("tv", ["television"]) == "television"


def test_resolve_entity_no_overlap_is_gated_out():
    assert resolve_entity("dog", ["car", "road"]) is None


def test_resolve_entity_skips_background_and_skiplist():
    assert resolve_entity("__background__", ["__background__"]) is None
    assert resolve_entity("N/A", ["n/a"]) is None
    # 'book' is in embed.sprites._SKIP (abstraction, not a good sprite target)
    assert resolve_entity("book", ["book"]) is None


def test_resolve_entity_prefers_direct_over_synonym():
    # entities has both the direct coco name and a synonym; direct wins.
    assert resolve_entity("person", ["person", "man"]) == "person"


def test_longest_track_picks_most_frames():
    tracks = {
        1: {"frames": {0: None, 1: None}},
        2: {"frames": {0: None, 1: None, 2: None, 3: None}},
        3: {"frames": {0: None}},
    }
    tid, track = longest_track(tracks)
    assert tid == 2
    assert len(track["frames"]) == 4


def test_longest_track_tie_breaks_on_lowest_id():
    tracks = {
        5: {"frames": {0: None, 1: None}},
        2: {"frames": {0: None, 1: None}},
    }
    tid, _ = longest_track(tracks)
    assert tid == 2


def test_longest_track_empty():
    assert longest_track({}) is None


def test_dominant_class_id():
    assert dominant_class_id([7, 7, 3, 7, 3]) == 7
    assert dominant_class_id([]) is None
    # tie -> lowest id
    assert dominant_class_id([4, 4, 2, 2]) == 2
