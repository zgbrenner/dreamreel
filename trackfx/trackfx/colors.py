"""Deterministic per-tracker-ID color.

The same object keeps the same hue for the whole time ByteTrack holds its ID, so
tinted/echoed objects stay visually identifiable as "the same thing" across frames
instead of flickering between random colors.
"""

from __future__ import annotations

import colorsys

_GOLDEN_RATIO_CONJUGATE = 0.618033988749895


def tracker_color(tracker_id: int) -> tuple[int, int, int]:
    """Returns a BGR color (OpenCV/supervision frame convention) for a tracker ID."""
    seed = tracker_id if tracker_id >= 0 else 0
    hue = (seed * _GOLDEN_RATIO_CONJUGATE) % 1.0
    r, g, b = colorsys.hsv_to_rgb(hue, 0.65, 1.0)
    return (int(b * 255), int(g * 255), int(r * 255))
