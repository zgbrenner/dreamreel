"""Shared types for pluggable effects."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

import numpy as np
import supervision as sv


@dataclass
class EffectContext:
    """Per-frame metadata handed to an effect alongside the frame + detections.

    `state` is the same dict instance for every frame of a run (the pipeline creates
    it once), so an effect can stash arbitrary scratch state in it (e.g. an
    accumulator buffer) under its own key and have it persist across frames.
    """

    frame_index: int
    fps: float
    track_age_frames: dict[int, int]
    smoothed_xyxy: dict[int, np.ndarray]
    state: dict[str, object] = field(default_factory=dict)

    def track_age_seconds(self, tracker_id: int) -> float:
        return self.track_age_frames.get(tracker_id, 0) / max(self.fps, 1e-6)


class Effect(Protocol):
    def __call__(
        self, frame: np.ndarray, detections: sv.Detections, ctx: EffectContext
    ) -> np.ndarray: ...
