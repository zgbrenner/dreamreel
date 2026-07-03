"""Offline tests for the Wikimedia Commons ingester.

Same convention as tests/test_ingesters.py / test_loc.py: CI's sandbox cannot reach the live
MediaWiki API, so these feed canned responses mirroring the documented response shapes the
ingester targets (see ingest/commons.py docstring) and assert pagination via gcmcontinue, the
video-MIME filter, license extraction from extmetadata + the shared gate (CC-BY kept with
attribution, CC-BY-NC rejected, PD/CC0 kept), the size cap, the candidate field shape, and the
run.py flag wiring. No network.
"""

from __future__ import annotations

from ingest import commons, run as ingest_run

CAT0 = commons.CATEGORIES[0]  # first category the ingester walks


class FakeResp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise AssertionError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


def _page(pageid, title, *, url, mime, size=None, extmeta=None, descriptionurl=None):
    info: dict = {"url": url, "mime": mime}
    if size is not None:
        info["size"] = size
    info["descriptionurl"] = descriptionurl or (
        "https://commons.wikimedia.org/wiki/" + title.replace(" ", "_")
    )
    info["extmetadata"] = extmeta or {}
    return {"pageid": pageid, "title": title, "imageinfo": [info]}


def _lic(short=None, machine=None, usage=None):
    e: dict = {}
    if short is not None:
        e["LicenseShortName"] = {"value": short}
    if machine is not None:
        e["License"] = {"value": machine}
    if usage is not None:
        e["UsageTerms"] = {"value": usage}
    return e


# --- fixture files (documented imageinfo/extmetadata fields only) ---

PD_PAGE = _page(
    10, "File:Historic footage.webm",
    url="https://upload.wikimedia.org/hist.webm", mime="video/webm",
    size=40_000_000, extmeta=_lic(short="Public domain", machine="pd"),
)
CC0_PAGE = _page(
    11, "File:Science film.ogv",
    url="https://upload.wikimedia.org/sci.ogv", mime="application/ogg",
    size=30_000_000, extmeta=_lic(short="CC0", machine="cc0"),
)
CCBY_PAGE = _page(
    12, "File:Animated short.webm",
    url="https://upload.wikimedia.org/anim.webm", mime="video/webm",
    size=20_000_000,
    extmeta=_lic(short="CC BY 4.0", machine="cc-by-4.0") | {
        "Artist": {"value": '<a href="//c/Someone">Jane Animator</a>'},
    },
)
CCBYNC_PAGE = _page(
    13, "File:Restricted clip.webm",
    url="https://upload.wikimedia.org/nc.webm", mime="video/webm",
    size=15_000_000,
    extmeta=_lic(short="CC BY-NC 2.0", machine="cc-by-nc-2.0") | {
        "Artist": {"value": "NC Person"},
    },
)
IMAGE_PAGE = _page(  # a still image sharing the category -> filtered out by MIME
    14, "File:A drawing.jpg",
    url="https://upload.wikimedia.org/draw.jpg", mime="image/jpeg",
    size=500_000, extmeta=_lic(short="Public domain", machine="pd"),
)
OVERSIZE_PAGE = _page(  # a PD video, but over the size cap -> skipped
    15, "File:Huge master.webm",
    url="https://upload.wikimedia.org/huge.webm", mime="video/webm",
    size=900_000_000, extmeta=_lic(short="Public domain", machine="pd"),
)

# page 1 of the category listing (has a gcmcontinue token), page 2 (last page, no continue)
RESPONSE_PAGE_1 = {
    "continue": {"gcmcontinue": "file|NEXT|999", "continue": "gcmcontinue||"},
    "query": {"pages": {
        "10": PD_PAGE, "12": CCBY_PAGE, "14": IMAGE_PAGE,
    }},
}
RESPONSE_PAGE_2 = {
    "query": {"pages": {
        "11": CC0_PAGE, "13": CCBYNC_PAGE, "15": OVERSIZE_PAGE,
    }},
}


def _fake_get_factory(pages_by_continue):
    """Build a fake requests.get keyed on the presence/value of gcmcontinue."""

    def _fake_get(url, params=None, headers=None, timeout=None):
        assert url == commons.API_URL
        assert "DREAMREEL" in (headers or {}).get("User-Agent", ""), "must crawl with our UA"
        assert params.get("format") == "json"
        assert params.get("generator") == "categorymembers"
        assert params.get("gcmtype") == "file"
        assert "extmetadata" in params.get("iiprop", "")
        # Only the first configured category actually serves fixtures; others come back empty so
        # the walk ends quickly and deterministically.
        if params.get("gcmtitle") != CAT0:
            return FakeResp({"query": {"pages": {}}})
        return FakeResp(pages_by_continue.get(params.get("gcmcontinue")))

    return _fake_get


