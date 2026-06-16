"""Download step (the candidates.jsonl -> fetched.jsonl link that feeds build_manifest).

Network is mocked; this proves the wiring: only successfully-fetched *images* are recorded,
videos are skipped (handled in publish/transcode), failures are dropped, and the CLI writes
fetched.jsonl that build_manifest consumes.
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

import pytest
import requests

from embed import download as dl
from ingest.normalize import make_candidate

# A real 1x1 PNG, so _resize_in_place succeeds when Pillow is installed (as it is in CI).
_PNG_1x1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOojrIBAAJlARLq63acAAAAAElFTkSuQmCC"
)


class FakeResp:
    def __init__(self, content=b"", status=200):
        self.content = content
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code))


def _candidates_file(tmp_path: Path):
    ok, _ = make_candidate(
        source_url="https://media.example/ok.jpg", type="image",
        source="Openverse / Flickr Commons", raw_license="cc0", tags=["sea"],
    )
    bad, _ = make_candidate(
        source_url="https://media.example/bad.jpg", type="image",
        source="Openverse / Flickr", raw_license="cc0", tags=["ruins"],
    )
    vid, _ = make_candidate(
        source_url="https://media.example/film.mp4", type="video",
        source="Archive.org / prelinger", raw_license="publicdomain", tags=["film"],
    )
    path = tmp_path / "candidates.jsonl"
    with path.open("w", encoding="utf-8") as f:
        for c in (ok, bad, vid):
            f.write(c.model_dump_json() + "\n")
    return path


def _fake_get(url, headers=None, timeout=None):
    if url.endswith("bad.jpg"):
        return FakeResp(b"", 404)
    return FakeResp(_PNG_1x1, 200)


def test_download_records_only_successful_images(tmp_path, monkeypatch):
    monkeypatch.setattr(dl.requests, "get", _fake_get)
    cands = dl.load_candidates(_candidates_file(tmp_path))
    assert len(cands) == 3  # round-trips candidates.jsonl

    rows = dl.download(cands, tmp_path)

    assert len(rows) == 1  # video skipped, 404 dropped
    assert rows[0]["candidate"]["source_url"] == "https://media.example/ok.jpg"
    assert rows[0]["candidate"]["type"] == "image"
    assert Path(rows[0]["local_path"]).exists()

    fetched = [
        json.loads(line)
        for line in (tmp_path / "fetched.jsonl").read_text().splitlines()
        if line.strip()
    ]
    assert len(fetched) == 1
    assert fetched[0]["candidate"]["license"] == "CC0"


def test_cli_main_writes_fetched(tmp_path, monkeypatch):
    monkeypatch.setattr(dl.requests, "get", _fake_get)
    cand_path = _candidates_file(tmp_path)
    monkeypatch.setattr(
        sys, "argv", ["download", "--candidates", str(cand_path), "--out", str(tmp_path)]
    )
    dl.main()
    fetched = (tmp_path / "fetched.jsonl").read_text().strip().splitlines()
    assert len(fetched) == 1  # the one good image


def test_cli_main_errors_without_candidates(tmp_path, monkeypatch):
    monkeypatch.setattr(
        sys, "argv", ["download", "--candidates", str(tmp_path / "nope.jsonl"), "--out", str(tmp_path)]
    )
    with pytest.raises(SystemExit):
        dl.main()
