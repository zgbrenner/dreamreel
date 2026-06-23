"""Mood-score curation: keep image assets that read as uncanny/ominous, plus the anchors.

Deterministic and pure — given the same assets and cutoff it always returns the same partition.
An asset survives if it is tagged with an anchor theme (familiar contrast we always keep) OR its
max(uncanny, ominous) mood score is at least the cutoff. Everything else is dropped as off-target.
"""

from __future__ import annotations

from typing import Sequence

from ingest.themes import ANCHOR_THEMES

DEFAULT_CUTOFF = 0.52
VIDEO_CUTOFF = 0.45  # videos are scarce moving image; a gentler bar than the 0.52 image cutoff


def _is_anchor(asset: dict, anchors: Sequence[str]) -> bool:
    tags = asset.get("tags") or []
    return any(anchor in tags for anchor in anchors)


def _weird_score(asset: dict) -> float:
    mood = asset.get("mood") or {}
    return max(float(mood.get("uncanny", 0.0)), float(mood.get("ominous", 0.0)))


def curate(
    assets: list[dict],
    *,
    cutoff: float = DEFAULT_CUTOFF,
    anchors: Sequence[str] = ANCHOR_THEMES,
) -> tuple[list[dict], list[dict]]:
    """Partition assets into (kept, dropped) by mood score, exempting anchors."""
    kept: list[dict] = []
    dropped: list[dict] = []
    for a in assets:
        if _is_anchor(a, anchors) or _weird_score(a) >= cutoff:
            kept.append(a)
        else:
            dropped.append(a)
    return kept, dropped
