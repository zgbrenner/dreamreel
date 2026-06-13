"""License-policy tests — the ingest backstop must keep ship-safe and reject the rest."""

from ingest.licenses import evaluate, normalize_license
from ingest.normalize import make_candidate


def test_cc0_kept():
    d = evaluate("cc0")
    assert d.keep and d.normalized == "CC0" and not d.requires_attribution


def test_public_domain_kept():
    assert evaluate("Public Domain Mark").keep
    assert evaluate("publicdomain").normalized == "PD"


def test_cc_by_kept_only_with_attribution():
    without = evaluate("cc-by", "4.0", attribution=None)
    assert not without.keep
    with_attr = evaluate("cc-by", "4.0", attribution="Jane Doe")
    assert with_attr.keep and with_attr.requires_attribution
    assert with_attr.normalized == "CC-BY-4.0"


def test_cc_by_nc_rejected():
    d = evaluate("cc-by-nc", "4.0", attribution="Jane Doe")
    assert not d.keep
    assert "non-commercial" in d.reason or "restricted" in d.reason


def test_cc_by_nd_and_sa_rejected():
    assert not evaluate("cc-by-nd", attribution="x").keep
    assert not evaluate("cc-by-sa", attribution="x").keep


def test_unknown_rejected():
    assert not evaluate("").keep
    assert not evaluate("all-rights-reserved").keep
    assert not evaluate(None).keep


def test_normalize_variants():
    assert normalize_license("CC0 1.0") == "CC0"
    assert normalize_license("cc-by", "4.0") == "CC-BY-4.0"


def test_make_candidate_gate():
    # a CC0 record is kept
    cand, rej = make_candidate(
        source_url="https://x/y.jpg",
        type="image",
        source="Openverse / Flickr Commons",
        raw_license="cc0",
        tags=["sea"],
    )
    assert cand is not None and rej is None
    assert cand.attribution is None  # CC0 needs none

    # a CC-BY-NC record is rejected with a logged reason
    cand2, rej2 = make_candidate(
        source_url="https://x/z.jpg",
        type="image",
        source="Openverse / Flickr",
        raw_license="cc-by-nc",
        license_version="4.0",
        creator="Someone",
    )
    assert cand2 is None and rej2 is not None
    assert rej2.reason


def test_cc_by_candidate_carries_attribution():
    cand, rej = make_candidate(
        source_url="https://x/a.jpg",
        type="image",
        source="Openverse / Wikimedia",
        raw_license="cc-by",
        license_version="4.0",
        creator="A. Photographer",
        attribution_url="https://example/landing",
    )
    assert cand is not None and rej is None
    assert cand.attribution and "A. Photographer" in cand.attribution
    assert cand.attribution_url == "https://example/landing"
