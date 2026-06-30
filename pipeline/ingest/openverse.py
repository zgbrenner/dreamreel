"""Openverse API ingester.

Openverse aggregates openly-licensed media. We query by theme, paginate politely, and map
each result to a Candidate through the license gate. No API key is required for basic use; if
OPENVERSE_CLIENT_ID / OPENVERSE_CLIENT_SECRET are set in the env we use a token for higher
rate limits. Never hard-code credentials.

Response fields used (verified against the v1 API, do not invent fields):
  url, license, license_version, creator, source, foreign_landing_url, title, tags[].name
"""

from __future__ import annotations

import os
import time
from typing import Iterator

import requests

from .normalize import Candidate, Rejection, make_candidate
from .themes import OPENVERSE_THEMES

API = "https://api.openverse.org/v1"
USER_AGENT = "DREAMREEL-corpus/0.1 (+https://dreamreel.example; respectful crawler)"

# Default query catalog: the uncanny veins + anchors (see ingest/themes.py).
THEMES = OPENVERSE_THEMES


def _token() -> str | None:
    cid = os.environ.get("OPENVERSE_CLIENT_ID")
    secret = os.environ.get("OPENVERSE_CLIENT_SECRET")
    if not (cid and secret):
        return None
    try:
        r = requests.post(
            f"{API}/auth_tokens/token/",
            data={"grant_type": "client_credentials", "client_id": cid, "client_secret": secret},
            timeout=20,
        )
        r.raise_for_status()
        return r.json().get("access_token")
    except requests.RequestException:
        return None


def ingest(
    themes: list[str] | None = None,
    media: str = "images",  # "images" or "audio"
    # Video-first direction (CLAUDE.md): a still photo is now routed to the rare flash-frame /
    # ghost path, never a held primary beat — so the corpus needs FAR fewer distinct images than
    # when images were equal-weight primary media. Lowered from 60 alongside archive_org's raised
    # video volume (see ingest/archive_org.py COLLECTIONS/rows_per_collection).
    per_theme: int = 20,
    page_size: int = 30,
) -> Iterator[tuple[Candidate | None, Rejection | None]]:
    themes = themes or THEMES
    headers = {"User-Agent": USER_AGENT}
    tok = _token()
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    asset_type = "image" if media == "images" else "audio"

    for theme in themes:
        fetched = 0
        page = 1
        while fetched < per_theme:
            params = {
                "q": theme,
                "page": page,
                "page_size": min(page_size, per_theme - fetched),
                # request only the licenses we can ship; the gate re-checks regardless.
                "license": "cc0,pdm,by",
            }
            try:
                r = requests.get(f"{API}/{media}/", params=params, headers=headers, timeout=30)
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
                tags = [t.get("name", "") for t in item.get("tags", []) if isinstance(t, dict)]
                yield make_candidate(
                    source_url=item.get("url", ""),
                    type=asset_type,
                    source=f"Openverse / {item.get('source', 'unknown')}",
                    raw_license=item.get("license"),
                    license_version=str(item.get("license_version") or ""),
                    creator=item.get("creator"),
                    attribution_url=item.get("foreign_landing_url"),
                    tags=[theme, *tags],
                    query_theme=theme,
                    foreign_landing_url=item.get("foreign_landing_url"),
                )
            fetched += len(results)
            page += 1
            time.sleep(1.0)  # be polite
