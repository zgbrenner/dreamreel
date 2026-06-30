"""Glitch resolve: a shape that "won't resolve," then does.

Combines confidence and track age. A detection that's both new and uncertain gets an
analog-glitch treatment (RGB channel splitting, masked to just that object); the
longer ByteTrack keeps a stable ID on it, the more the glitch settles, so the object
gradually resolves into something the dream is sure about. Deliberately driven by
*track age* rather than raw per-frame confidence, so a momentary confidence dip on an
otherwise long-lived track doesn't make it flicker again -- once the dream commits to
an object, it stays committed.
"""

from __future__ import annotations

import numpy as np
import supervision as sv

from . import register
from .base import EffectContext

_RESOLVE_SECONDS = 3.0
_MAX_SHIFT_PX = 14
_MIN_GLITCH_AMOUNT = 0.02


def _shift_channel(channel: np.ndarray, mask: np.ndarray, dx: int) -> np.ndarray:
    if dx == 0:
        return channel
    shifted = np.roll(channel, dx, axis=1)
    out = channel.copy()
    out[mask] = shifted[mask]
    return out


@register("glitch_resolve")
def glitch_resolve(
    frame: np.ndarray, detections: sv.Detections, ctx: EffectContext
) -> np.ndarray:
    if len(detections) == 0 or detections.mask is None:
        return frame

    out = frame.copy()
    confidences = (
        detections.confidence
        if detections.confidence is not None
        else np.ones(len(detections), dtype=np.float32)
    )
    tracker_ids = (
        detections.tracker_id
        if detections.tracker_id is not None
        else range(len(detections))
    )

    for mask, confidence, tracker_id in zip(detections.mask, confidences, tracker_ids):
        tracker_id = int(tracker_id)
        resolved = min(ctx.track_age_seconds(tracker_id) / _RESOLVE_SECONDS, 1.0)
        glitch_amount = (1.0 - float(confidence)) * (1.0 - resolved)
        if glitch_amount <= _MIN_GLITCH_AMOUNT:
            continue

        box = ctx.smoothed_xyxy.get(tracker_id)
        box_width = float(box[2] - box[0]) if box is not None else float(mask.shape[1])
        shift_px = int(round(min(glitch_amount * _MAX_SHIFT_PX, box_width * 0.25)))
        if shift_px == 0:
            continue

        out[..., 0] = _shift_channel(out[..., 0], mask, -shift_px)
        out[..., 2] = _shift_channel(out[..., 2], mask, shift_px)

    return out
