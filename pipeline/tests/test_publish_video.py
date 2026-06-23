"""Video assets transcode + upload as video/mp4, and the internal _local key never ships."""
from __future__ import annotations

import json
from pathlib import Path

from publish import run as pub
from publish import upload_r2
from publish.transcode import transcode_video


def test_transcode_video_cmd_has_ss_before_i(monkeypatch, tmp_path):
    """transcode_video must place -ss <start_seconds> BEFORE -i for fast seek."""
    captured = {}

    def fake_run(cmd, check, capture_output):
        captured["cmd"] = cmd
        # Simulate ffmpeg creating the output file
        Path(cmd[-1]).parent.mkdir(parents=True, exist_ok=True)
        Path(cmd[-1]).write_bytes(b"mp4")

    monkeypatch.setattr("publish.transcode.subprocess.run", fake_run)

    src = tmp_path / "film.mp4"
    src.write_bytes(b"x")
    result = transcode_video(src, tmp_path / "deriv", start_seconds=300.0)

    cmd = captured["cmd"]
    # -ss must appear before -i
    ss_idx = cmd.index("-ss")
    i_idx = cmd.index("-i")
    assert ss_idx < i_idx, f"-ss at {ss_idx} should precede -i at {i_idx}"
    # -ss value must be the passed start_seconds
    assert cmd[ss_idx + 1] == "300.0"
    assert result is not None


def test_transcode_video_default_start_is_zero(monkeypatch, tmp_path):
    """Default start_seconds=0.0 still emits -ss 0.0 before -i."""
    captured = {}

    def fake_run(cmd, check, capture_output):
        captured["cmd"] = cmd
        Path(cmd[-1]).parent.mkdir(parents=True, exist_ok=True)
        Path(cmd[-1]).write_bytes(b"mp4")

    monkeypatch.setattr("publish.transcode.subprocess.run", fake_run)

    src = tmp_path / "film.mp4"
    src.write_bytes(b"x")
    transcode_video(src, tmp_path / "deriv")

    cmd = captured["cmd"]
    ss_idx = cmd.index("-ss")
    assert cmd[ss_idx + 1] == "0.0"


def test_build_derivatives_transcodes_local_video(tmp_path, monkeypatch):
    src = tmp_path / "film.mp4"
    src.write_bytes(b"v")
    out_mp4 = tmp_path / "deriv" / "film.mp4"

    def fake_transcode_video(s, dst_dir, max_seconds=12, start_seconds=0.0):
        dst_dir.mkdir(parents=True, exist_ok=True)
        out_mp4.write_bytes(b"clip")
        return out_mp4

    monkeypatch.setattr(pub, "transcode_video", fake_transcode_video)
    monkeypatch.setattr(pub, "probe_duration", lambda path: 1000.0)
    assets = [{"id": "vid-0000", "type": "video", "_local": str(src)}]
    derivs = pub.build_derivatives(assets, tmp_path / "fetched.jsonl", tmp_path / "deriv")

    assert derivs == {"vid-0000": out_mp4}


def test_build_derivatives_passes_start_seconds(tmp_path, monkeypatch):
    """build_derivatives must compute and pass start_seconds to transcode_video."""
    src = tmp_path / "film.mp4"
    src.write_bytes(b"v")
    out_mp4 = tmp_path / "deriv" / "film.mp4"
    captured = {}

    def fake_transcode_video(s, dst_dir, max_seconds=12, start_seconds=0.0):
        captured["start_seconds"] = start_seconds
        dst_dir.mkdir(parents=True, exist_ok=True)
        out_mp4.write_bytes(b"clip")
        return out_mp4

    monkeypatch.setattr(pub, "transcode_video", fake_transcode_video)
    # 1000-second film → 30% = 300.0
    monkeypatch.setattr(pub, "probe_duration", lambda path: 1000.0)
    assets = [{"id": "vid-0000", "type": "video", "_local": str(src)}]
    pub.build_derivatives(assets, tmp_path / "fetched.jsonl", tmp_path / "deriv")

    assert captured["start_seconds"] == 300.0


def test_build_derivatives_start_zero_when_probe_fails(tmp_path, monkeypatch):
    """If probe_duration returns None, start_seconds must fall back to 0.0 (no crash)."""
    src = tmp_path / "film.mp4"
    src.write_bytes(b"v")
    out_mp4 = tmp_path / "deriv" / "film.mp4"
    captured = {}

    def fake_transcode_video(s, dst_dir, max_seconds=12, start_seconds=0.0):
        captured["start_seconds"] = start_seconds
        dst_dir.mkdir(parents=True, exist_ok=True)
        out_mp4.write_bytes(b"clip")
        return out_mp4

    monkeypatch.setattr(pub, "transcode_video", fake_transcode_video)
    monkeypatch.setattr(pub, "probe_duration", lambda path: None)
    assets = [{"id": "vid-0000", "type": "video", "_local": str(src)}]
    pub.build_derivatives(assets, tmp_path / "fetched.jsonl", tmp_path / "deriv")

    assert captured["start_seconds"] == 0.0


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
