"""Where to sample a film: skip the intro (title cards / logos) by seeking ~30% in, clamped so
a short clip still fits before the end. Shared by poster extraction (embed) and clip transcode
(publish) so the embedding matches what the clip shows."""
from __future__ import annotations
import subprocess
from pathlib import Path

CLIP_SECONDS = 12

def clip_start_seconds(duration: float, clip_seconds: int = CLIP_SECONDS) -> float:
    """Deterministic interior start offset: ~30% in, but never so late a clip_seconds clip would
    run past the end. Returns 0.0 for very short/None-ish durations."""
    if duration is None or duration <= 0:
        return 0.0
    target = duration * 0.30
    latest = max(0.0, duration - clip_seconds - 1.0)
    return round(min(target, latest), 3)

def probe_duration(path: Path) -> float | None:
    """Film duration in seconds via ffprobe; None if ffprobe is missing/fails or output unparseable."""
    cmd = ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)]
    try:
        out = subprocess.run(cmd, check=True, capture_output=True, text=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    try:
        return float(out.stdout.strip())
    except (ValueError, AttributeError):
        return None
