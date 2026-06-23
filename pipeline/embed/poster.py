# pipeline/embed/poster.py
"""Extract a single representative still from a video for CLIP embedding.

The poster frame is what gives a video asset its place in embedding space (the dreamwalker
selects by embedding, media-agnostically). Requires ffmpeg on PATH; returns None on absence
or failure so the caller can skip the candidate without crashing the build.
"""
from __future__ import annotations

import subprocess
from pathlib import Path


def extract_poster(video: Path, dst_dir: Path, at_seconds: float = 1.0) -> Path | None:
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / (video.stem + ".jpg")
    cmd = [
        "ffmpeg", "-y",
        "-ss", str(at_seconds),
        "-i", str(video),
        "-frames:v", "1",
        "-q:v", "2",
        str(dst),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    return dst if dst.exists() else None
