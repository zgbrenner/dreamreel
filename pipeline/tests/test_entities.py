"""Tests for embed.entities.clean_tags — pure RAM-output normalization (no torch)."""

from __future__ import annotations

from embed.entities import clean_tags


def test_splits_lowercases_strips():
    assert clean_tags("Clock | Tower | SKY") == ["clock", "tower", "sky"]


def test_drops_stopwords_and_dedupes():
    assert clean_tags("photo | clock | image | clock | art") == ["clock"]


def test_accepts_list_input():
    assert clean_tags(["Bird", " bird ", "Nest"]) == ["bird", "nest"]


def test_caps_tag_count():
    raw = " | ".join(f"thing{i}" for i in range(30))
    assert len(clean_tags(raw, max_tags=12)) == 12


def test_empty():
    assert clean_tags("") == []
    assert clean_tags(" |  | ") == []
