"""End-to-end pipeline test using a stub detector -- no model download or network
needed.

Exercises exactly what the brief asked to prove first: a trivial effect round-tripping
through real supervision video IO (`VideoInfo` / `get_video_frames_generator` /
`VideoSink`), `ByteTrack`, and `DetectionsSmoother`. `detector.py`'s real torchvision
backend is intentionally not exercised here (downloading ~170MB of COCO weights isn't
appropriate for a fast unit test suite); it's exercised manually via the CLI.
"""

import logging

import cv2
import numpy as np
import supervision as sv

from trackfx import effects
from trackfx.pipeline import RunConfig, run


def _write_synthetic_video(path, num_frames=6, size=(64, 48)):
    width, height = size
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 10, (width, height))
    for i in range(num_frames):
        frame = np.full((height, width, 3), 30, dtype=np.uint8)
        x = 5 + i * 4
        frame[10:30, x : x + 15] = (200, 200, 200)
        writer.write(frame)
    writer.release()


class StubDetector:
    """Mimics a real model's `sv.Detections` output (xyxy/mask/confidence/class_id)
    by bounding-boxing the bright synthetic square, without running an actual model.
    """

    def __call__(self, frame: np.ndarray) -> sv.Detections:
        height, width = frame.shape[:2]
        ys, xs = np.where(frame[..., 0] > 150)
        if len(xs) == 0:
            return sv.Detections.empty()
        x1, x2, y1, y2 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
        mask = np.zeros((1, height, width), dtype=bool)
        mask[0, y1:y2, x1:x2] = True
        return sv.Detections(
            xyxy=np.array([[x1, y1, x2, y2]], dtype=np.float32),
            mask=mask,
            confidence=np.array([0.9], dtype=np.float32),
            class_id=np.array([0]),
        )


class BoxesOnlyStubDetector(StubDetector):
    """Same as StubDetector but never populates `.mask`, to exercise the fallback."""

    def __call__(self, frame: np.ndarray) -> sv.Detections:
        detections = super().__call__(frame)
        detections.mask = None
        return detections


def test_pipeline_roundtrip_full_resolution(tmp_path):
    source = tmp_path / "source.mp4"
    target = tmp_path / "out.mp4"
    _write_synthetic_video(source)

    run(
        RunConfig(
            source_path=str(source),
            target_path=str(target),
            effect=effects.get("tint"),
            detector=StubDetector(),
            proxy_width=None,
            show_progress=False,
        )
    )

    assert target.exists()
    out_info = sv.VideoInfo.from_video_path(str(target))
    assert out_info.total_frames == 6
    assert out_info.resolution_wh == (64, 48)


def test_pipeline_roundtrip_proxy_mode_resizes(tmp_path):
    source = tmp_path / "source.mp4"
    target = tmp_path / "out.mp4"
    _write_synthetic_video(source, size=(64, 48))

    run(
        RunConfig(
            source_path=str(source),
            target_path=str(target),
            effect=effects.get("dream_gate"),
            detector=StubDetector(),
            proxy_width=32,
            show_progress=False,
        )
    )

    out_info = sv.VideoInfo.from_video_path(str(target))
    assert out_info.resolution_wh[0] <= 32
    assert out_info.resolution_wh[0] % 2 == 0


def test_pipeline_handles_boxes_only_detector(tmp_path, caplog):
    source = tmp_path / "source.mp4"
    target = tmp_path / "out.mp4"
    _write_synthetic_video(source)

    with caplog.at_level(logging.WARNING):
        run(
            RunConfig(
                source_path=str(source),
                target_path=str(target),
                effect=effects.get("ghost_trail"),
                detector=BoxesOnlyStubDetector(),
                proxy_width=None,
                show_progress=False,
            )
        )

    assert target.exists()
    assert any("falling back to rectangular masks" in r.message for r in caplog.records)


def test_pipeline_warns_when_nothing_is_ever_detected(tmp_path, caplog):
    source = tmp_path / "source.mp4"
    target = tmp_path / "out.mp4"
    _write_synthetic_video(source)

    class NothingDetector:
        def __call__(self, frame: np.ndarray) -> sv.Detections:
            return sv.Detections.empty()

    with caplog.at_level(logging.WARNING):
        run(
            RunConfig(
                source_path=str(source),
                target_path=str(target),
                effect=effects.get("tint"),
                detector=NothingDetector(),
                proxy_width=None,
                show_progress=False,
            )
        )

    assert any("No objects were detected" in r.message for r in caplog.records)
