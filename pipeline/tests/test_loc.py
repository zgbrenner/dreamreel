"""Offline tests for the Library of Congress National Screening Room ingester.

Same convention as tests/test_ingesters.py: CI's sandbox cannot reach the live loc.gov JSON
API, so these feed canned responses mirroring the documented response shapes the ingester
targets (see ingest/loc.py docstring) and assert pagination, mp4 derivative selection under
the size cap, the license/source fields, and the skip-when-no-mp4 behaviour. No network.
"""

from __future__ import annotations

from ingest import loc, run as ingest_run


class FakeResp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise AssertionError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


ITEM_A = "https://www.loc.gov/item/mbrs0001/"
ITEM_B = "https://www.loc.gov/item/mbrs0002/"
ITEM_C = "https://www.loc.gov/item/mbrs0003/"

# --- collection listing pages (documented fields only: id/title/date) ---
PAGES = {
    1: [
        # non-item result (the collection page itself) — must be skipped, not fetched
        {"id": "https://www.loc.gov/collections/national-screening-room/", "title": "NSR"},
        {"id": ITEM_A, "title": "A Trip Down Market Street", "date": "1906"},
    ],
    2: [
        {"id": ITEM_B, "title": "The House I Live In", "date": "1945"},
        {"id": ITEM_C, "title": "No Download Here", "date": "1950"},
    ],
    3: [],
}

# --- item details: resources[].files as list-of-lists of {url, mimetype, size} ---
DETAILS = {
    ITEM_A: {
        "item": {"title": "A Trip Down Market Street"},
        "resources": [
            {
                "files": [
                    [
                        {"url": "https://tile.loc.gov/a_small.mp4", "mimetype": "video/mp4", "size": 50_000_000},
                        {"url": "https://tile.loc.gov/a_mid.mp4", "mimetype": "video/mp4", "size": 200_000_000},
                        {"url": "https://tile.loc.gov/a_large.mp4", "mimetype": "video/mp4", "size": 400_000_000},
                        {"url": "https://tile.loc.gov/a_master.mp4", "mimetype": "video/mp4", "size": 900_000_000},
                        {"url": "https://tile.loc.gov/a_poster.jpg", "mimetype": "image/jpeg", "size": 20_000},
                    ]
                ]
            }
        ],
    },
    ITEM_B: {
        "item": {"title": "The House I Live In"},
        "resources": [
            # flat files list (the API serves both shapes)
            {"files": [{"url": "https://tile.loc.gov/b.mp4", "mimetype": "video/mp4", "size": 100_000_000}]}
        ],
    },
    ITEM_C: {
        "item": {"title": "No Download Here"},
        # streaming-only item: no mp4 derivative -> NOT marked freely downloadable
        "resources": [
            {"files": [[{"url": "https://tile.loc.gov/c.pdf", "mimetype": "application/pdf"}]]}
        ],
    },
}


def _fake_get(url, params=None, headers=None, timeout=None):
    params = params or {}
    assert "DREAMREEL" in (headers or {}).get("User-Agent", ""), "must crawl with our UA"
    assert params.get("fo") == "json"
    if url == loc.COLLECTION_URL:
        return FakeResp({"results": PAGES.get(params.get("sp"), [])})
    if url in DETAILS:
        return FakeResp(DETAILS[url])
    return FakeResp({}, 404)


def _run_ingest(monkeypatch, count):
    monkeypatch.setattr(loc.requests, "get", _fake_get)
    monkeypatch.setattr(loc.time, "sleep", lambda *_a, **_k: None)
    kept, rejected = [], []
    for cand, rej in loc.ingest(count=count):
        (kept if cand else rejected).append(cand or rej)
    return kept, rejected


def test_loc_paginates_across_pages_and_stops_on_empty(monkeypatch):
    kept, rejected = _run_ingest(monkeypatch, count=10)
    # item A (page 1) + item B (page 2); C has no mp4, the non-item result is skipped,
    # page 3 is empty and ends the walk.
    assert [c.foreign_landing_url for c in kept] == [ITEM_A, ITEM_B]
    assert not rejected


