"""Pick the interior film frame that looks least like a title card / studio logo / archival
notice, using CLIP. Used for BOTH the embedding poster and the clip start so video reads as
real content. Degrades gracefully (single 30% frame) without semantic CLIP or ffprobe."""
from __future__ import annotations

import shutil
from pathlib import Path

import numpy as np

from .clip_backend import Embedder, l2_normalize
from .embed_images import embed_image_paths
from .poster import extract_poster
from .clip_window import clip_start_seconds

AVOID_PROMPTS = [
    "a title card with text", "a studio logo", "an archival film notice",
    "intertitle with words on screen", "white text on a black background",
    "copyright notice and film credits",
]

def build_avoid_vector(embedder: Embedder) -> np.ndarray:
    centroid = embedder.embed_texts(AVOID_PROMPTS).mean(axis=0)
    return l2_normalize(centroid.reshape(1, -1))[0]

def select_best_frame(
    video: Path,
    dst_dir: Path,
    embedder: Embedder,
    avoid_vec: np.ndarray,
    duration: float | None,
    fractions: tuple[float, ...] = (0.2, 0.35, 0.5, 0.65, 0.8),
) -> tuple[Path | None, float]:
    dst_dir.mkdir(parents=True, exist_ok=True)
    final = dst_dir / (video.stem + ".jpg")

    # Fallback: no semantic text scoring available, or unknown duration -> single 30% frame.
    if getattr(embedder, "backend", "") == "hash-fallback" or not duration:
        ts = clip_start_seconds(duration) if duration else 0.0
        p = extract_poster(video, dst_dir, at_seconds=ts)
        return (p, ts)

    tmp = dst_dir / "_cand"
    cands: list[tuple[Path, float]] = []
    for frac in fractions:
        ts = round(duration * frac, 3)
        p = extract_poster(video, tmp, at_seconds=ts)
        if p is not None:
            cands.append((p, ts))
    if not cands:
        ts = clip_start_seconds(duration)
        return (extract_poster(video, dst_dir, at_seconds=ts), ts)

    embs = embed_image_paths(embedder, [str(p) for p, _ in cands])
    scores = embs @ avoid_vec  # higher = more title-card-like
    best = int(np.argmin(scores))
    chosen_path, chosen_ts = cands[best]
    shutil.copyfile(chosen_path, final)
    return (final, chosen_ts)
