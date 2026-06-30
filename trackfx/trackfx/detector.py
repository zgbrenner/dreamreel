"""Detector backends for trackfx.

Model choice & licensing -- read this before swapping in a different model, since
trackfx may ship as part of a commercial product later.

* Default ("maskrcnn"): torchvision's `maskrcnn_resnet50_fpn_v2`, COCO-pretrained
  (`MaskRCNN_ResNet50_FPN_V2_Weights.DEFAULT`). torchvision's code AND the pretrained
  weights it distributes are BSD-3-Clause (https://github.com/pytorch/vision/blob/main/LICENSE),
  a permissive license with no copyleft or field-of-use restriction -- safe to embed
  in a shipped product. It returns per-instance segmentation masks, which is the
  whole point of this tool.

* "fasterrcnn": `fasterrcnn_resnet50_fpn_v2`, same family/license, COCO-pretrained,
  but boxes-only (no `masks` output). It's wired in specifically to exercise the
  "detector returns no masks" fallback path (see `masks.MaskFallback`) against a real
  model instead of only a mocked one.

* AGPL FLAG -- deliberately NOT used: Ultralytics YOLOv8/v11-seg is the obvious
  alternative (`sv.Detections.from_ultralytics` is supervision's most fully-featured
  connector, and YOLO-seg masks are good). Since Ultralytics relicensed, both the
  `ultralytics` package and its pretrained weights are AGPL-3.0 unless you hold their
  paid Enterprise license. DreamReel's CLAUDE.md hard-bans AGPL from shipped code, so
  it's disqualified here. If a future swap wants YOLO-seg for quality/speed, budget
  for an Enterprise license or pick a different (e.g. Apache-2.0) segmentation model
  first -- don't default back to plain `pip install ultralytics`.

There's no `sv.Detections.from_torchvision` connector in supervision, so
`TorchvisionDetector` below builds `sv.Detections` directly from the model's raw
output dict. That's a normal, fully-supported pattern -- `Detections` is just a plain
dataclass of arrays.
"""

from __future__ import annotations

import logging
from typing import Protocol

import numpy as np
import supervision as sv
import torch
from torchvision.models.detection import (
    FasterRCNN_ResNet50_FPN_V2_Weights,
    MaskRCNN_ResNet50_FPN_V2_Weights,
    fasterrcnn_resnet50_fpn_v2,
    maskrcnn_resnet50_fpn_v2,
)

logger = logging.getLogger(__name__)

_MASK_THRESHOLD = 0.5  # soft mask -> boolean mask cutoff


class DetectorFn(Protocol):
    def __call__(self, frame_bgr: np.ndarray) -> sv.Detections: ...


def resolve_device(requested: str) -> str:
    if requested != "auto":
        return requested
    return "cuda" if torch.cuda.is_available() else "cpu"


class TorchvisionDetector:
    """Wraps a torchvision detection model as a `frame -> sv.Detections` callable."""

    def __init__(self, model, weights, device: str, conf_threshold: float) -> None:
        self.model = model.to(device).eval()
        self.preprocess = weights.transforms()
        self.device = device
        self.conf_threshold = conf_threshold

    @torch.inference_mode()
    def __call__(self, frame_bgr: np.ndarray) -> sv.Detections:
        rgb = frame_bgr[:, :, ::-1]
        image = torch.from_numpy(np.ascontiguousarray(rgb)).permute(2, 0, 1)
        batch = [self.preprocess(image).to(self.device)]
        output = self.model(batch)[0]

        scores = output["scores"].detach().cpu().numpy()
        keep = scores >= self.conf_threshold
        if not np.any(keep):
            return sv.Detections.empty()

        xyxy = output["boxes"].detach().cpu().numpy()[keep]
        class_id = output["labels"].detach().cpu().numpy()[keep].astype(int)
        confidence = scores[keep]

        mask = None
        if "masks" in output:
            soft_masks = output["masks"].detach().cpu().numpy()[keep][:, 0]
            mask = soft_masks > _MASK_THRESHOLD

        return sv.Detections(
            xyxy=xyxy, mask=mask, confidence=confidence, class_id=class_id
        )


_BUILDERS = {
    "maskrcnn": (maskrcnn_resnet50_fpn_v2, MaskRCNN_ResNet50_FPN_V2_Weights),
    "fasterrcnn": (fasterrcnn_resnet50_fpn_v2, FasterRCNN_ResNet50_FPN_V2_Weights),
}


def build_detector(
    name: str, device: str = "auto", conf_threshold: float = 0.5
) -> TorchvisionDetector:
    if name not in _BUILDERS:
        raise ValueError(f"Unknown detector '{name}'. Available: {sorted(_BUILDERS)}")
    build_model, weights_cls = _BUILDERS[name]
    resolved_device = resolve_device(device)
    weights = weights_cls.DEFAULT
    model = build_model(weights=weights, box_score_thresh=min(conf_threshold, 0.05))
    logger.info(
        "Loaded detector '%s' on device '%s' (%d COCO classes)",
        name,
        resolved_device,
        len(weights.meta["categories"]),
    )
    return TorchvisionDetector(model, weights, resolved_device, conf_threshold)
