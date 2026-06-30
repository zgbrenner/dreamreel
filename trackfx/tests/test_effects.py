import numpy as np
import pytest
import supervision as sv

from trackfx import effects
from trackfx.effects.base import EffectContext

FRAME_SHAPE = (48, 64, 3)


def _frame() -> np.ndarray:
    rng = np.random.default_rng(0)
    return rng.integers(0, 255, size=FRAME_SHAPE, dtype=np.uint8)


def _detections(confidence=0.9, tracker_id=1) -> sv.Detections:
    mask = np.zeros((1, FRAME_SHAPE[0], FRAME_SHAPE[1]), dtype=bool)
    mask[0, 10:30, 15:40] = True
    return sv.Detections(
        xyxy=np.array([[15, 10, 40, 30]], dtype=np.float32),
        mask=mask,
        confidence=np.array([confidence], dtype=np.float32),
        class_id=np.array([0]),
        tracker_id=np.array([tracker_id]),
    )


def _ctx(frame_index=0, track_age_frames=None, state=None) -> EffectContext:
    return EffectContext(
        frame_index=frame_index,
        fps=10.0,
        track_age_frames=track_age_frames or {1: 1},
        smoothed_xyxy={1: np.array([15, 10, 40, 30], dtype=np.float32)},
        state=state if state is not None else {},
    )


@pytest.mark.parametrize("name", effects.available())
def test_effect_preserves_shape_and_dtype(name):
    frame = _frame()
    out = effects.get(name)(frame, _detections(), _ctx())
    assert out.shape == frame.shape
    assert out.dtype == frame.dtype


@pytest.mark.parametrize("name", effects.available())
def test_effect_handles_empty_detections(name):
    frame = _frame()
    out = effects.get(name)(frame, sv.Detections.empty(), _ctx(track_age_frames={}))
    assert out.shape == frame.shape


@pytest.mark.parametrize("name", effects.available())
def test_effect_handles_missing_mask_gracefully(name):
    frame = _frame()
    boxes_only = sv.Detections(
        xyxy=np.array([[15, 10, 40, 30]], dtype=np.float32),
        confidence=np.array([0.9], dtype=np.float32),
        class_id=np.array([0]),
        tracker_id=np.array([1]),
    )
    out = effects.get(name)(frame, boxes_only, _ctx())
    assert out.shape == frame.shape


def test_ghost_trail_strengthens_with_track_age():
    frame = _frame()
    state = {}
    fresh = effects.get("ghost_trail")(
        frame, _detections(), _ctx(track_age_frames={1: 1}, state=state)
    )
    # A brand new track (age ~0.1s) should leave ~no trail: output ~= input.
    assert np.abs(fresh.astype(int) - frame.astype(int)).max() <= 2

    state2 = {}
    aged = effects.get("ghost_trail")(
        frame, _detections(), _ctx(track_age_frames={1: 100}, state=state2)
    )
    # A long-held track (10s at 10fps) should visibly alter the masked region.
    region = np.s_[10:30, 15:40]
    assert np.abs(aged[region].astype(int) - frame[region].astype(int)).max() > 10


def test_dream_gate_keeps_mask_interior_closer_to_source_than_exterior():
    frame = _frame()
    out = effects.get("dream_gate")(frame, _detections(confidence=0.99), _ctx())
    inside_diff = np.abs(out[15, 20].astype(int) - frame[15, 20].astype(int)).sum()
    outside_diff = np.abs(out[2, 2].astype(int) - frame[2, 2].astype(int)).sum()
    assert outside_diff > inside_diff


def test_glitch_resolve_settles_as_track_ages():
    frame = _frame()
    fresh_low_conf = effects.get("glitch_resolve")(
        frame, _detections(confidence=0.1), _ctx(track_age_frames={1: 1})
    )
    resolved = effects.get("glitch_resolve")(
        frame, _detections(confidence=0.1), _ctx(track_age_frames={1: 1000})
    )
    region = np.s_[10:30, 15:40]
    fresh_delta = np.abs(fresh_low_conf[region].astype(int) - frame[region].astype(int)).sum()
    resolved_delta = np.abs(resolved[region].astype(int) - frame[region].astype(int)).sum()
    assert fresh_delta > resolved_delta
    assert resolved_delta == 0