def _run(monkeypatch, pages_by_continue, limit=40):
    monkeypatch.setattr(commons.requests, "get", _fake_get_factory(pages_by_continue))
    monkeypatch.setattr(commons.time, "sleep", lambda *_a, **_k: None)
    kept, rejected = [], []
    for cand, rej in commons.ingest(limit=limit):
        (kept if cand else rejected).append(cand or rej)
    return kept, rejected


# --- tests ---


def test_commons_paginates_via_gcmcontinue():
    # nothing to assert here directly; covered by the end-to-end test below (page 2 only reached
    # by following the gcmcontinue token) — kept as a named contract for the pagination path.
    pass


def test_commons_end_to_end_pagination_mime_and_license_gate(monkeypatch):
    kept, rejected = _run(monkeypatch, {None: RESPONSE_PAGE_1, "file|NEXT|999": RESPONSE_PAGE_2})
    urls = {c.source_url for c in kept}
    # page 1: PD + CC-BY kept, jpg filtered by MIME. page 2 (only reached via gcmcontinue): CC0
    # kept, CC-BY-NC rejected by the gate, oversized PD video skipped.
    assert urls == {
        "https://upload.wikimedia.org/hist.webm",   # PD webm
        "https://upload.wikimedia.org/sci.ogv",     # CC0 ogg (page 2 -> proves pagination)
        "https://upload.wikimedia.org/anim.webm",   # CC-BY webm
    }
    assert "https://upload.wikimedia.org/draw.jpg" not in urls   # image MIME filtered
    assert "https://upload.wikimedia.org/huge.webm" not in urls  # oversized skipped
    # the CC-BY-NC file is the only license REJECTION (non-video / oversized are silent skips)
    assert len(rejected) == 1
    r = rejected[0]
    assert r.source_url == "https://upload.wikimedia.org/nc.webm"
    assert r.source == "Wikimedia Commons"
    assert "non-commercial" in r.reason or "restricted" in r.reason


def test_commons_candidate_field_shape(monkeypatch):
    kept, _ = _run(monkeypatch, {None: RESPONSE_PAGE_1, "file|NEXT|999": RESPONSE_PAGE_2})
    by_url = {c.source_url: c for c in kept}

    pd = by_url["https://upload.wikimedia.org/hist.webm"]
    assert pd.type == "video"
    assert pd.source == "Wikimedia Commons"
    assert pd.license == "PD"
    # PD needs no attribution: the gate strips it; provenance lives in foreign_landing_url.
    assert pd.attribution is None and pd.attribution_url is None
    assert pd.foreign_landing_url == "https://commons.wikimedia.org/wiki/File:Historic_footage.webm"
    assert pd.query_theme == commons.QUERY_THEME
    assert commons.QUERY_THEME in pd.tags and "film" in pd.tags
    assert "Public domain films" in pd.tags  # category (Category: prefix stripped)

    cc0 = by_url["https://upload.wikimedia.org/sci.ogv"]
    assert cc0.license == "CC0" and cc0.attribution is None

    by = by_url["https://upload.wikimedia.org/anim.webm"]
    assert by.license == "CC-BY-4.0"  # version preserved from the extmetadata token
    assert by.attribution and "Jane Animator" in by.attribution  # HTML stripped from Artist
    # CC-BY REQUIRES attribution -> the description page is carried as attribution_url.
    assert by.attribution_url == "https://commons.wikimedia.org/wiki/File:Animated_short.webm"


def test_commons_video_mime_filter(monkeypatch):
    # only the accepted moving-image MIMEs survive; a jpg in the same category is dropped.
    kept, rejected = _run(monkeypatch, {None: {"query": {"pages": {"14": IMAGE_PAGE}}}})
    assert not kept and not rejected  # skipped, not rejected (absence is not a license verdict)


def test_commons_size_cap_skip(monkeypatch):
    kept, rejected = _run(monkeypatch, {None: {"query": {"pages": {"15": OVERSIZE_PAGE}}}})
    assert not kept and not rejected  # known-oversized PD video skipped, not rejected


