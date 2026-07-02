"""Tests for audio.granulate — pure seeded granular pads + the georgeblood pad-stem driver.

Fully offline: no network, no real ffmpeg. librosa (the optional `audio` extra) may or may
not be installed; the no-pitch-shift degrade path is exercised regardless via a forced
`_librosa_or_none -> None` monkeypatch, and a skipif-gated test covers the librosa branch.
"""

from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path

import numpy as np
import pytest

import audio.granulate as mod
from audio.granulate import (
    _read_wav_mono,
    _write_wav_mono,
    build_pad_stems,
    encode_cmd,
    granulate_pad,
    snippet_cmd,
)
from audio.transcode_audio import LOUDNORM

HAS_LIBROSA = importlib.util.find_spec("librosa") is not None

SR = 8000


def _synth_source(sr: int = SR, seconds: float = 3.0) -> np.ndarray:
    """3s of 440 Hz tone + noise, mono float32 — a deterministic stand-in for a 78rpm snippet."""
    t = np.linspace(0, seconds, int(sr * seconds), endpoint=False)
    rng = np.random.default_rng(1234)
    y = 0.5 * np.sin(2 * np.pi * 440.0 * t) + 0.05 * rng.standard_normal(t.size)
    return y.astype(np.float32)


# ---------------------------------------------------------------------------
# granulate_pad: determinism + output contract
# ---------------------------------------------------------------------------


def test_granulate_pad_deterministic_same_seed():
    src = _synth_source()
    a = granulate_pad(src, SR, seed="alpha", duration_sec=1.5, density=10.0)
    b = granulate_pad(src, SR, seed="alpha", duration_sec=1.5, density=10.0)
    assert np.array_equal(a, b)  # bit-identical


def test_granulate_pad_different_seeds_differ():
    src = _synth_source()
    a = granulate_pad(src, SR, seed="alpha", duration_sec=1.5, density=10.0)
    b = granulate_pad(src, SR, seed="beta", duration_sec=1.5, density=10.0)
    assert not np.array_equal(a, b)


def test_granulate_pad_output_contract():
    src = _synth_source()
    duration = 2.25
    pad = granulate_pad(src, SR, seed="contract", duration_sec=duration, density=12.0)
    assert pad.dtype == np.float32
    assert len(pad) == round(duration * SR)
    peak = float(np.max(np.abs(pad)))
    assert 0.0 < peak <= 1.0  # non-silent, soft-clipped/normalized under full scale
    assert peak <= 0.985  # the documented 0.98 normalize target (float32 slack)


def test_granulate_pad_silent_or_empty_source_yields_silence():
    pad = granulate_pad(np.zeros(100, dtype=np.float32), SR, seed="s", duration_sec=0.5)
    assert len(pad) == round(0.5 * SR)
    assert not np.any(pad)
    pad2 = granulate_pad(np.array([], dtype=np.float32), SR, seed="s", duration_sec=0.5)
    assert not np.any(pad2)


def test_granulate_pad_tiny_source_does_not_crash():
    # Source shorter than the 8-sample grain floor: clamps, never a negative rng range.
    pad = granulate_pad(np.ones(5, dtype=np.float32) * 0.5, SR, seed="tiny", duration_sec=0.25)
    assert len(pad) == round(0.25 * SR)


def test_granulate_pad_no_librosa_path(monkeypatch):
    """The degrade path must work (and stay deterministic) with librosa forced absent."""
    monkeypatch.setattr(mod, "_librosa_or_none", lambda: None)
    src = _synth_source()
    a = granulate_pad(src, SR, seed="ghost", duration_sec=1.5, density=10.0, pitch_spread=2.0)
    b = granulate_pad(src, SR, seed="ghost", duration_sec=1.5, density=10.0, pitch_spread=2.0)
    assert np.array_equal(a, b)
    assert float(np.max(np.abs(a))) > 0.0
    # Grain layout (glen/s0/o0) is drawn before the semitone value each iteration, so the
    # no-librosa render equals the pitch_spread=0 render bit-for-bit.
    c = granulate_pad(src, SR, seed="ghost", duration_sec=1.5, density=10.0, pitch_spread=0.0)
    assert np.array_equal(a, c)


