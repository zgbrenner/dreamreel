import logging

import numpy as np
import supervision as sv

from trackfx.masks import MaskFallback, boxes_to_masks


def test_boxes_to_masks_fills_rectangle():
    xyxy = np.array([[2, 3, 6, 8]], dtype=np.float32)
    masks = boxes_to_masks(xyxy, (10, 10))
    assert masks.shape == (1, 10, 10)
    assert masks[0, 3:8, 2:6].all()
    assert not masks[0, 0, 0]


def test_boxes_to_masks_clips_to_frame_bounds():
    xyxy = np.array([[-5, -5, 4, 4]], dtype=np.float32)
    masks = boxes_to_masks(xyxy, (10, 10))
    assert masks[0, 0:4, 0:4].all()


def test_mask_fallback_leaves_real_masks_untouched():
    real_mask = np.zeros((1, 5, 5), dtype=bool)
    real_mask[0, 0, 0] = True
    detections = sv.Detections(
        xyxy=np.array([[0, 0, 1, 1]], dtype=np.float32), mask=real_mask
    )
    out = MaskFallback()(detections, (5, 5))
    assert out.mask is real_mask


def test_mask_fallback_synthesizes_and_warns_once(caplog):
    detections = sv.Detections(xyxy=np.array([[1, 1, 3, 3]], dtype=np.float32))
    fallback = MaskFallback()

    with caplog.at_level(logging.WARNING):
        out1 = fallback(detections, (5, 5))
        out2 = fallback(detections, (5, 5))

    assert out1.mask is not None
    assert out1.mask.shape == (1, 5, 5)
    assert out2.mask is not None
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1


def test_mask_fallback_skips_empty_detections():
    out = MaskFallback()(sv.Detections.empty(), (5, 5))
    assert out.mask is None
