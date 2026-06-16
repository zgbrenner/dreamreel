"""Offline ingester tests.

We cannot reach the live Openverse / Archive.org APIs from CI's sandbox, so these tests feed
canned responses that mirror the *documented* response shapes the ingesters already target
(see each module's docstring) and assert the end-to-end mapping + license gate:
  - each ingester yields candidates with complete license fields,
  - CC-BY records carry attribution + attribution_url,
  - a CC-BY-NC record is rejected with a logged reason.

These fixtures use only fields the real APIs document and the client code reads — no invented
fields. Live one-response-per-source shape verification still needs network access.
"""

from __future__ import annotations

from ingest import archive_org, openverse


class FakeResp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise AssertionError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


# --- Openverse v1 /images results (documented fields only) ---
OPENVERSE_RESULTS = [
    {
        "url": "https://ov.example/cc0.jpg",
        "license": "cc0",
        "license_version": "1.0",
        "creator": "Anon",
        "source": "flickr",
        "foreign_landing_url": "https://flickr.example/cc0",
        "title": "Sea",
        "tags": [{"name": "sea"}, {"name": "wave"}],
    },
    {
        "url": "https://ov.example/by.jpg",
        "license": "by",  # Openverse encodes CC-BY as "by"
        "license_version": "4.0",
        "creator": "A. Photographer",
        "source": "wikimedia",
        "foreign_landing_url": "https://wm.example/by",
        "title": "Ruin",
        "tags": [{"name": "ruins"}],
    },
    {
        "url": "https://ov.example/by-nc.jpg",
        "license": "by-nc",  # must be rejected by the gate
        "license_version": "4.0",
        "creator": "NC Person",
        "source": "flickr",
        "foreign_landing_url": "https://flickr.example/by-nc",
        "title": "NoCommercial",
        "tags": [{"name": "sea"}],
    },
]


def test_openverse_maps_and_gates(monkeypatch):
    def fake_get(url, params=None, headers=None, timeout=None):
        page = (params or {}).get("page", 1)
        return FakeResp({"results": OPENVERSE_RESULTS if page == 1 else []})

    monkeypatch.setattr(openverse.requests, "get", fake_get)
    monkeypatch.setattr(openverse.time, "sleep", lambda *_a, **_k: None)

    kept, rejected = [], []
    for cand, rej in openverse.ingest(themes=["sea"], media="images", per_theme=10):
        (kept if cand else rejected).append(cand or rej)

    assert len(kept) == 2 and len(rejected) == 1

    cc0 = next(c for c in kept if c.license == "CC0")
    assert cc0.type == "image"
    assert cc0.source.startswith("Openverse /")
    assert cc0.source_url == "https://ov.example/cc0.jpg"
    assert cc0.query_theme == "sea" and "sea" in cc0.tags
    assert cc0.attribution is None  # CC0 needs none

    by = next(c for c in kept if c.license.startswith("CC-BY"))
    assert by.license == "CC-BY-4.0"
    assert by.attribution and "A. Photographer" in by.attribution
    assert by.attribution_url == "https://wm.example/by"

    rej = rejected[0]
    assert rej.raw_license == "by-nc"
    assert "non-commercial" in rej.reason or "restricted" in rej.reason


# --- Archive.org advancedsearch + metadata (documented fields only) ---
ARCHIVE_SEARCH = {"response": {"docs": [{"identifier": "film1"}]}}
ARCHIVE_META = {
    "metadata": {
        "identifier": "film1",
        "title": "A Prelinger Film",
        "creator": "Prelinger Archives",
        "licenseurl": "http://creativecommons.org/publicdomain/mark/1.0/",
        "collection": "prelinger",
    },
    "files": [
        {"name": "thumb.jpg", "format": "JPEG"},
        {"name": "film1.mp4", "format": "h.264"},
    ],
}


def test_archive_org_resolves_video_and_keeps_pd(monkeypatch):
    def fake_get(url, params=None, headers=None, timeout=None):
        if url == archive_org.ADV_SEARCH:
            return FakeResp(ARCHIVE_SEARCH)
        if url.startswith(archive_org.METADATA):
            return FakeResp(ARCHIVE_META)
        return FakeResp({}, 404)

    monkeypatch.setattr(archive_org.requests, "get", fake_get)
    monkeypatch.setattr(archive_org.time, "sleep", lambda *_a, **_k: None)

    kept, rejected = [], []
    for cand, rej in archive_org.ingest(collections=["prelinger"], rows_per_collection=5):
        (kept if cand else rejected).append(cand or rej)

    assert len(kept) == 1 and not rejected
    c = kept[0]
    assert c.type == "video"
    assert c.license == "PD"
    assert c.source == "Archive.org / prelinger"
    assert c.source_url == "https://archive.org/download/film1/film1.mp4"  # picks the .mp4
    # PD needs no attribution, so attribution_url is gated off; provenance is the landing url.
    assert c.attribution_url is None
    assert c.foreign_landing_url == "https://archive.org/details/film1"
    assert "prelinger" in c.tags and "film" in c.tags
