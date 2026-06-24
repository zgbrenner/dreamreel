"""Tests for audio.tempo — the pure helpers run without librosa; analysis degrades gracefully."""

from __future__ import annotations

import importlib.util

import pytest

from audio.tempo import _sane_bpm, analyze_audio, normalize_energy

HAS_LIBROSA = importlib.util.find_spec("librosa") is not None


def test_normalize_energy_clamps_to_unit_range():
    assert normalize_energy(0.0) == 0.0
    assert normalize_energy(-1.0) == 0.0
    assert normalize_energy(0.2, ref=0.2) == 1.0
    assert normalize_energy(10.0) == 1.0  # clamped
    assert 0.0 < normalize_energy(0.1, ref=0.2) < 1.0


def test_normalize_energy_bad_ref():
    assert normalize_energy(0.5, ref=0.0) == 0.0


def test_sane_bpm_rejects_garbage():
    assert _sane_bpm(0) is None
    assert _sane_bpm(-30) is None
    assert _sane_bpm(float("nan")) is None
    assert _sane_bpm("not a number") is None


def test_sane_bpm_folds_octaves_into_band():
    # 240 -> 120 (in band); 40 -> 80 (in band).
    assert _sane_bpm(240) == 120.0
    assert _sane_bpm(40) == 80.0
    assert _sane_bpm(123.456) == 123.46


def test_analyze_missing_file_returns_none():
    # Missing file => None whether or not librosa is installed (no crash).
    assert analyze_audio("/definitely/not/a/real/file.m4a") is None


@pytest.mark.skipif(not HAS_LIBROSA, reason="librosa (audio extra) not installed")
def test_analyze_synthetic_tone(tmp_path):
    import numpy as np
    import soundfile as sf

    # A 2s 220 Hz tone with a 2 Hz amplitude pulse (=120 bpm-ish onset rhythm).
    sr = 22050
    t = np.linspace(0, 2.0, int(sr * 2.0), endpoint=False)
    pulse = 0.5 * (1 + np.sign(np.sin(2 * np.pi * 2.0 * t)))
    y = (0.3 * np.sin(2 * np.pi * 220 * t) * pulse).astype("float32")
    wav = tmp_path / "tone.wav"
    sf.write(wav, y, sr)

    result = analyze_audio(str(wav))
    assert result is not None
    assert "energy" in result
    assert 0.0 <= result["energy"] <= 1.0
    if "bpm" in result:
        assert 50.0 <= result["bpm"] <= 200.0