@pytest.mark.skipif(not HAS_LIBROSA, reason="librosa (audio extra) not installed")
def test_granulate_pad_with_librosa_pitch_shift():
    src = _synth_source()
    kwargs = dict(duration_sec=1.0, density=6.0, grain_sec=(0.06, 0.12), pitch_spread=3.0)
    a = granulate_pad(src, SR, seed="shift", **kwargs)
    b = granulate_pad(src, SR, seed="shift", **kwargs)
    assert np.array_equal(a, b)  # pitch shifting is deterministic too
    # Shifted grains change content vs the unshifted render (same layout, different audio).
    c = granulate_pad(src, SR, seed="shift", duration_sec=1.0, density=6.0,
                      grain_sec=(0.06, 0.12), pitch_spread=0.0)
    assert not np.array_equal(a, c)


def test_granulate_pad_rejects_bad_sr():
    with pytest.raises(ValueError):
        granulate_pad(_synth_source(), 0, seed="x")


# ---------------------------------------------------------------------------
# wav helpers round-trip (the driver's stdlib I/O)
# ---------------------------------------------------------------------------


def test_wav_mono_roundtrip(tmp_path):
    src = _synth_source(seconds=0.5)
    p = tmp_path / "rt.wav"
    _write_wav_mono(p, src, SR)
    y, sr = _read_wav_mono(p)
    assert sr == SR
    assert y.shape == src.shape
    assert np.max(np.abs(y - np.clip(src, -1, 1))) < 2.0 / 32768.0  # 16-bit quantization only


# ---------------------------------------------------------------------------
# build_pad_stems: mocked network + ffmpeg -> candidate shaping
# ---------------------------------------------------------------------------

DOCS = [
    {"identifier": "78_moonlight", "title": "Moonlight Serenade", "creator": ["Glenn Miller"]},
    {"identifier": "78_stardust", "title": "Star-Dust", "creator": "Hoagy Carmichael"},
    {"identifier": "78_nofiles", "title": "No Files Here"},
]

META = {
    "78_moonlight": {"files": [
        {"name": "cover.jpg", "format": "JPEG"},
        {"name": "moonlight.mp3", "format": "VBR MP3", "length": "180.5"},
    ]},
    "78_stardust": {"files": [
        {"name": "stardust side a.mp3", "format": "128Kbps MP3", "length": "2:41"},
    ]},
    "78_nofiles": {"files": [{"name": "scan.png", "format": "PNG"}]},
}


class _FakeResp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


def _fake_requests_get(url, params=None, headers=None, timeout=None):
    assert headers and "DREAMREEL" in headers["User-Agent"]
    if url == mod.ARCHIVE_SEARCH:
        assert params["q"] == "collection:(georgeblood) AND mediatype:audio"
        assert params["output"] == "json"
        return _FakeResp({"response": {"docs": DOCS}})
    if url.startswith(mod.ARCHIVE_META + "/"):
        ident = url.rsplit("/", 1)[1]
        return _FakeResp(META[ident])
    raise AssertionError(f"unexpected URL fetched: {url}")


@pytest.fixture()
def driver_env(monkeypatch, tmp_path):
    """No network, no ffmpeg, no sleeping, fast fake granulation. Returns (out_dir, cmds, seeds)."""
    cmds: list[list[str]] = []
    grain_seeds: list[str] = []

    def fake_run(cmd, check=True, capture_output=True, timeout=None):
        cmds.append(list(cmd))
        dst = Path(cmd[-1])
        if dst.suffix == ".wav":  # the snippet stream-trim: synthesize a source wav
            _write_wav_mono(dst, _synth_source(sr=SR, seconds=1.0), SR)
        elif dst.suffix == ".m4a":  # the encode: emit a plausibly-sized file
            dst.write_bytes(b"\0" * 16384)
        return subprocess.CompletedProcess(cmd, 0)

    def fake_granulate(y, sr, *, seed, duration_sec=mod.PAD_SEC, **kw):
        grain_seeds.append(seed)
        assert isinstance(y, np.ndarray) and y.size > 0 and sr == SR
        return np.linspace(-0.5, 0.5, int(sr * 0.25), dtype=np.float32)  # tiny fake pad

    monkeypatch.setattr(mod.requests, "get", _fake_requests_get)
    monkeypatch.setattr(mod.subprocess, "run", fake_run)
    monkeypatch.setattr(mod.time, "sleep", lambda s: None)
    monkeypatch.setattr(mod, "granulate_pad", fake_granulate)
    return tmp_path / "pads", cmds, grain_seeds


