"""Tests for the programmatic detect+track spine (track_frames / collect_track_masks).

Uses a stub detector so no model weights are downloaded.
"""

import numpy as np
import supervision as sv

from trackfx.tracking import collect_track_masks, track_frames


class MovingSquareDetector:
    """Detects the bright square in a synthetic frame as one masked detection."""

    def __call__(self, frame: np.ndarray) -> sv.Detections:
        height, width = frame.shape[:2]
        ys, xs = np.where(frame[..., 0] > 150)
        if len(xs) == 0:
            return sv.Detections.empty()
        x1, x2, y1, y2 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
        mask = np.zeros((1, height, width), dtype=bool)
        mask[0, y1:y2, x1:x2] = True
        return sv.Detections(
            xyxy=np.array([[x1, y1, x2, y2]], dtype=np.float32),
            mask=mask,
            confidence=np.array([0.95], dtype=np.float32),
            class_id=np.array([7]),
        )


def _frames(n=8, size=(48, 64)):
    height, width = size
    out = []
    for i in range(n):
        frame = np.full((height, width, 3), 20, dtype=np.uint8)
        x = 4 + i * 3
        frame[15:30, x : x + 12] = 220
        out.append(frame)
    return out


def test_track_frames_yields_persistent_tracker_id():
    frames = _frames()
    tracker_ids = set()
    yielded = 0
    for index, detections in track_frames(frames, MovingSquareDetector(), frame_rate=10):
        yielded += 1
        if detections.tracker_id is not None:
            tracker_ids.update(int(t) for t in detections.tracker_id)
    assert yielded == len(frames)
    # The single moving square should get exactly one stable ID across the clip.
    assert len(tracker_ids) == 1


def test_collect_track_masks_groups_by_id_with_masks():
    frames = _frames()
    tracks = collect_track_masks(frames, MovingSquareDetector(), frame_rate=10)
    assert len(tracks) == 1
    (entry,) = tracks.values()
    # Tracked across most frames (ByteTrack needs a frame or two to confirm the track).
    assert len(entry["frames"]) >= len(frames) - 2
    # Each stored mask is a full-frame boolean array with the square set.
    for mask in entry["frames"].values():
        assert mask.dtype == bool
        assert mask.shape == frames[0].shape[:2]
        assert mask.any()
    assert entry["class_ids"] and entry["class_ids"][0] == 7
    assert entry["confidences"] and 0.0 <= entry["confidences"][0] <= 1.0


def test_collect_track_masks_empty_when_nothing_detected():
    class NothingDetector:
        def __call__(self, frame):
            return sv.Detections.empty()

    tracks = collect_track_masks(_frames(), NothingDetector(), frame_rate=10)
    assert tracks == {}
