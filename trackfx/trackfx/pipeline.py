"""Core video processing loop: decode -> detect -> track -> smooth -> effect -> encode.

Built directly on supervision's documented video-IO + tracking pattern (`VideoInfo`,
`get_video_frames_generator`, `VideoSink`, `ByteTrack.update_with_detections`) rather
than `sv.process_video`'s threaded helper, so the proxy/full-res resize step can sit
cleanly between decode and inference.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import supervision as sv

from .detector import DetectorFn
from .effects.base import Effect, EffectContext
from .masks import MaskFallback
from .video_io import compute_target_size, resize_frame

logger = logging.getLogger(__name__)


@dataclass
class RunConfig:
    source_path: str
    target_path: str
    effect: Effect
    detector: DetectorFn
    proxy_width: int | None = None  # None => full source resolution
    max_frames: int | None = None
    smoother_window: int = 5
    track_activation_threshold: float = 0.25
    show_progress: bool = True


def run(config: RunConfig) -> None:
    video_info = sv.VideoInfo.from_video_path(config.source_path)
    target_w, target_h = compute_target_size(video_info.resolution_wh, config.proxy_width)
    needs_resize = (target_w, target_h) != video_info.resolution_wh
    output_info = sv.VideoInfo(
        width=target_w, height=target_h, fps=video_info.fps, total_frames=video_info.total_frames
    )

    tracker = sv.ByteTrack(
        frame_rate=video_info.fps,
        track_activation_threshold=config.track_activation_threshold,
    )
    smoother = sv.DetectionsSmoother(length=config.smoother_window)
    mask_fallback = MaskFallback()

    track_first_seen: dict[int, int] = {}
    effect_state: dict[str, object] = {}
    detections_seen = 0

    frame_generator = sv.get_video_frames_generator(config.source_path, end=config.max_frames)
    frames = enumerate(frame_generator)
    if config.show_progress:
        frames = _with_progress_bar(frames, config, output_info)

    with sv.VideoSink(config.target_path, video_info=output_info) as sink:
        for frame_index, frame in frames:
            if needs_resize:
                frame = resize_frame(frame, target_w, target_h)

            raw_detections = config.detector(frame)
            raw_detections = mask_fallback(raw_detections, frame.shape[:2])

            tracked = tracker.update_with_detections(raw_detections)
            smoothed = smoother.update_with_detections(tracked)
            # DetectionsSmoother smooths `xyxy`/`confidence` but -- per its own
            # docstring ("This class is not compatible with segmentation models") --
            # leaves `mask` as a stale passthrough from the oldest frame in its
            # window. So we keep rendering from `tracked` (this frame's real masks)
            # and only borrow `smoothed`'s jitter-stabilized boxes as supplementary
            # metadata (glitch_resolve uses it to scale displacement to object size
            # without flickering on box jitter).
            smoothed_xyxy = (
                {int(tid): box for tid, box in zip(smoothed.tracker_id, smoothed.xyxy)}
                if smoothed.tracker_id is not None
                else {}
            )

            if tracked.tracker_id is not None:
                detections_seen += len(tracked)
                for tracker_id in tracked.tracker_id:
                    track_first_seen.setdefault(int(tracker_id), frame_index)
            track_age_frames = {
                tid: frame_index - first_seen + 1
                for tid, first_seen in track_first_seen.items()
            }

            ctx = EffectContext(
                frame_index=frame_index,
                fps=video_info.fps,
                track_age_frames=track_age_frames,
                smoothed_xyxy=smoothed_xyxy,
                state=effect_state,
            )
            sink.write_frame(config.effect(frame, tracked, ctx))

    if detections_seen == 0:
        logger.warning(
            "No objects were detected/tracked across the whole video -- the output "
            "is effectively a pass-through of the (possibly resized) source. Check "
            "--detector/--conf-threshold, or confirm the input actually contains "
            "objects the model recognizes."
        )


def _with_progress_bar(frames, config: RunConfig, output_info: sv.VideoInfo):
    try:
        from tqdm import tqdm
    except ImportError:
        return frames
    total = output_info.total_frames
    if config.max_frames is not None and total is not None:
        total = min(total, config.max_frames)
    return tqdm(frames, total=total, desc="trackfx", unit="frame")
