"""Uncanny query catalog + anchors — the single source of truth for corpus curation.

Three veins of broad-uncanny subject matter (clinical, occult, liminal-nature) plus a small
set of familiar ANCHOR themes kept for dream-logic contrast. The anchors are exempt from the
mood-score curation filter (embed/curate.py) so a floor of recognizable imagery always survives.
"""

from __future__ import annotations

from collections.abc import Iterable

# Familiar imagery kept for contrast; exempt from mood curation.
ANCHOR_THEMES: tuple[str, ...] = ("ruins", "faces", "antique photograph")

# --- the three uncanny veins ---
CLINICAL: tuple[str, ...] = (
    "anatomical illustration",
    "dissection plate",
    "human skeleton",
    "x-ray",
    "medical specimen",
    "phrenology head",
    "taxidermy",
)
OCCULT: tuple[str, ...] = (
    "death mask",
    "memento mori",
    "occult symbol",
    "alchemical diagram",
    "spirit photography",
    "ritual mask",
)
LIMINAL: tuple[str, ...] = (
    "deep sea creature",
    "fungus",
    "cave",
    "decay",
    "moth",
    "abandoned",
)


def _dedup(seq: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in seq:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


# Openverse: all three veins + anchors.
OPENVERSE_THEMES: list[str] = _dedup([*CLINICAL, *OCCULT, *LIMINAL, *ANCHOR_THEMES])

# Museums (Met/Smithsonian) skew toward objects/plates; a tuned subset reads best there.
MUSEUM_THEMES: list[str] = _dedup(
    [
        "anatomical",
        "death mask",
        "memento mori",
        "skull",
        "ritual mask",
        "specimen",
        "alchemical",
        *ANCHOR_THEMES,
    ]
)
