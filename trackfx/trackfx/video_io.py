"""Resize helpers for the proxy (fast preview) vs full-resolution render modes."""

from __future__ import annotations

import cv2
import numpy as np


def _round_even(value: float) -> int:
    rounded = int(round(value))
    return rounded - (rounded % 2) if rounded > 2 else 2


def compute_target_size(
    source_wh: tuple[int, int], max_width: int | None
) -> tuple[int, int]:
    """Returns the (width, height) to actually process/encode at.

    `max_width=None` (or >= the source width) means full source resolution -- this is
    the "final render" path. Otherwise the frame is downscaled (never upscaled) so its
    width is <= max_width, preserving aspect ratio, with both dimensions rounded to
    even numbers since most video codecs (mp4v included) require that.
    """
    width, height = source_wh
    if not max_width or max_width >= width:
        return width, height
    scale = max_width / width
    return _round_even(width * scale), _round_even(height * scale)


def resize_frame(frame: np.ndarray, width: int, height: int) -> np.ndarray:
    return cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)
