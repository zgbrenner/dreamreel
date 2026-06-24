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
