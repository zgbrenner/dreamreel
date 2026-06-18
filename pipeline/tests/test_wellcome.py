"""Wellcome ingester test against a real recorded response shape (2026-06-18).

Confirms: IIIF image-URL construction, license mapping (pdm->PD, cc0->CC0, cc-by kept with
attribution, cc-by-nc rejected), and landing-URL construction.
"""

from __future__ import annotations

from ingest import wellcome


class FakeResp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise AssertionError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


def _loc(license_id, credit="Wellcome Collection"):
    return {
        "url": "https://iiif.wellcomecollection.org/image/L0011861/info.json",
        "credit": credit,
        "license": {"id": license_id, "type": "License", "label": license_id, "url": "https://x"},
        "locationType": {"id": "iiif-image"},
        "type": "DigitalLocation",
    }


WELLCOME_RESULTS = [
    {"id": "pdm1", "locations": [_loc("pdm")], "source": {"id": "w-pdm", "title": "Anatomy plate"}},
    {"id": "cc01", "locations": [_loc("cc0")], "source": {"id": "w-cc0", "title": "Skull study"}},
    {"id": "by1", "locations": [_loc("cc-by")], "source": {"id": "w-by", "title": "Ritual mask"}},
    {"id": "nc1", "locations": [_loc("cc-by-nc")], "source": {"id": "w-nc", "title": "No commercial"}},
]


def test_wellcome_maps_and_gates(monkeypatch):
    def fake_get(url, params=None, headers=None, timeout=None):
        page = (params or {}).get("page", 1)
        return FakeResp({"results": WELLCOME_RESULTS if page == 1 else []})

    monkeypatch.setattr(wellcome.requests, "get", fake_get)
    monkeypatch.setattr(wellcome.time, "sleep", lambda *_a, **_k: None)

    kept, rejected = [], []
    for cand, rej in wellcome.ingest(themes=["anatomy"], per_theme=10):
        (kept if cand else rejected).append(cand or rej)

    # pdm + cc0 + cc-by kept; cc-by-nc rejected
    assert len(kept) == 3 and len(rejected) == 1

    pdm = next(c for c in kept if c.license == "PD")
    assert pdm.type == "image"
    assert pdm.source == "Wellcome Collection"
    assert pdm.source_url == (
        "https://iiif.wellcomecollection.org/image/L0011861/full/!1024,1024/0/default.jpg"
    )
    assert pdm.foreign_landing_url == "https://wellcomecollection.org/works/w-pdm"
    assert "anatomy" in pdm.tags

    by = next(c for c in kept if c.license.startswith("CC-BY"))
    assert by.attribution and "Wellcome" in by.attribution  # CC-BY keeps credit

    assert rejected[0].raw_license == "cc-by-nc"