def test_build_pad_stems_candidate_shape(driver_env):
    out_dir, cmds, grain_seeds = driver_env
    rows = build_pad_stems(2, out_dir, seed="dreamreel", rows=10)

    assert [r["id"] for r in rows] == ["aud-pad-78_moonlight", "aud-pad-78_stardust"]
    assert grain_seeds == ["dreamreel:78_moonlight", "dreamreel:78_stardust"]

    r = rows[0]
    assert r["kind"] == "music"
    assert r["source"] == "Archive.org / Great 78 Project (granulated)"
    assert r["license"] == "PD"
    assert r["tags"][:3] == ["pad", "ghost-music", "granulated"]
    assert "moonlight" in r["tags"] and "serenade" in r["tags"]
    assert len(r["tags"]) <= 10
    assert r["duration_sec"] == 60.0
    assert r["loopable"] is True
    assert r["attribution"] == "Glenn Miller"  # list creator unwrapped
    assert r["attribution_url"] == "https://archive.org/details/78_moonlight"
    assert r["source_url"] == "https://archive.org/download/78_moonlight/moonlight.mp3"
    local = Path(r["_local"])
    assert local == out_dir / "aud-pad-78_moonlight.m4a"
    assert local.exists() and local.stat().st_size > mod.MIN_M4A_BYTES

    r2 = rows[1]
    assert r2["attribution"] == "Hoagy Carmichael"  # plain-string creator kept
    assert "star" in r2["tags"] and "dust" in r2["tags"]  # hyphen split into title words
    assert "%20" in r2["source_url"]  # filename with spaces is url-quoted


def test_build_pad_stems_ffmpeg_cmds(driver_env):
    out_dir, cmds, _ = driver_env
    build_pad_stems(1, out_dir, seed="s", rows=10)

    snips = [c for c in cmds if c[-1].endswith(".wav")]
    encs = [c for c in cmds if c[-1].endswith(".m4a")]
    assert len(snips) == 1 and len(encs) == 1

    snip = snips[0]
    assert snip[:2] == ["ffmpeg", "-y"]
    assert snip[snip.index("-ss") + 1] == "8.0"  # from 8s in (past the needle lead-in)
    assert snip[snip.index("-t") + 1] == "25.0"  # ~25s snippet
    assert snip[snip.index("-i") + 1].startswith("https://archive.org/download/78_moonlight/")

    enc = encs[0]
    assert enc[enc.index("-af") + 1] == LOUDNORM
    assert enc[enc.index("-c:a") + 1] == "aac"
    assert enc[enc.index("-b:a") + 1] == "128k"
    assert enc[enc.index("-movflags") + 1] == "+faststart"
    # intermediates cleaned up; only the m4a remains
    assert sorted(p.name for p in out_dir.iterdir()) == ["aud-pad-78_moonlight.m4a"]


def test_build_pad_stems_skips_items_without_mp3(driver_env):
    out_dir, cmds, _ = driver_env
    rows = build_pad_stems(3, out_dir, seed="s", rows=10)
    # 78_nofiles has no mp3 derivative -> skipped, no ffmpeg invoked for it.
    assert [r["id"] for r in rows] == ["aud-pad-78_moonlight", "aud-pad-78_stardust"]
    assert not any("78_nofiles" in " ".join(c) for c in cmds)


def test_build_pad_stems_search_failure_returns_empty(monkeypatch, tmp_path):
    def boom(*a, **kw):
        raise mod.requests.ConnectionError("offline")

    monkeypatch.setattr(mod.requests, "get", boom)
    assert build_pad_stems(2, tmp_path / "pads", seed="s") == []


def test_build_pad_stems_drops_failed_encode(monkeypatch, driver_env):
    out_dir, cmds, _ = driver_env

    def failing_run(cmd, check=True, capture_output=True, timeout=None):
        dst = Path(cmd[-1])
        if dst.suffix == ".wav":
            _write_wav_mono(dst, _synth_source(sr=SR, seconds=1.0), SR)
            return subprocess.CompletedProcess(cmd, 0)
        raise subprocess.CalledProcessError(1, cmd)  # every m4a encode fails

    monkeypatch.setattr(mod.subprocess, "run", failing_run)
    assert build_pad_stems(2, out_dir, seed="s", rows=10) == []


def test_snippet_and_encode_cmd_shapes(tmp_path):
    s = snippet_cmd("https://archive.org/download/x/y.mp3", tmp_path / "s.wav")
    assert s[0] == "ffmpeg" and "-ac" in s and s[s.index("-ar") + 1] == "22050"
    e = encode_cmd(tmp_path / "p.wav", tmp_path / "p.m4a")
    assert e[0] == "ffmpeg" and LOUDNORM in e
