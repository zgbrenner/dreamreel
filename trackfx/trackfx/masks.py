"""Graceful fallback for detectors that only return boxes, not segmentation masks."""

from __future__ import annotations

import logging

import numpy as np
import supervision as sv

logger = logging.getLogger(__name__)


def boxes_to_masks(xyxy: np.ndarray, frame_shape: tuple[int, int]) -> np.ndarray:
    """Synthesizes rectangular boolean masks from boxes, shape `(n, H, W)`."""
    height, width = frame_shape
    masks = np.zeros((len(xyxy), height, width), dtype=bool)
    for i, (x1, y1, x2, y2) in enumerate(xyxy):
        x1c = max(int(round(float(x1))), 0)
        y1c = max(int(round(float(y1))), 0)
        x2c = min(int(round(float(x2))), width)
        y2c = min(int(round(float(y2))), height)
        if x2c > x1c and y2c > y1c:
            masks[i, y1c:y2c, x1c:x2c] = True
    return masks


class MaskFallback:
    """Falls back to box-shaped masks when a detector never populates `.mask`.

    Every effect in this project is mask-driven. A box-only detector (Faster R-CNN, a
    plain detection-only YOLO export, etc.) would otherwise make the tool look like it
    silently does nothing. Instead we degrade to a rectangular mask -- worse edge
    quality, but still a visible, debuggable result -- and log once so it's obvious
    why.
    """

    def __init__(self) -> None:
        self._warned = False

    def __call__(
        self, detections: sv.Detections, frame_shape: tuple[int, int]
    ) -> sv.Detections:
        if detections.mask is not None or len(detections) == 0:
            return detections
        if not self._warned:
            logger.warning(
                "Detector produced no segmentation masks (boxes only) -- falling "
                "back to rectangular masks for mask-driven effects. Edge quality "
                "will look boxy. Use a segmentation-capable detector (the default "
                "'maskrcnn') for pixel-accurate masks."
            )
            self._warned = True
        detections.mask = boxes_to_masks(detections.xyxy, frame_shape)
        return detections
