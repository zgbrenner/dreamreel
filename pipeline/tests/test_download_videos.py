"""Video download step (candidates.jsonl -> fetched_videos.jsonl).

Network and frame_selector are mocked; proves only videos are recorded, each row carries a
local video path, poster path, and clip_start_seconds, and fetch/poster failures are dropped.

The content-aware frame selection (select_best_frame) is now responsible for poster extraction
and choosing the clip timestamp; this module's tests mock at that boundary.
"""
from __future__ import annotations

import json
from pathlib import Path

from embed import download as dl
from ingest.normalize import make_candidate


class FakeResp:
    def __init__(self, content=b"film-bytes", status=200):
        self.content = content
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            import requests
            raise requests.HTTPError(str(self.status_code))


class FakeEmbedder:
    backend = "hash-fallback"
    dim = 4


def _candidates(tmp_path: Path):
    img, _ = make_candidate(
        source_url="https://media.example/ok.jpg", type="image",
        source="Openverse / Flickr Commons", raw_license="cc0", tags=["sea"],
    )
    vid, _ = make_candidate(
        source_url="https://media.example/film.mp4", type="video",
        source="Archive.org / prelinger", raw_license="publicdomain", tags=["film"],
    )
    return [img, vid]


def _patch_frame_selector(monkeypatch, tmp_path, poster_path=None, clip_ts=300.0):
    """Monkeypatch all frame_selector entry points on the download module."""
    monkeypatch.setattr(dl, "get_embedder", lambda: FakeEmbedder())
    monkeypatch.setattr(dl, "build_avoid_vector", lambda emb: None)
    _poster = poster_path  # closed over

    def fake_select(video, dst_dir, embedder, avoid_vec, duration):
        if _poster is None:
            return (None, 0.0)
        dst_dir.mkdir(parents=True, exist_ok=True)
        p = dst_dir / (video.stem + ".jpg")
        p.write_bytes(b"jpeg")
        return (p, clip_ts)

    monkeypatch.setattr(dl, "select_best_frame", fake_select)
    return fake_select


def test_download_videos_records_only_videos_with_poster(tmp_path, monkeypatch):
    monkeypatch.setattr(dl.requests, "get", lambda url, headers=None, timeout=None: FakeResp())
    monkeypatch.setattr(dl, "probe_duration", lambda path: 1000.0)
    _patch_frame_selector(monkeypatch, tmp_path, poster_path=True, clip_ts=300.0)

    rows = dl.download_videos(_candidates(tmp_path), tmp_path)

    assert len(rows) == 1
    assert rows[0]["candidate"]["type"] == "video"
    assert Path(rows[0]["video_path"]).exists()
    assert Path(rows[0]["poster_path"]).exists()
    assert rows[0]["clip_start_seconds"] == 300.0

    written = [
        json.loads(line)
        for line in (tmp_path / "fetched_videos.jsonl").read_text().splitlines()
        if line.strip()
    ]
    assert len(written) == 1
    assert written[0]["clip_start_seconds"] == 300.0


def test_download_videos_drops_when_poster_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(dl.requests, "get", lambda url, headers=None, timeout=None: FakeResp())
    monkeypatch.setattr(dl, "probe_duration", lambda path: 1000.0)
    _patch_frame_selector(monkeypatch, tmp_path, poster_path=None)

    rows = dl.download_videos(_candidates(tmp_path), tmp_path)
    assert rows == []


def test_download_videos_drops_when_fetch_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(dl.requests, "get", lambda url, headers=None, timeout=None: FakeResp(status=404))
    monkeypatch.setattr(dl, "probe_duration", lambda path: None)
    _patch_frame_selector(monkeypatch, tmp_path, poster_path=None)
    rows = dl.download_videos(_candidates(tmp_path), tmp_path)
    assert rows == []


def test_download_videos_clip_start_seconds_in_row(tmp_path, monkeypatch):
    """Each row must carry clip_start_seconds from select_best_frame."""
    monkeypatch.setattr(dl.requests, "get", lambda url, headers=None, timeout=None: FakeResp())
    monkeypatch.setattr(dl, "probe_duration", lambda path: 1000.0)
    _patch_frame_selector(monkeypatch, tmp_path, poster_path=True, clip_ts=650.0)

    rows = dl.download_videos(_candidates(tmp_path), tmp_path)
    assert len(rows) == 1
    assert rows[0]["clip_start_seconds"] == 650.0
