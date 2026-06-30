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

# Public-domain film collections. Video-first direction (CLAUDE.md "Content & aesthetic
# direction"): the corpus shifts heavily toward film, and toward EXPERIMENTAL / ANIMATED / ART
# film over generic archival clips. Prelinger/feature_films/publicmoviesarchive are the original
# general-archival anchors; the rest are deliberately picked for distinctive, non-generic footage:
#   manrayshortfilms          - avant-garde / experimental short film collection
#   silentfilmhouse_videos    - silent-era film 1878-1922 (Méliès, de Chomón proto-experimental)
#   disneycartoons-publicdomain / wbmisc-publicdomain / pdcartooncollection - PD animation
# Verified by cross-checking archive.org search results (titles/descriptions/identifier) — the
# sandbox this was authored in cannot reach archive.org's API directly to confirm `mediatype`/
# `licenseurl` server-side, so re-confirm with `curl https://archive.org/metadata/<id>` before a
# production ingest run. A wrong/empty identifier degrades gracefully: `_search_identifiers`
# returns [] on a no-result query, and every item is independently re-validated by the license
# gate regardless of collection (see _item_license: only Prelinger gets an implicit PD fallback;
# everyone else with missing license metadata is rejected as unknown, not assumed PD) — so this
# can never corrupt the corpus, only under-deliver volume.
COLLECTIONS = [
    "prelinger",
    "feature_films",
    "publicmoviesarchive",
    "manrayshortfilms",
    "silentfilmhouse_videos",
    "disneycartoons-publicdomain",
    "wbmisc-publicdomain",
    "pdcartooncollection",
]

_VIDEO_EXT = (".mp4", ".m4v", ".ogv", ".webm")
# A generous per-file cap so a single multi-GB master derivative doesn't dominate R2
# storage/bandwidth (CLAUDE.md: "mind video's R2 storage/bandwidth/decode cost"). Not a quality
# target — just a guardrail; transcoding/compression remains publish/transcode's job.
_MAX_FILE_BYTES = 500_000_000


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


def _pick_video_file(files: list[dict]) -> str | None:
    """Choose which video file to use for an Archive.org item. Items often carry several video
    derivatives (a master plus auto-generated web copies); prefer the largest one within
    `_MAX_FILE_BYTES` (good quality, bounded cost) using the `size` field Archive.org's metadata
    API commonly reports per file (bytes, as a string).

    Falls back to the FIRST matching file — the prior, size-unaware behaviour — whenever no
    candidate yields a cap-respecting choice: either nothing carries a usable `size`, OR sizes are
    only PARTIALLY known (an unsized candidate is never silently discarded in favour of a
    sized-but-oversized one just because it happens to be the only one with a `size` field — an
    unknown size is not evidence the file is large). Only when EVERY candidate carries a usable
    size and all of them exceed the cap do we pick the smallest of the (all bad) options, since
    that is still a fully size-informed, cost-minimizing choice."""
    candidates = [f for f in files if str(f.get("name", "")).lower().endswith(_VIDEO_EXT)]
    if not candidates:
        return None

    sized: list[tuple[int, str]] = []
    all_sized = True
    for f in candidates:
        raw_size = f.get("size")
        size: int | None = None
        if raw_size is not None:
            try:
                size = int(raw_size)
            except (TypeError, ValueError):
                size = None
        if size is None:
            all_sized = False
            continue
        sized.append((size, f.get("name", "")))

    under_cap = [s for s in sized if s[0] <= _MAX_FILE_BYTES]
    if under_cap:
        under_cap.sort(key=lambda s: s[0])
        return under_cap[-1][1]  # largest under the cap: best quality within budget
    if sized and all_sized:
        sized.sort(key=lambda s: s[0])
        return sized[0][1]  # every candidate is oversized; take the smallest rather than the biggest
    return candidates[0].get("name", "")  # no fully size-informed choice -> the old first-match pick


def _item_license(meta: dict) -> str:
    md = meta.get("metadata", {})
    # Archive.org carries license in 'licenseurl' or 'rights'. Only PRELINGER's own collection
    # terms are an independently-known PD guarantee, so a Prelinger item with neither field still
    # counts as public domain. Every other collection (7 now, not just the 2 original
    # general-archival anchors) gets NO such implicit guarantee: missing license metadata returns
    # "" so the shared gate (ingest/licenses.py evaluate()) rejects it as unknown, exactly like any
    # other source with no usable license info — never silently fabricated as PD.
    lic = md.get("licenseurl") or md.get("rights") or ""
    if not lic and "prelinger" in str(md.get("collection", "")).lower():
        return "publicdomain"
    return lic


def ingest(collections: list[str] | None = None, rows_per_collection: int = 60) -> Iterator[
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
            # pick one representative video file (size-aware — see _pick_video_file)
            file_name = _pick_video_file(meta.get("files", []))
            if not file_name:
                continue
            file_url = f"{DOWNLOAD}/{ident}/{file_name}"
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
