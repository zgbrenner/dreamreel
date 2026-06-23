# pipeline/tests/test_poster.py
"""Poster-frame extraction (the still that gives a video its CLIP embedding).

ffmpeg is mocked; this proves the command shape and the None-on-failure contract.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

from embed import poster as ps


def test_extract_poster_runs_ffmpeg_and_returns_path(tmp_path, monkeypatch):
    src = tmp_path / "abc123.mp4"
    src.write_bytes(b"not really a video")
    calls = {}

    def fake_run(cmd, check, capture_output):
        calls["cmd"] = cmd
        # emulate ffmpeg writing the output frame
        Path(cmd[-1]).write_bytes(b"jpeg")
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(ps.subprocess, "run", fake_run)
    out = ps.extract_poster(src, tmp_path / "posters", at_seconds=1.0)

    assert out is not None
    assert out.exists()
    assert out.suffix == ".jpg"
    assert out.stem == "abc123"
    cmd = calls["cmd"]
    assert cmd[0] == "ffmpeg"
    assert "-ss" in cmd and "1.0" in cmd
    assert "-frames:v" in cmd and "1" in cmd


def test_extract_poster_returns_none_when_ffmpeg_missing(tmp_path, monkeypatch):
    src = tmp_path / "x.mp4"
    src.write_bytes(b"v")

    def boom(cmd, check, capture_output):
        raise FileNotFoundError("ffmpeg")

    monkeypatch.setattr(ps.subprocess, "run", boom)
    assert ps.extract_poster(src, tmp_path / "p") is None


def test_extract_poster_returns_none_on_nonzero(tmp_path, monkeypatch):
    src = tmp_path / "x.mp4"
    src.write_bytes(b"v")

    def fail(cmd, check, capture_output):
        raise subprocess.CalledProcessError(1, cmd)

    monkeypatch.setattr(ps.subprocess, "run", fail)
    assert ps.extract_poster(src, tmp_path / "p") is None
