"""Video download step (candidates.jsonl -> fetched_videos.jsonl).

Network and ffmpeg-poster are mocked; proves only videos are recorded, each row carries a
local video path and a poster path, and fetch/poster failures are dropped.
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


def test_download_videos_records_only_videos_with_poster(tmp_path, monkeypatch):
    monkeypatch.setattr(dl.requests, "get", lambda url, headers=None, timeout=None: FakeResp())
    # poster extraction succeeds: write a stub jpg next to the asked-for dst
    def fake_poster(video, dst_dir, at_seconds=1.0):
        dst_dir.mkdir(parents=True, exist_ok=True)
        p = dst_dir / (video.stem + ".jpg")
        p.write_bytes(b"jpeg")
        return p
    monkeypatch.setattr(dl, "extract_poster", fake_poster)

    rows = dl.download_videos(_candidates(tmp_path), tmp_path)

    assert len(rows) == 1
    assert rows[0]["candidate"]["type"] == "video"
    assert Path(rows[0]["video_path"]).exists()
    assert Path(rows[0]["poster_path"]).exists()

    written = [
        json.loads(line)
        for line in (tmp_path / "fetched_videos.jsonl").read_text().splitlines()
        if line.strip()
    ]
    assert len(written) == 1


def test_download_videos_drops_when_poster_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(dl.requests, "get", lambda url, headers=None, timeout=None: FakeResp())
    monkeypatch.setattr(dl, "extract_poster", lambda video, dst_dir, at_seconds=1.0: None)

    rows = dl.download_videos(_candidates(tmp_path), tmp_path)
    assert rows == []


def test_download_videos_drops_when_fetch_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(dl.requests, "get", lambda url, headers=None, timeout=None: FakeResp(status=404))
    monkeypatch.setattr(dl, "extract_poster", lambda video, dst_dir, at_seconds=1.0: None)
    rows = dl.download_videos(_candidates(tmp_path), tmp_path)
    assert rows == []
