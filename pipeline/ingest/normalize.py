"""Candidate model + normalization, and the license gate applied at ingest time."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable, Literal

from pydantic import BaseModel, Field

from .licenses import evaluate

AssetType = Literal["image", "video", "audio"]


class Candidate(BaseModel):
    """A normalized ingest record, before download/embedding."""

    source_url: str = Field(..., description="direct media URL")
    type: AssetType
    source: str = Field(..., description="human-readable provenance, e.g. 'Openverse / Flickr Commons'")
    license: str
    attribution: str | None = None
    attribution_url: str | None = None
    tags: list[str] = Field(default_factory=list)
    query_theme: str = ""
    foreign_landing_url: str | None = None


class Rejection(BaseModel):
    source_url: str
    source: str
    raw_license: str
    reason: str


def make_candidate(
    *,
    source_url: str,
    type: AssetType,
    source: str,
    raw_license: str | None,
    license_version: str | None = None,
    creator: str | None = None,
    attribution_url: str | None = None,
    tags: Iterable[str] = (),
    query_theme: str = "",
    foreign_landing_url: str | None = None,
) -> tuple[Candidate | None, Rejection | None]:
    """Apply the license gate; return (candidate, None) if kept or (None, rejection)."""
    attribution = None
    if creator:
        attribution = f"{creator}" + (f" — {source}" if source else "")
    decision = evaluate(raw_license, license_version, attribution)
    if not decision.keep:
        return None, Rejection(
            source_url=source_url,
            source=source,
            raw_license=str(raw_license),
            reason=decision.reason,
        )
    cand = Candidate(
        source_url=source_url,
        type=type,
        source=source,
        license=decision.normalized,
        attribution=attribution if decision.requires_attribution else None,
        attribution_url=attribution_url if decision.requires_attribution else None,
        tags=[t for t in tags if t],
        query_theme=query_theme,
        foreign_landing_url=foreign_landing_url,
    )
    return cand, None


def write_candidates(candidates: Iterable[Candidate], path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with path.open("w", encoding="utf-8") as f:
        for c in candidates:
            f.write(c.model_dump_json() + "\n")
            n += 1
    return n


def write_rejections(rejections: Iterable[Rejection], path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with path.open("w", encoding="utf-8") as f:
        for r in rejections:
            f.write(r.model_dump_json() + "\n")
            n += 1
    return n
