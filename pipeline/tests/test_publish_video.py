"""Video assets transcode + upload as video/mp4, and the internal _local key never ships."""
from __future__ import annotations

import json
from pathlib import Path

from publish import run as pub
from publish import upload_r2


def test_build_derivatives_transcodes_local_video(tmp_path, monkeypatch):
    src = tmp_path / "film.mp4"
    src.write_bytes(b"v")
    out_mp4 = tmp_path / "deriv" / "film.mp4"

    def fake_transcode_video(s, dst_dir, max_seconds=12):
        dst_dir.mkdir(parents=True, exist_ok=True)
        out_mp4.write_bytes(b"clip")
        return out_mp4

    monkeypatch.setattr(pub, "transcode_video", fake_transcode_video)
    assets = [{"id": "vid-0000", "type": "video", "_local": str(src)}]
    derivs = pub.build_derivatives(assets, tmp_path / "fetched.jsonl", tmp_path / "deriv")

    assert derivs == {"vid-0000": out_mp4}


def test_publish_manifest_strips_local(monkeypatch):
    uploaded = {}

    class FakeClient:
        def put_object(self, **kw):
            uploaded[kw["Key"]] = kw["Body"]

    monkeypatch.setenv("R2_BUCKET", "b")
    monkeypatch.setenv("R2_PUBLIC_BASE", "https://cdn.example")
    monkeypatch.setattr(upload_r2, "_client", lambda: FakeClient())

    manifest = {
        "version": "v1",
        "assets": [{"id": "vid-0000", "type": "video", "src": "https://x/film.mp4", "_local": "/tmp/film.mp4"}],
    }
    upload_r2.publish_manifest(manifest, {"vid-0000": "https://cdn.example/media/film.mp4"})

    body = json.loads(uploaded["manifest/latest.json"].decode("utf-8"))
    asset = body["assets"][0]
    assert asset["src"] == "https://cdn.example/media/film.mp4"
    assert "_local" not in asset
