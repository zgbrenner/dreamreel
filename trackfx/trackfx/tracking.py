"""Programmatic detect + track over in-memory frames (no video file, no effect).

`pipeline.run()` is the video-file -> effect -> video-file path. This is the lower-level
spine for callers that already hold frames in memory and want the tracked detections
themselves rather than a rendered video -- e.g. DreamReel's offline entity-sprite
extractor, which needs per-frame masks grouped by a persistent tracker ID so it can
assemble a moving cutout of the longest-lived object in a shot.

Deliberately does NOT run `DetectionsSmoother`: the smoother stabilizes boxes but
leaves `mask` as a stale passthrough (its docstring: "not compatible with segmentation
models"), and mask fidelity is the whole point here.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Iterator

import numpy as np
import supervision as sv

from .detector import DetectorFn
from .masks import MaskFallback


def track_frames(
    frames: Iterable[np.ndarray],
    detector: DetectorFn,
    *,
    frame_rate: float = 30.0,
    track_activation_threshold: float = 0.25,
) -> Iterator[tuple[int, sv.Detections]]:
    """Yield `(frame_index, tracked_detections)` for each BGR frame.

    The detections carry `tracker_id` (persistent across frames via ByteTrack) and a
    `mask` that is guaranteed populated -- a rectangular box-fallback is substituted,
    with a one-time log, if the detector is box-only. Frames must already be at the
    resolution you want masks in (resize upstream if needed).
    """
    tracker = sv.ByteTrack(
        frame_rate=frame_rate,
        track_activation_threshold=track_activation_threshold,
    )
    mask_fallback = MaskFallback()
    for index, frame in enumerate(frames):
        detections = detector(frame)
        detections = mask_fallback(detections, frame.shape[:2])
        tracked = tracker.update_with_detections(detections)
        yield index, tracked


def collect_track_masks(
    frames: list[np.ndarray],
    detector: DetectorFn,
    *,
    frame_rate: float = 30.0,
    track_activation_threshold: float = 0.25,
) -> dict[int, dict[str, object]]:
    """Group tracking output by tracker ID across a whole frame list.

    Returns `{tracker_id: {"frames": {frame_index: mask}, "class_ids": [...],
    "confidences": [...]}}`. Masks are full-frame boolean arrays. Useful when you want
    the single most-persistent object in a clip (the recurring motif): pick the
    tracker with the most frames. Loads all masks into memory, so intended for short
    clips (a shot), not whole features.
    """
    tracks: dict[int, dict[str, object]] = defaultdict(
        lambda: {"frames": {}, "class_ids": [], "confidences": []}
    )
    for index, detections in track_frames(
        frames,
        detector,
        frame_rate=frame_rate,
        track_activation_threshold=track_activation_threshold,
    ):
        if detections.tracker_id is None or detections.mask is None:
            continue
        for i in range(len(detections)):
            tid = int(detections.tracker_id[i])
            entry = tracks[tid]
            entry["frames"][index] = detections.mask[i]  # type: ignore[index]
            if detections.class_id is not None:
                entry["class_ids"].append(int(detections.class_id[i]))  # type: ignore[union-attr]
            if detections.confidence is not None:
                entry["confidences"].append(float(detections.confidence[i]))  # type: ignore[union-attr]
    return dict(tracks)
