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


def transcode_video(src: Path, dst_dir: Path, max_seconds: int = 12) -> Path | None:
    """Clip + downscale a public-domain film to a short web mp4. Requires ffmpeg on PATH."""
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / (src.stem + ".mp4")
    cmd = [
        "ffmpeg", "-y", "-i", str(src),
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
