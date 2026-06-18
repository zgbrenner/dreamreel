"""Optional museum CC0 open-access ingesters (Met, Smithsonian).

Both expose public APIs with CC0 open-access subsets. Smithsonian requires an API key
(SMITHSONIAN_API_KEY in env); the Met does not. Keys are read from the env, never committed.
"""

from __future__ import annotations

import os
import time
from typing import Iterator

import requests

from .normalize import Candidate, Rejection, make_candidate
from .themes import MUSEUM_THEMES

MET_SEARCH = "https://collectionapi.metmuseum.org/public/collection/v1/search"
MET_OBJECT = "https://collectionapi.metmuseum.org/public/collection/v1/objects"
SI_SEARCH = "https://api.si.edu/openaccess/api/v1.0/search"
USER_AGENT = "DREAMREEL-corpus/0.1 (+https://dreamreel.example)"

# Museum search vocabulary skews to objects/plates (see ingest/themes.py).
THEMES = MUSEUM_THEMES


def ingest_met(themes: list[str] | None = None, per_theme: int = 20) -> Iterator[
    tuple[Candidate | None, Rejection | None]
]:
    themes = themes or THEMES
    for theme in themes:
        try:
            r = requests.get(
                MET_SEARCH,
                params={"q": theme, "hasImages": "true", "isPublicDomain": "true"},
                headers={"User-Agent": USER_AGENT},
                timeout=30,
            )
            r.raise_for_status()
            ids = (r.json().get("objectIDs") or [])[:per_theme]
        except requests.RequestException:
            continue
        for oid in ids:
            try:
                o = requests.get(f"{MET_OBJECT}/{oid}", headers={"User-Agent": USER_AGENT}, timeout=30)
                o.raise_for_status()
                obj = o.json()
            except requests.RequestException:
                continue
            img = obj.get("primaryImage") or obj.get("primaryImageSmall")
            if not img or not obj.get("isPublicDomain"):
                continue
            yield make_candidate(
                source_url=img,
                type="image",
                source="The Met / Open Access",
                raw_license="CC0",
                creator=obj.get("artistDisplayName") or None,
                attribution_url=obj.get("objectURL"),
                tags=[theme, obj.get("classification", ""), obj.get("medium", "")[:24]],
                query_theme=theme,
                foreign_landing_url=obj.get("objectURL"),
            )
            time.sleep(0.3)


def ingest_smithsonian(themes: list[str] | None = None, per_theme: int = 20) -> Iterator[
    tuple[Candidate | None, Rejection | None]
]:
    key = os.environ.get("SMITHSONIAN_API_KEY")
    if not key:
        return
    themes = themes or THEMES
    for theme in themes:
        try:
            r = requests.get(
                SI_SEARCH,
                params={"q": f"{theme} AND online_media_type:Images", "rows": per_theme, "api_key": key},
                headers={"User-Agent": USER_AGENT},
                timeout=30,
            )
            r.raise_for_status()
            rows = r.json().get("response", {}).get("rows", [])
        except requests.RequestException:
            continue
        for row in rows:
            content = row.get("content", {})
            descriptive = content.get("descriptiveNonRepeating", {})
            usage = descriptive.get("online_media", {})
            media = usage.get("media", []) if isinstance(usage, dict) else []
            for m in media:
                if m.get("usage", {}).get("access") != "CC0":
                    continue
                url = m.get("content")
                if not url:
                    continue
                yield make_candidate(
                    source_url=url,
                    type="image",
                    source="Smithsonian / Open Access",
                    raw_license="CC0",
                    attribution_url=descriptive.get("record_link"),
                    tags=[theme],
                    query_theme=theme,
                    foreign_landing_url=descriptive.get("record_link"),
                )
            time.sleep(0.3)
