"""Tests for embed.poetry — the line extractor is pure (no torch)."""

from __future__ import annotations

from embed.poetry import MAX_LEN, MIN_LEN, PD_SOURCES, extract_lines

# Every poet in the corpus must be unambiguously public domain (pre-1929). This set is the license
# guard: a source added outside it should fail the test, not silently ship under license "PD".
PD_POETS = {
    "Emily Dickinson",
    "William Blake",
    "Edgar Allan Poe",
    "Walt Whitman",
    "Christina Rossetti",
}


def test_deterministic():
    assert extract_lines(100) == extract_lines(100)


def test_lines_are_wellformed_and_in_band():
    items = extract_lines(100)
    for it in items:
        line = it["text"]
        assert MIN_LEN <= len(line) <= MAX_LEN  # same drift-line band as curated/generated text
        assert line == line.strip()
        assert "  " not in line  # normalized to single spaces


def test_lines_are_unique_case_insensitively():
    items = extract_lines(1000)
    keys = [it["text"].casefold() for it in items]
    assert len(keys) == len(set(keys))


def test_count_is_capped():
    assert len(extract_lines(10)) == 10
    # Asking for more than the corpus holds returns everything available, not an error.
    everything = extract_lines(10_000)
    assert len(extract_lines(10)) < len(everything)


def test_first_batch_is_a_healthy_size():
    # The default batch (~100) should be reachable from the curated corpus.
    assert len(extract_lines(10_000)) >= 90


def test_every_line_carries_pd_provenance():
    for it in extract_lines(10_000):
        assert it["poet"] in PD_POETS  # license guard: only known-PD poets
        assert it["work"]  # a concrete work, for the manifest `source` string


def test_corpus_blocks_are_wellformed():
    for block in PD_SOURCES:
        assert block["poet"] in PD_POETS
        assert block["work"]
        assert block["lines"]
        assert all(isinstance(ln, str) and ln.strip() for ln in block["lines"])
