"""Library of Congress "National Screening Room" ingester via the loc.gov JSON API.

The National Screening Room is LoC's curated collection of digitized film the Library
believes to be in the public domain and publishes with freely downloadable mp4 derivatives —
exactly the video-first, distinctive footage the corpus direction wants (CLAUDE.md "Content &
aesthetic direction"). Plain `requests` against the public JSON API only (no client library):

  Listing: https://www.loc.gov/collections/national-screening-room/?fo=json&at=results&sp=<page>
  Item:    <item_url>?fo=json  (resources[].files[] expose the downloadable derivatives)

Response fields used (documented loc.gov JSON API shapes, do not invent fields):
  results[].id / .title / .date
  item detail: resources[].files (flat list OR list-of-lists of {url, mimetype, size})

Only items whose detail actually exposes an mp4 derivative are kept — the presence of an mp4
in resources/files is how the API marks a title freely downloadable; everything else is
skipped (not rejected: absence of a download is not a license verdict). Kept items are
recorded as public domain ("PD" after normalization) and still run through the shared license
gate in normalize/licenses like every other source. PD needs no attribution, but the loc.gov
item page is always carried as `foreign_landing_url` (and offered as `attribution_url` for the
gate to keep or drop) so provenance is never lost.
"""

from __future__ import annotations

import time
from typing import Iterator

import requests

from .normalize import Candidate, Rejection, make_candidate

COLLECTION_URL = "https://www.loc.gov/collections/national-screening-room/"
SOURCE = "Library of Congress / National Screening Room"
QUERY_THEME = "national-screening-room"
USER_AGENT = "DREAMREEL-corpus/0.1 (+https://dreamreel.example; respectful crawler)"

# Same per-file guardrail as ingest/archive_org.py: a single multi-GB master must not dominate
# R2 storage/bandwidth (CLAUDE.md: "mind video's R2 storage/bandwidth/decode cost").
_MAX_FILE_BYTES = 500_000_000


def _item_page(raw_id: str) -> str | None:
    """Normalize a results[].id into the canonical https loc.gov item page URL.

    Collection listings interleave item records with non-item results (the collection page
    itself, subject pages); only /item/ URLs are ingestible."""
    if not raw_id.startswith(("http://", "https://")) or "/item/" not in raw_id:
        return None
    if raw_id.startswith("http://"):
        raw_id = "https://" + raw_id[len("http://") :]
    return raw_id


def _iter_files(resources: list | None) -> Iterator[dict]:
    """Flatten resources[].files, which the loc.gov API serves either as a flat list of file
    dicts or as a list of lists (one inner list per resource segment)."""
    for res in resources or []:
        if not isinstance(res, dict):
            continue
        for entry in res.get("files") or []:
            if isinstance(entry, list):
                for f in entry:
                    if isinstance(f, dict):
                        yield f
            elif isinstance(entry, dict):
                yield entry


def _is_mp4(f: dict) -> bool:
    if str(f.get("mimetype", "")).lower() == "video/mp4":
        return True
    return str(f.get("url", "")).lower().split("?", 1)[0].endswith(".mp4")


def _pick_mp4(resources: list | None) -> str | None:
    """Choose which mp4 derivative to download for an item. National Screening Room items
    usually carry several qualities; prefer the MID-size derivative among those within
    `_MAX_FILE_BYTES` — good-enough quality at bounded cost (unlike archive_org's
    largest-under-cap, LoC masters are routinely near the cap, so mid-size is the budget pick).

    Fallbacks mirror ingest/archive_org.py `_pick_video_file`: when sizes are only partially
    known and nothing usable is under the cap, take the FIRST mp4 (an unknown size is not
    evidence the file is large); only when EVERY candidate is sized and all exceed the cap do
    we take the smallest of the (all bad) options. Returns None when the item exposes no mp4
    at all — i.e. the API does not mark it freely downloadable."""
    candidates = [f for f in _iter_files(resources) if _is_mp4(f) and f.get("url")]
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
        sized.append((size, str(f["url"])))

    under_cap = sorted(s for s in sized if s[0] <= _MAX_FILE_BYTES)
    if under_cap:
        return under_cap[len(under_cap) // 2][1]  # mid-size derivative within budget
    if sized and all_sized:
        sized.sort()
        return sized[0][1]  # every candidate is oversized; take the smallest
    return str(candidates[0]["url"])  # no fully size-informed choice -> first mp4


def ingest(count: int = 40) -> Iterator[tuple[Candidate | None, Rejection | None]]:
    """Yield up to `count` (candidate, rejection) pairs from the National Screening Room."""
    headers = {"User-Agent": USER_AGENT}
    yielded = 0
    page = 1
    while yielded < count:
        try:
            r = requests.get(
                COLLECTION_URL,
                params={"fo": "json", "at": "results", "sp": page},
                headers=headers,
                timeout=30,
            )
            if r.status_code == 429:
                time.sleep(5)
                continue
            r.raise_for_status()
            results = r.json().get("results", [])
        except requests.RequestException:
            break
        if not results:
            break
        for result in results:
            if yielded >= count:
                break
            item_url = _item_page(str(result.get("id", "")))
            if not item_url:
                continue
            try:
                d = requests.get(item_url, params={"fo": "json"}, headers=headers, timeout=30)
                d.raise_for_status()
                detail = d.json()
            except requests.RequestException:
                continue
            mp4_url = _pick_mp4(detail.get("resources"))
            if not mp4_url:
                continue  # no downloadable mp4 -> not marked freely downloadable; skip
            title = result.get("title") or (detail.get("item") or {}).get("title") or item_url
            date = str(result.get("date") or "")
            yield make_candidate(
                source_url=mp4_url,
                type="video",
                source=SOURCE,
                # PD-believed collection (see module docstring); the gate still re-checks.
                raw_license="publicdomain",
                attribution_url=item_url,
                tags=[QUERY_THEME, "film", str(title)[:40], date],
                query_theme=QUERY_THEME,
                foreign_landing_url=item_url,
            )
            yielded += 1
            time.sleep(1.0)  # be polite: loc.gov rate-limits JSON crawlers
        page += 1
        time.sleep(1.0)
