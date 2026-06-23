"""Tests for embed.clip_window — clip_start_seconds (pure) and probe_duration (ffprobe wrapper).

TDD: write tests first, then implement clip_window.py.
"""
from __future__ import annotations

import types
from pathlib import Path

import pytest

from embed import clip_window


# ---------------------------------------------------------------------------
# clip_start_seconds — pure function
# ---------------------------------------------------------------------------

def test_clip_start_30_percent_interior():
    """1000-second film → 30% = 300.0 s."""
    assert clip_window.clip_start_seconds(1000) == 300.0


def test_clip_start_short_film_clamped_by_target():
    """23.7-second film: target=7.11, latest=max(0, 23.7-12-1)=10.7 → min(7.11, 10.7)=7.11."""
    result = clip_window.clip_start_seconds(23.7)
    assert result == pytest.approx(7.11, abs=1e-3)


def test_clip_start_very_short_film_clamped_to_zero():
    """5-second film: latest=max(0, 5-12-1)=0 → target=1.5 clamped to 0.0."""
    assert clip_window.clip_start_seconds(5) == 0.0


def test_clip_start_zero_duration():
    assert clip_window.clip_start_seconds(0) == 0.0


def test_clip_start_none_duration():
    assert clip_window.clip_start_seconds(None) == 0.0  # type: ignore[arg-type]


def test_clip_start_negative_duration():
    assert clip_window.clip_start_seconds(-100) == 0.0


def test_clip_start_custom_clip_seconds():
    """Caller can override clip_seconds (e.g. for tests)."""
    # 100-second film, 10-second clip: target=30.0, latest=max(0,100-10-1)=89 → 30.0
    assert clip_window.clip_start_seconds(100, clip_seconds=10) == 30.0


# ---------------------------------------------------------------------------
# probe_duration — ffprobe wrapper
# ---------------------------------------------------------------------------

class _FakeCompletedProcess:
    def __init__(self, stdout: str):
        self.stdout = stdout


def test_probe_duration_success(monkeypatch, tmp_path):
    """Returns float when ffprobe succeeds with parseable output."""
    fake_path = tmp_path / "film.mp4"
    fake_path.write_bytes(b"x")

    def fake_run(cmd, check, capture_output, text):
        return _FakeCompletedProcess("123.45\n")

    monkeypatch.setattr(clip_window.subprocess, "run", fake_run)
    result = clip_window.probe_duration(fake_path)
    assert result == pytest.approx(123.45)


def test_probe_duration_returns_none_on_file_not_found(monkeypatch, tmp_path):
    """Returns None when ffprobe binary is missing."""
    fake_path = tmp_path / "film.mp4"

    def fake_run(cmd, check, capture_output, text):
        raise FileNotFoundError("ffprobe not found")

    monkeypatch.setattr(clip_window.subprocess, "run", fake_run)
    assert clip_window.probe_duration(fake_path) is None


def test_probe_duration_returns_none_on_called_process_error(monkeypatch, tmp_path):
    """Returns None when ffprobe exits non-zero."""
    import subprocess as _subprocess
    fake_path = tmp_path / "film.mp4"

    def fake_run(cmd, check, capture_output, text):
        raise _subprocess.CalledProcessError(1, cmd)

    monkeypatch.setattr(clip_window.subprocess, "run", fake_run)
    assert clip_window.probe_duration(fake_path) is None


def test_probe_duration_returns_none_on_non_numeric_output(monkeypatch, tmp_path):
    """Returns None when ffprobe output cannot be parsed as float."""
    fake_path = tmp_path / "film.mp4"

    def fake_run(cmd, check, capture_output, text):
        return _FakeCompletedProcess("N/A\n")

    monkeypatch.setattr(clip_window.subprocess, "run", fake_run)
    assert clip_window.probe_duration(fake_path) is None


def test_probe_duration_returns_none_on_empty_output(monkeypatch, tmp_path):
    """Returns None when ffprobe output is empty."""
    fake_path = tmp_path / "film.mp4"

    def fake_run(cmd, check, capture_output, text):
        return _FakeCompletedProcess("")

    monkeypatch.setattr(clip_window.subprocess, "run", fake_run)
    assert clip_window.probe_duration(fake_path) is None
