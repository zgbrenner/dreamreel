"""Wikimedia Commons ingester via the MediaWiki API (public JSON, no client library).

Wikimedia Commons is a distinctive video source beyond archive.org: historic footage, public
-domain animation, and scientific/archival film that Commons hosts as freely-licensed WebM/Ogg
(and some mp4) — exactly the video-first, "artful, not generic" corpus the direction wants
(CLAUDE.md "Content & aesthetic direction"). Plain `requests` against the public API only:

  https://commons.wikimedia.org/w/api.php
    ?action=query&format=json
    &generator=categorymembers&gcmtitle=<Category>&gcmtype=file&gcmlimit=50
    &prop=imageinfo&iiprop=url|mime|size|extmetadata
    &gcmcontinue=<token>            # pagination

Response fields used (documented MediaWiki API shapes — do NOT invent fields):
  data["query"]["pages"]  -> dict keyed by pageid; each page has .title and
      .imageinfo[0] with {url, descriptionurl, mime, size, extmetadata{...}}
  data["continue"]        -> {"gcmcontinue": ..., "continue": ...}  (absent on the last page)

`extmetadata` carries the per-file license as human/machine strings (LicenseShortName / License
/ UsageTerms) plus artist/credit; every file is mapped to our canonical license token and run
through the SAME shared gate (ingest/licenses.py `evaluate`, via make_candidate) as every other
source — only PD / CC0 / CC-BY (with attribution) survive; CC-BY-NC/ND/SA and unknown licenses
are rejected with a logged reason. A category with mixed licenses is therefore safe: off-license
files are dropped, never fabricated as PD.

CATEGORIES: three broad Commons video-bearing categories (see CATEGORIES note). Because the
license gate re-validates every file and the MIME filter drops every non-video, an over-broad or
slightly-wrong category can only under-deliver volume, never corrupt the corpus — the same
graceful-degradation contract as ingest/archive_org.py's COLLECTIONS. The authoring sandbox
cannot reach the Commons API to confirm exact category names / membership counts server-side;
re-confirm and tune (or add more specific subcategories) before a production ingest run.
"""

from __future__ import annotations

import re
import time
from typing import Iterator

import requests

from .normalize import Candidate, Rejection, make_candidate

API_URL = "https://commons.wikimedia.org/w/api.php"
SOURCE = "Wikimedia Commons"
QUERY_THEME = "wikimedia-commons"
USER_AGENT = "DREAMREEL-corpus/0.1 (+https://dreamreel.example; respectful crawler)"

# Public-domain / freely-licensed film + animation categories. Chosen for the video-first,
# "artful, not generic" direction (CLAUDE.md):
#   Public domain films - the core PD moving-image target (historic + archival film).
#   Public domain animations - PD animation, matching the "experimental / animated / art film"
#       lean over generic archival clips.
#   Videos - Commons' general video container: broad moving-image coverage as a volume backstop.
# categorymembers is NOT recursive (only files DIRECTLY in each category are returned), so real
# volume depends on how these are populated; the per-file license gate + MIME filter make any
# wrong/over-broad pick degrade gracefully (skip, never corrupt). Re-confirm before production.
CATEGORIES = [
    "Category:Public domain films",
    "Category:Public domain animations",
    "Category:Videos",
]

# Accepted moving-image MIME types on Commons (WebM/Ogg dominate; some mp4). Anything else — a
# still image, audio, PDF, etc. sharing the category — is skipped (not a license verdict).
_VIDEO_MIMES = {"video/webm", "video/ogg", "application/ogg", "video/mp4"}

# Same per-file guardrail as ingest/archive_org.py and ingest/loc.py: a single multi-GB file must
# not dominate R2 storage/bandwidth (CLAUDE.md: "mind video's R2 storage/bandwidth/decode cost").
# An UNKNOWN size is not evidence the file is large, so only a KNOWN oversized `size` skips.
_MAX_FILE_BYTES = 500_000_000

# How many file members to request per API round-trip (MediaWiki caps gcmlimit at 500).
_GCM_LIMIT = 50

_HTML_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")
_TRAILING_VERSION = re.compile(r"(\d+(?:\.\d+)*)\s*$")


def _text(extmeta: dict, key: str) -> str:
    """Read one `extmetadata` value (each entry is a {'value': ..., 'source': ...} dict)."""
    v = extmeta.get(key)
    if isinstance(v, dict):
        return str(v.get("value", "")).strip()
    return ""


def _clean_artist(extmeta: dict) -> str | None:
    """Extract a plain-text creator/credit from `extmetadata`. Commons stores Artist/Credit as
    HTML (e.g. '<a href=...>Name</a>'); strip tags so make_candidate can render attribution."""
    for key in ("Artist", "Credit"):
        raw = _text(extmeta, key)
        if not raw:
            continue
        text = _WS.sub(" ", _HTML_TAG.sub("", raw)).strip()
        if text:
            return text
    return None


