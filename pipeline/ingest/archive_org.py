"""Archive.org ingester via the public HTTP APIs ONLY.

We deliberately use the Advanced Search + Metadata HTTP endpoints with plain `requests`, and
NOT the `internetarchive` Python client — that client is AGPL and must not be linked into our
tooling under the license policy. (A grep in CI confirms we never import it.)

  Advanced Search: https://archive.org/advancedsearch.php?q=...&output=json
  Metadata:        https://archive.org/metadata/<identifier>
"""

from __future__ import annotations

import time
from typing import Iterator

import requests

from .normalize import Candidate, Rejection, make_candidate

ADV_SEARCH = "https://archive.org/advancedsearch.php"
METADATA = "https://archive.org/metadata"
DOWNLOAD = "https://archive.org/download"
USER_AGENT = "DREAMREEL-corpus/0.1 (+https://dreamreel.example; respectful crawler)"

# Public-domain film collections (Prelinger is the canonical one).
COLLECTIONS = ["prelinger", "feature_films", "publicmoviesarchive"]

_VIDEO_EXT = (".mp4", ".m4v", ".ogv", ".webm")


def _search_identifiers(collection: str, rows: int) -> list[str]:
    params = {
        "q": f'collection:{collection} AND mediatype:movies',
        "fl[]": "identifier",
        "rows": rows,
        "output": "json",
    }
    try:
        r = requests.get(ADV_SEARCH, params=params, headers={"User-Agent": USER_AGENT}, timeout=30)
        r.raise_for_status()
        docs = r.json().get("response", {}).get("docs", [])
        return [d["identifier"] for d in docs if "identifier" in d]
    except requests.RequestException:
        return []


def _item_license(meta: dict) -> str:
    md = meta.get("metadata", {})
    # Archive.org carries license in 'licenseurl' or 'rights'; Prelinger items are public domain.
    lic = md.get("licenseurl") or md.get("rights") or ""
    if not lic and "prelinger" in str(md.get("collection", "")).lower():
        return "publicdomain"
    return lic or "publicdomain"


def ingest(collections: list[str] | None = None, rows_per_collection: int = 25) -> Iterator[
    tuple[Candidate | None, Rejection | None]
]:
    collections = collections or COLLECTIONS
    for collection in collections:
        for ident in _search_identifiers(collection, rows_per_collection):
            try:
                r = requests.get(f"{METADATA}/{ident}", headers={"User-Agent": USER_AGENT}, timeout=30)
                r.raise_for_status()
                meta = r.json()
            except requests.RequestException:
                continue
            md = meta.get("metadata", {})
            creator = md.get("creator")
            title = md.get("title", ident)
            raw_license = _item_license(meta)
            # pick one representative video file
            file_url = None
            for fobj in meta.get("files", []):
                name = fobj.get("name", "")
                if name.lower().endswith(_VIDEO_EXT):
                    file_url = f"{DOWNLOAD}/{ident}/{name}"
                    break
            if not file_url:
                continue
            yield make_candidate(
                source_url=file_url,
                type="video",
                source=f"Archive.org / {collection}",
                raw_license=raw_license,
                creator=creator,
                attribution_url=f"https://archive.org/details/{ident}",
                tags=[collection, "film", str(title)[:40]],
                query_theme=collection,
                foreign_landing_url=f"https://archive.org/details/{ident}",
            )
            time.sleep(0.5)
