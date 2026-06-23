"""Web-optimize audio: trim to a per-kind window, loudness-normalize, encode to AAC/.m4a.

Parallel to publish/transcode.transcode_video. start_seconds is inserted as -ss BEFORE -i for
fast seek (skip intros / silence). Requires ffmpeg on PATH; returns None when ffmpeg is missing
or fails, so a corpus build degrades gracefully (the asset is dropped upstream)."""

from __future__ import annotations

import subprocess
from pathlib import Path

# (min_seconds, max_seconds) per AudioKind. min is advisory (used upstream to drop too-short
# clips); max is the hard trim length passed to ffmpeg -t.
AUDIO_WINDOWS: dict[str, tuple[float, float]] = {
    "music": (30.0, 90.0),
    "voice": (3.0, 10.0),
    "foley": (5.0, 20.0),
}

# EBU R128 integrated-loudness target so music/voice/foley sit at a consistent level.
LOUDNORM = "loudnorm=I=-18:TP=-1.5:LRA=11"


def build_audio_cmd(src: Path, dst: Path, kind: str, start_seconds: float = 0.0) -> list[str]:
    max_seconds = AUDIO_WINDOWS[kind][1]  # raises KeyError for unknown kinds
    return [
        "ffmpeg", "-y",
        "-ss", str(start_seconds),
        "-i", str(src),
        "-t", str(max_seconds),
        "-af", LOUDNORM,
        "-vn",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        str(dst),
    ]


def transcode_audio(src: Path, dst_dir: Path, kind: str, start_seconds: float = 0.0) -> Path | None:
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / (src.stem + ".m4a")
    cmd = build_audio_cmd(src, dst, kind, start_seconds)
    try:
        subprocess.run(cmd, check=True, capture_output=True)
        return dst
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
