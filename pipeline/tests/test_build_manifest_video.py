"""build_manifest emits valid video assets from fetched_videos.jsonl.

Uses the offline hash-fallback embedder (no torch) via get_embedder(), so embeddings are
deterministic and L2-normalized without a CLIP model.
"""
from __future__ import annotations

import json
from pathlib import Path

from embed import build_manifest as bm
from embed.clip_backend import get_embedder
from embed.mood_axes import build_axes


def _write_videos_jsonl(tmp_path: Path) -> Path:
    poster = tmp_path / "posters" / "film.jpg"
    poster.parent.mkdir(parents=True, exist_ok=True)
    # 1×1 RGB JPEG — valid for open_clip (PIL) and deterministic for hash-fallback (bytes hash)
    poster.write_bytes(
        bytes.fromhex(
            "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a"
            "0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434"
            "341f27393d38323c2e333432ffdb0043010909090c0b0c180d0d1832211c213232323232323232"
            "323232323232323232323232323232323232323232323232323232323232323232323232323232"
            "323232ffc00011080001000103012200021101031101ffc4001f00000105010101010101000000"
            "00000000000102030405060708090a0bffc400b5100002010303020403050504040000017d0102"
            "0300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a1617"
            "18191a25262728292a3435363738393a434445464748494a535455565758595a63646566676869"
            "6a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4"
            "b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3"
            "f4f5f6f7f8f9faffc4001f0100030101010101010101010000000000000102030405060708090a"
            "0bffc400b51100020102040403040705040400010277000102031104052131061241510761711322"
            "328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a"
            "434445464748494a535455565758595a636465666768696a737475767778797a82838485868788"
            "898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9ca"
            "d2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9faffda000c03010002110311"
            "003f00e3a8a28af1cf7cffd9"
        )
    )
    video = tmp_path / "videos" / "film.mp4"
    video.parent.mkdir(parents=True, exist_ok=True)
    video.write_bytes(b"film")
    row = {
        "candidate": {
            "source_url": "https://media.example/film.mp4",
            "type": "video",
            "source": "Archive.org / prelinger",
            "license": "PD",
            "attribution": None,
            "attribution_url": None,
            "tags": ["film", "decay"],
            "query_theme": "decay",
            "foreign_landing_url": None,
        },
        "video_path": str(video),
        "poster_path": str(poster),
    }
    p = tmp_path / "fetched_videos.jsonl"
    p.write_text(json.dumps(row) + "\n", encoding="utf-8")
    return p


def test_build_video_assets_emits_valid_video_asset(tmp_path):
    embedder = get_embedder()
    axes = build_axes(embedder)
    assets = bm.build_video_assets(embedder, axes, _write_videos_jsonl(tmp_path))

    assert len(assets) == 1
    a = assets[0]
    assert a["id"] == "vid-0000"
    assert a["type"] == "video"
    assert a["dwellBase"] == 7.5
    assert a["src"] == "https://media.example/film.mp4"
    assert a["_local"].endswith("film.mp4")
    assert len(a["embedding"]) == embedder.dim
    assert abs(sum(x * x for x in a["embedding"]) - 1.0) < 1e-3  # L2-normalized


def test_build_video_assets_empty_when_no_file(tmp_path):
    embedder = get_embedder()
    axes = build_axes(embedder)
    assert bm.build_video_assets(embedder, axes, tmp_path / "missing.jsonl") == []
