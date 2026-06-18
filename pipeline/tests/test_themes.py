"""The uncanny query catalog and anchor list are the single source of truth for curation."""

from __future__ import annotations

from ingest import openverse, museums, themes


def test_anchors_are_present_in_openverse_themes():
    for anchor in themes.ANCHOR_THEMES:
        assert anchor in themes.OPENVERSE_THEMES


def test_openverse_themes_have_no_duplicates():
    assert len(themes.OPENVERSE_THEMES) == len(set(themes.OPENVERSE_THEMES))


def test_all_three_veins_contribute():
    for vein in (themes.CLINICAL, themes.OCCULT, themes.LIMINAL):
        assert vein  # non-empty
        assert any(t in themes.OPENVERSE_THEMES for t in vein)


def test_anchors_are_the_only_familiar_themes():
    # anchors are exactly the kept-familiar set, and none of them appear in a vein
    vein_terms = set(themes.CLINICAL) | set(themes.OCCULT) | set(themes.LIMINAL)
    assert not (set(themes.ANCHOR_THEMES) & vein_terms)


def test_ingesters_default_to_the_uncanny_catalog():
    assert openverse.THEMES is themes.OPENVERSE_THEMES
    assert museums.THEMES is themes.MUSEUM_THEMES
