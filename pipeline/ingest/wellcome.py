"""Wellcome Collection ingester via the public catalogue API (plain requests, no AGPL client).

Wellcome's images endpoint aggregates a large public-domain/CC-BY medical, anatomical, and
occult archive — ideal uncanny material. We query by theme, map each hit through the license
gate, and build a usable IIIF image URL.

Response fields used (verified against a real 2026-06-18 response, do not invent fields):
  results[].id, results[].locations[0].{url,credit,license.id}, results[].source.{id,title}
"""

from __future__ import annotations

import time
from typing import Iterator

import requests

from .normalize import Candidate, Rejection, make_candidate
from .themes import OPENVERSE_THEMES

API = "https://api.wellcomecollection.org/catalogue/v2/images"
WORKS = "https://wellcomecollection.org/works"
USER_AGENT = "DREAMREEL-corpus/0.1 (+https://dreamreel.example; respectful crawler)"
# IIIF image request appended to the image base (info.json stripped).
IIIF_SUFFIX = "/full/!1024,1024/0/default.jpg"
_INFO = "/info.json"


def _image_url(location_url: str) -> str | None:
    """Turn an IIIF info.json URL into a concrete downloadable image URL."""
    if not location_url.endswith(_INFO):
        return None
    return location_url[: -len(_INFO)] + IIIF_SUFFIX


def ingest(
    themes: list[str] | None = None,
    per_theme: int = 30,
    page_size: int = 30,
) -> Iterator[tuple[Candidate | None, Rejection | None]]:
    themes = themes or OPENVERSE_THEMES
    headers = {"User-Agent": USER_AGENT}
    for theme in themes:
        fetched = 0
        page = 1
        while fetched < per_theme:
            params = {"query": theme, "page": page, "pageSize": min(page_size, per_theme - fetched)}
            try:
                r = requests.get(API, params=params, headers=headers, timeout=30)
                if r.status_code == 429:
                    time.sleep(5)
                    continue
                r.raise_for_status()
                results = r.json().get("results", [])
            except requests.RequestException:
                break
            if not results:
                break
            for item in results:
                locs = item.get("locations") or []
                if not locs:
                    continue
                loc = locs[0]
                img = _image_url(loc.get("url", ""))
                if not img:
                    continue
                src = item.get("source") or {}
                work_id = src.get("id")
                lic = (loc.get("license") or {}).get("id")
                yield make_candidate(
                    source_url=img,
                    type="image",
                    source="Wellcome Collection",
                    raw_license=lic,
                    creator=loc.get("credit"),
                    attribution_url=f"{WORKS}/{work_id}" if work_id else None,
                    tags=[theme, str(src.get("title", ""))[:40]],
                    query_theme=theme,
                    foreign_landing_url=f"{WORKS}/{work_id}" if work_id else None,
                )
            fetched += len(results)
            page += 1
            time.sleep(1.0)  # be polite
