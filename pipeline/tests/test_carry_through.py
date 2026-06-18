"""Candidate -> asset carry-through.

The existing shape test builds with no fetched images, so only CC0 procedural/text assets are
exercised. This test feeds a synthetic fetched.jsonl (one CC-BY image, one CC0 image) through
build_manifest and asserts the license/source/attribution metadata is carried onto every asset
*unchanged* — the pipeline guardrail — and that image embeddings are L2-normalized at the
declared dim. Uses the deterministic hash embedder (no torch needed).
"""

from __future__ import annotations

import json
import math
from pathlib import Path

from embed.build_manifest import build
from ingest.normalize import Candidate, make_candidate


def _norm(v: list[float]) -> float:
    return math.sqrt(sum(x * x for x in v))


def _write_fetched(tmp_path: Path, candidates: list[Candidate]) -> Path:
    img_dir = tmp_path / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for i, cand in enumerate(candidates):
        p = img_dir / f"img{i}.jpg"
        p.write_bytes(b"\xff\xd8\xff" + bytes([i + 1]) * 64)  # distinct fake bytes per image
        rows.append({"candidate": cand.model_dump(), "local_path": str(p)})
    fpath = tmp_path / "fetched.jsonl"
    with fpath.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    return fpath


def test_image_assets_carry_license_metadata_through(tmp_path: Path):
    ccby, _ = make_candidate(
        source_url="https://media.example/by.jpg",
        type="image",
        source="Openverse / Wikimedia",
        raw_license="cc-by",
        license_version="4.0",
        creator="A. Photographer",
        attribution_url="https://wm.example/landing",
        tags=["ruins", "sea"],
        query_theme="ruins",
    )
    cc0, _ = make_candidate(
        source_url="https://media.example/cc0.jpg",
        type="image",
        source="Openverse / Flickr Commons",
        raw_license="cc0",
        tags=["antique photograph"],  # anchor theme — exempt from mood curation so this carry-through asset survives
        query_theme="antique photograph",
    )
    assert ccby is not None and cc0 is not None

    fetched = _write_fetched(tmp_path, [ccby, cc0])
    out = build(tmp_path / "out", fetched_path=fetched)
    m = json.loads(out.read_text())

    images = [a for a in m["assets"] if a["type"] == "image"]
    assert len(images) == 2

    # CC-BY: every license field carried through unchanged, attribution preserved verbatim.
    by_asset = next(a for a in images if a["src"] == "https://media.example/by.jpg")
    assert by_asset["license"] == "CC-BY-4.0"
    assert by_asset["source"] == "Openverse / Wikimedia"
    assert by_asset["attribution"] == ccby.attribution
    assert "A. Photographer" in by_asset["attribution"]
    assert by_asset["attributionUrl"] == "https://wm.example/landing"
    assert set(by_asset["tags"]) >= {"ruins", "sea"}
    assert len(by_asset["embedding"]) == m["embeddingDim"]
    assert abs(_norm(by_asset["embedding"]) - 1.0) < 1e-3

    # CC0: carried through, and (correctly) no attribution fields emitted.
    cc0_asset = next(a for a in images if a["src"] == "https://media.example/cc0.jpg")
    assert cc0_asset["license"] == "CC0"
    assert cc0_asset["source"] == "Openverse / Flickr Commons"
    assert "attribution" not in cc0_asset
    assert "attributionUrl" not in cc0_asset

    # distinct source content -> distinct embeddings (sanity on the per-image path)
    assert by_asset["embedding"] != cc0_asset["embedding"]
