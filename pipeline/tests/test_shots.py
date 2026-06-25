"""Tests for embed.shots.usable_shots — pure filtering, no PySceneDetect/ffmpeg."""

from __future__ import annotations

from embed.shots import usable_shots


def test_drops_short_flickers_and_offsets():
    scenes = [(0.0, 1.0), (2.0, 5.0)]  # first is < min_dur (1.5)
    out = usable_shots(scenes, offset=20.0, min_dur=1.5)
    assert out == [{"start": 22.0, "end": 25.0}]  # only the 3s shot, offset by the lead


def test_trims_long_shots_to_max_dur():
    out = usable_shots([(0.0, 30.0)], offset=0.0, max_dur=8.0)
    assert out == [{"start": 0.0, "end": 8.0}]  # capped at 8 s


def test_caps_and_spreads_to_max_n():
    scenes = [(float(i) * 3, float(i) * 3 + 2.0) for i in range(20)]  # 20 valid 2s shots
    out = usable_shots(scenes, max_n=4)
    assert len(out) == 4
    starts = [s["start"] for s in out]
    assert starts == sorted(starts)  # spread across the film, ascending
    assert starts[0] == 0.0 and starts[-1] > 30.0  # not just the first few


def test_empty_when_nothing_usable():
    assert usable_shots([(0.0, 0.5), (1.0, 1.2)], min_dur=1.5) == []