def test_loc_license_source_and_attribution_fields(monkeypatch):
    kept, _ = _run_ingest(monkeypatch, count=10)
    for c in kept:
        assert c.type == "video"
        assert c.license == "PD"  # PD-believed collection, normalized by the shared gate
        assert c.source == "Library of Congress / National Screening Room"
        # PD needs no attribution, so the gate strips attribution_url; provenance lives in
        # foreign_landing_url (the loc.gov item page) — same convention as archive_org PD.
        assert c.attribution is None and c.attribution_url is None
        assert c.foreign_landing_url.startswith("https://www.loc.gov/item/")
        assert "national-screening-room" in c.tags and "film" in c.tags
    a = kept[0]
    assert "A Trip Down Market Street" in a.tags and "1906" in a.tags


def test_loc_prefers_mid_size_mp4_under_cap(monkeypatch):
    kept, _ = _run_ingest(monkeypatch, count=10)
    # Item A carries 50/200/400 MB derivatives under the cap plus a 900 MB master over it and a
    # jpg poster: the mid-size under-cap derivative wins; master and poster never do.
    assert kept[0].source_url == "https://tile.loc.gov/a_mid.mp4"
    assert kept[1].source_url == "https://tile.loc.gov/b.mp4"


def test_loc_skips_items_without_an_mp4(monkeypatch):
    kept, rejected = _run_ingest(monkeypatch, count=10)
    # Item C is streaming-only (pdf resource, no mp4): skipped entirely — neither kept nor
    # logged as a license rejection (absence of a download is not a license verdict).
    assert all(c.foreign_landing_url != ITEM_C for c in kept)
    assert not rejected


def test_loc_respects_count(monkeypatch):
    kept, _ = _run_ingest(monkeypatch, count=1)
    assert len(kept) == 1 and kept[0].foreign_landing_url == ITEM_A


# --- _pick_mp4 unit tests: size-cap semantics mirror archive_org._pick_video_file ---


def _res(files):
    return [{"files": [files]}]


def test_pick_mp4_all_over_cap_takes_smallest():
    files = [
        {"url": "https://t/a.mp4", "mimetype": "video/mp4", "size": 900_000_000},
        {"url": "https://t/b.mp4", "mimetype": "video/mp4", "size": 1_200_000_000},
    ]
    assert loc._pick_mp4(_res(files)) == "https://t/a.mp4"


def test_pick_mp4_no_sizes_falls_back_to_first():
    files = [
        {"url": "https://t/first.mp4", "mimetype": "video/mp4"},
        {"url": "https://t/second.mp4", "mimetype": "video/mp4"},
    ]
    assert loc._pick_mp4(_res(files)) == "https://t/first.mp4"


def test_pick_mp4_never_discards_unsized_candidate_for_oversized_sized_one():
    # Same regression contract as archive_org: an unknown size is not evidence of a large file.
    files = [
        {"url": "https://t/unsized.mp4", "mimetype": "video/mp4"},
        {"url": "https://t/huge.mp4", "mimetype": "video/mp4", "size": 999_999_999_999},
    ]
    assert loc._pick_mp4(_res(files)) == "https://t/unsized.mp4"


def test_pick_mp4_ignores_malformed_sizes():
    files = [
        {"url": "https://t/junk.mp4", "mimetype": "video/mp4", "size": "unknown"},
        {"url": "https://t/good.mp4", "mimetype": "video/mp4", "size": "100000000"},
    ]
    assert loc._pick_mp4(_res(files)) == "https://t/good.mp4"


def test_pick_mp4_matches_by_url_extension_when_mimetype_missing():
    files = [{"url": "https://t/only.mp4"}, {"url": "https://t/nope.pdf"}]
    assert loc._pick_mp4(_res(files)) == "https://t/only.mp4"


def test_pick_mp4_returns_none_when_no_mp4():
    assert loc._pick_mp4(_res([{"url": "https://t/x.jpg", "mimetype": "image/jpeg"}])) is None
    assert loc._pick_mp4([]) is None
    assert loc._pick_mp4(None) is None


# --- run.py wiring ---


def test_run_cli_has_loc_flags():
    parser = ingest_run.build_parser()
    assert parser.get_default("loc") == 40
    args = parser.parse_args(["--no-loc"])
    assert args.no_loc is True
    args = parser.parse_args(["--loc", "5"])
    assert args.loc == 5 and args.no_loc is False
