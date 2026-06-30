"""trackfx CLI: detect+segment+track objects in a video and run a pluggable surreal
effect over them.

Examples:
    python -m trackfx input.mp4 output.mp4 --effect ghost_trail
    python -m trackfx input.mp4 preview.mp4 --effect dream_gate --mode proxy
    python -m trackfx input.mp4 out.mp4 --effect tint --detector fasterrcnn  # boxes-only fallback
"""

from __future__ import annotations

import argparse
import logging

from . import effects
from .detector import build_detector
from .pipeline import RunConfig, run

DEFAULT_PROXY_WIDTH = 640


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Track-driven surreal video effects (DreamReel's trackfx)."
    )
    parser.add_argument("input", help="Path to the source video.")
    parser.add_argument("output", help="Path to write the rendered video to.")
    parser.add_argument(
        "--effect", choices=effects.available(), required=True, help="Which effect to render."
    )
    parser.add_argument(
        "--mode",
        choices=["proxy", "full"],
        default="full",
        help="proxy = fast downsampled preview, full = native resolution (default).",
    )
    parser.add_argument(
        "--proxy-width",
        type=int,
        default=DEFAULT_PROXY_WIDTH,
        help=f"Max frame width in proxy mode (default {DEFAULT_PROXY_WIDTH}px, aspect preserved).",
    )
    parser.add_argument(
        "--detector",
        choices=["maskrcnn", "fasterrcnn"],
        default="maskrcnn",
        help="maskrcnn (default) returns segmentation masks; fasterrcnn is boxes-only, "
        "useful for exercising the no-mask fallback path.",
    )
    parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    parser.add_argument("--conf-threshold", type=float, default=0.5)
    parser.add_argument(
        "--smoother-window",
        type=int,
        default=5,
        help="DetectionsSmoother history length in frames (smooths boxes/confidence, not masks).",
    )
    parser.add_argument("--track-activation-threshold", type=float, default=0.25)
    parser.add_argument(
        "--max-frames", type=int, default=None, help="Stop after N frames (handy while iterating)."
    )
    parser.add_argument("--no-progress", action="store_true")
    parser.add_argument("--log-level", default="INFO")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    logging.basicConfig(level=args.log_level, format="%(levelname)s %(name)s: %(message)s")

    detector = build_detector(args.detector, device=args.device, conf_threshold=args.conf_threshold)
    effect = effects.get(args.effect)
    proxy_width = args.proxy_width if args.mode == "proxy" else None

    run(
        RunConfig(
            source_path=args.input,
            target_path=args.output,
            effect=effect,
            detector=detector,
            proxy_width=proxy_width,
            max_frames=args.max_frames,
            smoother_window=args.smoother_window,
            track_activation_threshold=args.track_activation_threshold,
            show_progress=not args.no_progress,
        )
    )


if __name__ == "__main__":
    main()
