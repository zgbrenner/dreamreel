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


def test_only_missing_leaves_existing_shots_untouched(monkeypatch, tmp_path):
    # Stub out ffmpeg + PySceneDetect so we exercise just the annotate() selection + threading.
    from embed import shots

    monkeypatch.setattr(shots, "_extract_segment", lambda *a, **k: True)
    monkeypatch.setattr(shots, "detect_shots", lambda _p: [(0.0, 5.0)])
    manifest = {
        "assets": [
            {"id": "vid-has", "type": "video", "src": "u", "shots": [{"start": 1.0, "end": 2.0}]},
            {"id": "vid-gap", "type": "video", "src": "v"},
        ]
    }
    out, n = shots.annotate(manifest, tmp_path, lead=12.0, max_shots=10, only_missing=True)
    assert n == 1  # only the gap was annotated
    by_id = {a["id"]: a for a in out["assets"]}
    assert by_id["vid-has"]["shots"] == [{"start": 1.0, "end": 2.0}]  # existing shots untouched
    assert by_id["vid-gap"]["shots"] == [{"start": 12.0, "end": 17.0}]  # detected, offset by lead=12