def test_commons_unknown_size_is_kept(monkeypatch):
    # An UNKNOWN size is not evidence the file is large — it must still be kept (mirrors the
    # loc/archive size philosophy).
    page = _page(20, "File:Unsized.webm", url="https://u/uns.webm", mime="video/webm",
                 extmeta=_lic(short="Public domain", machine="pd"))
    kept, _ = _run(monkeypatch, {None: {"query": {"pages": {"20": page}}}})
    assert [c.source_url for c in kept] == ["https://u/uns.webm"]


def test_commons_respects_limit(monkeypatch):
    kept, _ = _run(
        monkeypatch, {None: RESPONSE_PAGE_1, "file|NEXT|999": RESPONSE_PAGE_2}, limit=1
    )
    # deterministic ascending-pageid order -> the PD page (pageid 10) is the single kept item.
    assert len(kept) == 1
    assert kept[0].source_url == "https://upload.wikimedia.org/hist.webm"


# --- _map_license unit tests: extmetadata -> gate-ready license token ---


def test_map_license_public_domain_forms():
    for extmeta in (
        _lic(short="Public domain", machine="pd"),
        _lic(short="Public domain", machine="PD-old"),
        _lic(short="Public Domain Mark 1.0", machine="pdm"),
        _lic(usage="Public domain"),
    ):
        assert commons._map_license(extmeta) == ("publicdomain", None)


def test_map_license_cc0():
    assert commons._map_license(_lic(short="CC0", machine="cc0")) == ("cc0", None)


def test_map_license_cc_by_from_machine_and_short_name():
    assert commons._map_license(_lic(machine="cc-by-4.0")) == ("cc-by", "4.0")
    # human short name with spaces (no machine field) -> normalized to the same base+version
    assert commons._map_license(_lic(short="CC BY 3.0")) == ("cc-by", "3.0")


def test_map_license_restricted_variants_pass_through_for_the_gate_to_reject():
    base, ver = commons._map_license(_lic(machine="cc-by-sa-3.0"))
    assert base == "cc-by-sa" and ver == "3.0"
    base, ver = commons._map_license(_lic(machine="cc-by-nc-2.0"))
    assert base == "cc-by-nc" and ver == "2.0"


def test_map_license_unknown_returns_raw_for_gate():
    assert commons._map_license(_lic(short="All rights reserved")) == ("All rights reserved", None)
    assert commons._map_license({}) == ("", None)


def test_clean_artist_strips_html_and_falls_back_to_credit():
    assert commons._clean_artist({"Artist": {"value": '<a href="x">Ada</a>'}}) == "Ada"
    assert commons._clean_artist({"Credit": {"value": "  Studio  X  "}}) == "Studio X"
    assert commons._clean_artist({}) is None


# --- run.py wiring ---


def test_run_cli_has_commons_flags():
    parser = ingest_run.build_parser()
    assert parser.get_default("commons") == 40
    args = parser.parse_args(["--no-commons"])
    assert args.no_commons is True
    args = parser.parse_args(["--commons", "7"])
    assert args.commons == 7 and args.no_commons is False


def _run_main(monkeypatch, tmp_path, extra_argv):
    """Invoke run.main with every OTHER source disabled and a recording commons.ingest."""
    calls: dict = {}

    def fake_ingest(limit=40):
        calls["limit"] = limit
        return iter(())  # no candidates: keeps main() offline and fast

    monkeypatch.setattr(ingest_run.commons, "ingest", fake_ingest)
    monkeypatch.setattr(
        "sys.argv",
        [
            "ingest.run", "--out", str(tmp_path),
            "--no-openverse", "--no-archive", "--no-loc", "--no-wellcome", "--no-museums",
            *extra_argv,
        ],
    )
    ingest_run.main()
    return calls


def test_run_main_invokes_commons_when_set(tmp_path, monkeypatch):
    calls = _run_main(monkeypatch, tmp_path, ["--commons", "3"])
    assert calls == {"limit": 3}


def test_run_main_skips_commons_when_disabled(tmp_path, monkeypatch):
    calls = _run_main(monkeypatch, tmp_path, ["--no-commons"])
    assert calls == {}  # commons.ingest never invoked


def test_run_main_skips_commons_when_zero(tmp_path, monkeypatch):
    calls = _run_main(monkeypatch, tmp_path, ["--commons", "0"])
    assert calls == {}  # `--commons 0` is an explicit skip, like `--loc 0`