def _map_license(extmeta: dict) -> tuple[str, str | None]:
    """Map Commons `extmetadata` license fields into a (raw_license, version) the shared gate
    understands. Prefers the machine `License` token (e.g. 'cc-by-4.0', 'pd', 'cc0'), falling
    back to the human `LicenseShortName` / `UsageTerms`. CC-BY variants keep their version so the
    gate can normalize to e.g. 'CC-BY-4.0'; NC/ND/SA variants are handed through intact so the
    gate rejects them. Anything unrecognized returns the rawest string we have -> gate logs it
    UNKNOWN (never silently assumed PD)."""
    machine = _text(extmeta, "License").lower()
    short = _text(extmeta, "LicenseShortName")
    usage = _text(extmeta, "UsageTerms")
    blob = " ".join((machine, short.lower(), usage.lower()))

    if "cc0" in blob:
        return "cc0", None
    if "public domain" in blob or machine in ("pd", "pdm") or machine.startswith("pd-"):
        return "publicdomain", None

    # A CC-BY token in either the machine field or the human short name (spaces -> hyphens).
    token = ""
    if machine.startswith(("cc-by", "cc by")):
        token = machine
    elif short.lower().startswith(("cc-by", "cc by")):
        token = short.lower()
    if token:
        token = token.replace("cc by", "cc-by").replace(" ", "-")
        m = _TRAILING_VERSION.search(token)
        if m:
            version = m.group(1)
            base = token[: m.start()].rstrip("-")  # e.g. 'cc-by', 'cc-by-sa'
            return base, version
        return token, None

    return short or machine or usage or "", None


def _file_page(title: str | None) -> str | None:
    """Fallback description-page URL when imageinfo omits `descriptionurl` (rare)."""
    if not title:
        return None
    return "https://commons.wikimedia.org/wiki/" + str(title).replace(" ", "_")


def _ordered_pages(pages: dict) -> list[dict]:
    """`query.pages` is keyed by pageid; iterate by ascending pageid for deterministic output."""
    def _key(k: str) -> tuple[int, int | str]:
        try:
            return (0, int(k))
        except (TypeError, ValueError):
            return (1, str(k))

    return [pages[k] for k in sorted(pages, key=_key)]


def _candidate_for_page(
    page: dict, category: str
) -> tuple[Candidate | None, Rejection | None] | None:
    """Map one Commons file page to a gated Candidate/Rejection pair.

    Returns None (skip, not a rejection) when the file is not video-MIME, exceeds the size cap,
    or exposes no direct URL — none of those are license verdicts."""
    infos = page.get("imageinfo") or []
    if not infos or not isinstance(infos[0], dict):
        return None
    info = infos[0]

    if str(info.get("mime", "")).lower() not in _VIDEO_MIMES:
        return None  # not a moving-image file sharing this category -> skip

    raw_size = info.get("size")
    try:
        size = int(raw_size) if raw_size is not None else None
    except (TypeError, ValueError):
        size = None
    if size is not None and size > _MAX_FILE_BYTES:
        return None  # known-oversized -> skip to bound R2 cost

    url = info.get("url")
    if not url:
        return None

    extmeta = info.get("extmetadata") or {}
    raw_license, version = _map_license(extmeta)
    creator = _clean_artist(extmeta)
    title = str(page.get("title", "")).removeprefix("File:")
    desc_url = info.get("descriptionurl") or _file_page(page.get("title"))
    cat_tag = category.removeprefix("Category:")

    return make_candidate(
        source_url=str(url),
        type="video",
        source=SOURCE,
        raw_license=raw_license,
        license_version=version,
        creator=creator,
        attribution_url=desc_url,
        tags=[QUERY_THEME, cat_tag, "film", title[:40]],
        query_theme=QUERY_THEME,
        foreign_landing_url=desc_url,
    )


def _api_get(params: dict, headers: dict) -> dict | None:
    """One MediaWiki API round-trip; retries once after a 429, returns None on any failure."""
    try:
        r = requests.get(API_URL, params=params, headers=headers, timeout=30)
        if r.status_code == 429:
            time.sleep(5)
            r = requests.get(API_URL, params=params, headers=headers, timeout=30)
        r.raise_for_status()
        return r.json()
    except requests.RequestException:
        return None


def ingest(limit: int = 40) -> Iterator[tuple[Candidate | None, Rejection | None]]:
    """Yield up to `limit` KEPT (candidate) pairs from Wikimedia Commons video categories.

    Rejections (off-license files caught by the gate) are yielded as they are encountered but do
    NOT count toward `limit`. Mirrors ingest/loc.py's signature/return shape."""
    headers = {"User-Agent": USER_AGENT}
    kept = 0
    for category in CATEGORIES:
        if kept >= limit:
            break
        params: dict = {
            "action": "query",
            "format": "json",
            "generator": "categorymembers",
            "gcmtitle": category,
            "gcmtype": "file",
            "gcmlimit": _GCM_LIMIT,
            "prop": "imageinfo",
            "iiprop": "url|mime|size|extmetadata",
        }
        while kept < limit:
            data = _api_get(params, headers)
            if data is None:
                break
            pages = ((data.get("query") or {}).get("pages")) or {}
            for page in _ordered_pages(pages):
                if kept >= limit:
                    break
                pair = _candidate_for_page(page, category)
                if pair is None:
                    continue  # non-video / oversized -> skip (not a rejection)
                cand, rej = pair
                yield cand, rej
                if cand is not None:
                    kept += 1
            cont = data.get("continue")
            if not cont:
                break  # last page for this category
            params.update(cont)  # merge gcmcontinue (+ continue) for the next round-trip
            time.sleep(1.0)  # be polite between paginated requests
        time.sleep(1.0)  # be polite between categories
