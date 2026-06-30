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

import inspect

from ingest import archive_org, openverse, run as ingest_run


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


# --- video-first corpus shift (CLAUDE.md "Content & aesthetic direction") ---


def test_archive_org_collections_includes_art_and_animation_sources():
    # "Artful, not generic": these were added to favour experimental/animated/art film over
    # generic archival clips. A future refactor shouldn't silently drop them.
    for ident in (
        "manrayshortfilms",
        "silentfilmhouse_videos",
        "disneycartoons-publicdomain",
        "wbmisc-publicdomain",
        "pdcartooncollection",
    ):
        assert ident in archive_org.COLLECTIONS
    assert "prelinger" in archive_org.COLLECTIONS  # original general-archival anchor kept


def test_archive_org_default_rows_per_collection_raised():
    sig = inspect.signature(archive_org.ingest)
    assert sig.parameters["rows_per_collection"].default == 60


def test_openverse_default_per_theme_lowered():
    # Images are now flash-frame/ghost-only (never primary), so the corpus needs far fewer of
    # them than when they were equal-weight primary media.
    sig = inspect.signature(openverse.ingest)
    assert sig.parameters["per_theme"].default == 20


def test_run_cli_per_theme_default_lowered():
    assert ingest_run.build_parser().get_default("per_theme") == 20


# --- _pick_video_file: size-aware derivative selection ---


def test_pick_video_file_prefers_largest_under_cap():
    files = [
        {"name": "film_512kb.mp4", "size": "50000000"},
        {"name": "film.mp4", "size": "300000000"},  # largest under the cap
        {"name": "film_master.mp4", "size": "900000000"},  # over the cap
        {"name": "poster.jpg", "size": "20000"},  # not a video extension
    ]
    assert archive_org._pick_video_file(files) == "film.mp4"


def test_pick_video_file_falls_back_to_smallest_when_all_over_cap():
    files = [
        {"name": "film_a.mp4", "size": "900000000"},
        {"name": "film_b.mp4", "size": "1200000000"},
    ]
    assert archive_org._pick_video_file(files) == "film_a.mp4"


def test_pick_video_file_falls_back_to_first_match_when_no_size():
    # Matches the pre-change behaviour exactly when metadata carries no usable `size` field.
    files = [{"name": "thumb.jpg"}, {"name": "film1.mp4"}, {"name": "film1_512kb.mp4"}]
    assert archive_org._pick_video_file(files) == "film1.mp4"


def test_pick_video_file_returns_none_when_no_video_files():
    assert archive_org._pick_video_file([{"name": "poster.jpg"}]) is None


def test_pick_video_file_never_discards_an_unsized_candidate_for_an_oversized_sized_one():
    # Regression: a partially-sized file list must NOT silently drop the unsized candidate (which
    # might be a perfectly good small derivative) just because some OTHER candidate happens to
    # report a size, even a wildly oversized one. Falls back to first-match, exactly as when no
    # candidate has a size at all.
    files = [
        {"name": "real_first_match.mp4"},  # no size field at all
        {"name": "other.mp4", "size": "999999999999"},  # huge, over the cap, but sized
    ]
    assert archive_org._pick_video_file(files) == "real_first_match.mp4"


def test_pick_video_file_ignores_malformed_size_strings():
    files = [
        {"name": "junk.mp4", "size": "unknown"},  # not a parseable size
        {"name": "good.mp4", "size": "100000000"},
    ]
    assert archive_org._pick_video_file(files) == "good.mp4"


def test_pick_video_file_never_size_compares_a_non_video_file():
    # A huge `size` on a non-video file must never enter the size logic — the extension filter
    # runs first. The video candidate here has no size, so this also proves filter-before-size
    # ordering, not just extension exclusion.
    files = [{"name": "poster.jpg", "size": "999999999999"}, {"name": "film1.mp4"}]
    assert archive_org._pick_video_file(files) == "film1.mp4"


# --- _item_license: only Prelinger gets an implicit PD fallback ---


def test_item_license_prelinger_with_no_metadata_is_still_public_domain():
    meta = {"metadata": {"collection": "prelinger"}}  # no licenseurl/rights
    assert archive_org._item_license(meta) == "publicdomain"


def test_item_license_non_prelinger_with_no_metadata_is_not_fabricated_as_public_domain():
    # Regression: missing license metadata from any OTHER collection (now 7, not just the 2
    # original general-archival anchors) must fall through to the shared license gate as unknown,
    # never be silently assumed PD.
    for collection in ("feature_films", "manrayshortfilms", "wbmisc-publicdomain"):
        meta = {"metadata": {"collection": collection}}  # no licenseurl/rights
        assert archive_org._item_license(meta) == ""


def test_archive_org_rejects_non_prelinger_item_with_no_license_metadata(monkeypatch):
    meta = {
        "metadata": {
            "identifier": "mystery1",
            "title": "Untitled",
            "collection": "wbmisc-publicdomain",
            # no licenseurl, no rights
        },
        "files": [{"name": "mystery1.mp4", "format": "h.264"}],
    }

    def fake_get(url, params=None, headers=None, timeout=None):
        if url == archive_org.ADV_SEARCH:
            return FakeResp({"response": {"docs": [{"identifier": "mystery1"}]}})
        if url.startswith(archive_org.METADATA):
            return FakeResp(meta)
        return FakeResp({}, 404)

    monkeypatch.setattr(archive_org.requests, "get", fake_get)
    monkeypatch.setattr(archive_org.time, "sleep", lambda *_a, **_k: None)

    kept, rejected = [], []
    for cand, rej in archive_org.ingest(collections=["wbmisc-publicdomain"], rows_per_collection=5):
        (kept if cand else rejected).append(cand or rej)

    assert not kept and len(rejected) == 1
    assert "unknown" in rejected[0].reason


# --- ingest() end-to-end: size-aware pick actually wired into the real flow ---


def test_archive_org_ingest_uses_size_aware_pick_end_to_end(monkeypatch):
    meta = {
        "metadata": {
            "identifier": "film2",
            "title": "A Prelinger Film",
            "licenseurl": "http://creativecommons.org/publicdomain/mark/1.0/",
            "collection": "prelinger",
        },
        "files": [
            {"name": "film2_512kb.mp4", "size": "50000000"},
            {"name": "film2.mp4", "size": "300000000"},  # largest under the cap -> expected pick
            {"name": "film2_master.mp4", "size": "900000000"},  # over the cap
        ],
    }

    def fake_get(url, params=None, headers=None, timeout=None):
        if url == archive_org.ADV_SEARCH:
            return FakeResp({"response": {"docs": [{"identifier": "film2"}]}})
        if url.startswith(archive_org.METADATA):
            return FakeResp(meta)
        return FakeResp({}, 404)

    monkeypatch.setattr(archive_org.requests, "get", fake_get)
    monkeypatch.setattr(archive_org.time, "sleep", lambda *_a, **_k: None)

    kept, rejected = [], []
    for cand, rej in archive_org.ingest(collections=["prelinger"], rows_per_collection=5):
        (kept if cand else rejected).append(cand or rej)

    assert len(kept) == 1 and not rejected
    assert kept[0].source_url == "https://archive.org/download/film2/film2.mp4"
