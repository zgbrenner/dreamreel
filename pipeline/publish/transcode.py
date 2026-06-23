"""Web-optimize media: images -> webp at a capped resolution (EXIF stripped); video -> a
short web-friendly mp4 via ffmpeg. Returns a map of source-id -> derivative path."""

from __future__ import annotations

import subprocess
from pathlib import Path

MAX_SIDE = 1600
WEBP_QUALITY = 80


def transcode_image(src: Path, dst_dir: Path) -> Path | None:
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        with Image.open(src) as im:
            im = im.convert("RGB")  # drops alpha + EXIF orientation baggage
            longest = max(im.size)
            if longest > MAX_SIDE:
                scale = MAX_SIDE / longest
                im = im.resize((int(im.width * scale), int(im.height * scale)))
            dst_dir.mkdir(parents=True, exist_ok=True)
            dst = dst_dir / (src.stem + ".webp")
            # save without EXIF
            im.save(dst, "WEBP", quality=WEBP_QUALITY, method=6)
        return dst
    except Exception:  # noqa: BLE001
        return None


def build_clip_audio_cmd(src: Path, dst: Path, max_seconds: int = 12, start_seconds: float = 0.0) -> list[str]:
    """ffmpeg argv for a short web mp4 that KEEPS its soundtrack (no -an). Used for film clips
    whose native audio the runtime ducks in when the clip is a hero layer."""
    return [
        "ffmpeg", "-y",
        "-ss", str(start_seconds),
        "-i", str(src),
        "-t", str(max_seconds),
        "-vf", f"scale='min({MAX_SIDE},iw)':-2",
        "-c:v", "libx264", "-crf", "26", "-preset", "medium",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        str(dst),
    ]


def transcode_video_with_audio(src: Path, dst_dir: Path, max_seconds: int = 12, start_seconds: float = 0.0) -> Path | None:
    """Clip + downscale a film to a short web mp4 preserving the soundtrack. Requires ffmpeg on PATH."""
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / (src.stem + ".mp4")
    cmd = build_clip_audio_cmd(src, dst, max_seconds, start_seconds)
    try:
        subprocess.run(cmd, check=True, capture_output=True)
        return dst
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def transcode_video(src: Path, dst_dir: Path, max_seconds: int = 12, start_seconds: float = 0.0) -> Path | None:
    """Clip + downscale a public-domain film to a short web mp4. Requires ffmpeg on PATH.

    start_seconds is inserted as ``-ss`` BEFORE ``-i`` for fast seek so the clip skips intro
    title cards / logos. Use clip_window.clip_start_seconds to compute a deterministic interior
    offset (~30% into the film) so the poster embedding and the clip show the same content.
    """
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / (src.stem + ".mp4")
    cmd = [
        "ffmpeg", "-y",
        "-ss", str(start_seconds),
        "-i", str(src),
        "-t", str(max_seconds),
        "-vf", f"scale='min({MAX_SIDE},iw)':-2",
        "-c:v", "libx264", "-crf", "26", "-preset", "medium",
        "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart",
        str(dst),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
        return dst
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
