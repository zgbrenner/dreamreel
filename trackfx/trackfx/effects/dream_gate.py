"""Dream gate: gates the treatment by mask membership.

Tracked objects are the only crisp, "real" anchors in the frame; everything outside
their masks dissolves into a desaturated, temporally-smeared backdrop -- the dream
feeling of one or two things being sharply, certainly *there* while the rest of the
scene refuses to hold still.

Detection confidence feathers each mask's edge: a confident detection keeps a hard
boundary, an uncertain one blends softly into the dissolving background, as if the
dream hasn't fully decided what that object is.
"""

from __future__ import annotations

import cv2
import numpy as np
import supervision as sv

from . import register
from .base import EffectContext

_BLUR_KERNEL = 31
_BACKGROUND_SMEAR = 0.55  # how much of the previous dissolving background persists
_MAX_FEATHER_PX = 18
_STATE_KEY = "dream_gate_background"


def _gated_alpha(detections: sv.Detections, frame_shape: tuple[int, int]) -> np.ndarray:
    height, width = frame_shape
    alpha = np.zeros((height, width), dtype=np.float32)
    if detections.mask is None:
        return alpha

    confidences = (
        detections.confidence
        if detections.confidence is not None
        else np.ones(len(detections), dtype=np.float32)
    )
    for mask, confidence in zip(detections.mask, confidences):
        feather = int(round(_MAX_FEATHER_PX * (1.0 - float(confidence))))
        mask_u8 = mask.astype(np.uint8) * 255
        if feather > 0:
            kernel_size = feather * 2 + 1
            mask_u8 = cv2.GaussianBlur(mask_u8, (kernel_size, kernel_size), 0)
        alpha = np.maximum(alpha, mask_u8.astype(np.float32) / 255.0)
    return alpha


@register("dream_gate")
def dream_gate(
    frame: np.ndarray, detections: sv.Detections, ctx: EffectContext
) -> np.ndarray:
    height, width = frame.shape[:2]

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    desaturated = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    melted = cv2.GaussianBlur(desaturated, (_BLUR_KERNEL, _BLUR_KERNEL), 0).astype(
        np.float32
    )

    background = ctx.state.get(_STATE_KEY)
    if background is None or background.shape[:2] != (height, width):
        background = melted
    else:
        background = background * _BACKGROUND_SMEAR + melted * (1 - _BACKGROUND_SMEAR)
    ctx.state[_STATE_KEY] = background

    alpha = _gated_alpha(detections, (height, width))[..., None]
    out = frame.astype(np.float32) * alpha + background * (1 - alpha)
    return np.clip(out, 0, 255).astype(np.uint8)
