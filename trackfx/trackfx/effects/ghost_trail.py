"""Ghost trail: objects bloom into a fading double-exposure echo the longer they're
tracked.

Exploits *track age* (how many consecutive frames ByteTrack has held this ID) as a
temporal-coherence signal: a detection that just appeared leaves no trail at all;
something the tracker has held onto for a couple of seconds starts smearing a
colorized afterimage behind it, like a long exposure layered into the dream. A single
bounded accumulator buffer (not a deque per tracker) holds the trail, so memory use
doesn't grow with the number of objects seen over a long video.
"""

from __future__ import annotations

import numpy as np
import supervision as sv

from ..colors import tracker_color
from . import register
from .base import EffectContext

_DECAY = 0.90  # per-frame fade of the accumulated trail
_RAMP_SECONDS = 2.5  # how long a track must persist before its echo is at full strength
_MAX_TRAIL_ALPHA = 0.65
_STATE_KEY = "ghost_trail_accumulator"


@register("ghost_trail")
def ghost_trail(
    frame: np.ndarray, detections: sv.Detections, ctx: EffectContext
) -> np.ndarray:
    height, width = frame.shape[:2]
    accumulator = ctx.state.get(_STATE_KEY)
    if accumulator is None or accumulator.shape[:2] != (height, width):
        accumulator = np.zeros((height, width, 3), dtype=np.float32)
    accumulator *= _DECAY

    if len(detections) > 0 and detections.mask is not None:
        tinted = frame.astype(np.float32)
        tracker_ids = (
            detections.tracker_id
            if detections.tracker_id is not None
            else range(len(detections))
        )
        for mask, tracker_id in zip(detections.mask, tracker_ids):
            tracker_id = int(tracker_id)
            strength = min(ctx.track_age_seconds(tracker_id) / _RAMP_SECONDS, 1.0)
            if strength <= 0:
                continue
            color = np.array(tracker_color(tracker_id), dtype=np.float32)
            echo = tinted[mask] * 0.5 + color * 0.5
            accumulator[mask] = np.maximum(accumulator[mask], echo * strength)

    ctx.state[_STATE_KEY] = accumulator
    trail_alpha = np.clip(
        accumulator.max(axis=2, keepdims=True) / 255.0, 0, _MAX_TRAIL_ALPHA
    )
    out = frame.astype(np.float32) * (1 - trail_alpha) + accumulator * trail_alpha
    return np.clip(out, 0, 255).astype(np.uint8)
