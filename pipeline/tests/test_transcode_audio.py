from pathlib import Path

import pytest

from audio.transcode_audio import AUDIO_WINDOWS, build_audio_cmd, transcode_audio


def test_window_bounds_per_kind():
    assert AUDIO_WINDOWS["music"] == (30.0, 90.0)
    assert AUDIO_WINDOWS["voice"] == (3.0, 10.0)
    assert AUDIO_WINDOWS["foley"] == (5.0, 20.0)


def test_cmd_trims_to_kind_max_and_normalizes_loudness():
    cmd = build_audio_cmd(Path("in.wav"), Path("out.m4a"), "voice", start_seconds=2.5)
    # fast-seek start before -i
    assert cmd[:1] == ["ffmpeg"]
    assert "-ss" in cmd and cmd[cmd.index("-ss") + 1] == "2.5"
    assert cmd.index("-ss") < cmd.index("-i")
    # trimmed to the kind's max window (voice -> 10s)
    assert cmd[cmd.index("-t") + 1] == "10.0"
    # loudness-normalized
    assert any("loudnorm" in a for a in cmd)
    # AAC audio, no video stream, faststart for web
    assert "-vn" in cmd
    assert "aac" in cmd
    assert "+faststart" in cmd
    assert cmd[-1] == "out.m4a"


def test_unknown_kind_rejected():
    with pytest.raises(KeyError):
        build_audio_cmd(Path("in.wav"), Path("out.m4a"), "podcast")


def test_transcode_returns_none_without_ffmpeg(tmp_path, monkeypatch):
    import audio.transcode_audio as mod

    def boom(*a, **k):
        raise FileNotFoundError("ffmpeg")

    monkeypatch.setattr(mod.subprocess, "run", boom)
    assert transcode_audio(tmp_path / "x.wav", tmp_path / "out", "music") is None
