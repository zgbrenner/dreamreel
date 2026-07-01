"""Trivial proof-of-pipeline effect: flat-tint every tracked mask.

This is intentionally dumb. It exists to validate the IO/detect/track plumbing in
isolation -- if a mask lands in the wrong place or the wrong color sticks to the
wrong tracker ID here, that's a pipeline bug, not an effects bug.
"""

from __future__ import annotations

import numpy as np
import supervision as sv

from ..colors import tracker_color
from . import register
from .base import EffectContext

_ALPHA = 0.45


@register("tint")
def tint(frame: np.ndarray, detections: sv.Detections, ctx: EffectContext) -> np.ndarray:
    if len(detections) == 0 or detections.mask is None:
        return frame

    out = frame.astype(np.float32)
    tracker_ids = (
        detections.tracker_id
        if detections.tracker_id is not None
        else range(len(detections))
    )
    for mask, tracker_id in zip(detections.mask, tracker_ids):
        color = np.array(tracker_color(int(tracker_id)), dtype=np.float32)
        out[mask] = out[mask] * (1 - _ALPHA) + color * _ALPHA
    return np.clip(out, 0, 255).astype(np.uint8)
