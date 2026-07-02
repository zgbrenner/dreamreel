"""embed/retime.py: slow-motion baking (pure argv builder + manifest augmentation, ffmpeg faked)."""

from __future__ import annotations

from pathlib import Path
from unittest import mock

from embed import retime as retime_mod


def _manifest() -> dict:
    return {
        "version": "2026.07.01-0000",
        "assets": [
            {"id": "vid-0000", "type": "video", "src": "https://cdn.test/media/a.mp4"},
            {
                "id": "vid-0001",
                "type": "video",
                "src": "https://cdn.test/media/b.mp4",
                "slowSrc": "https://cdn.test/media/slow-vid-0001.mp4",
            },
            {"id": "vid-nosrc", "type": "video"},
            {"id": "img-0000", "type": "image", "src": "https://cdn.test/media/c.webp"},
            {"id": "proc-fog", "type": "procedural"},
        ],
    }


# --- pure argv builder -------------------------------------------------------------------------


def test_build_retime_cmd_default_factor():
    cmd = retime_mod.build_retime_cmd(Path("/in/a.mp4"), Path("/out/slow-a.mp4"))
    assert cmd[0] == "ffmpeg"
    assert cmd[-1] == "/out/slow-a.mp4"
    i = cmd.index("-vf")
    assert cmd[i + 1] == (
        "minterpolate=fps=48:mi_mode=mci:mc_mode=aobmc:vsbmc=1,setpts=2*PTS"
    )
    r = cmd.index("-r")
    assert cmd[r + 1] == "24"


def test_build_retime_cmd_factor_three():
    cmd = retime_mod.build_retime_cmd(Path("/in/a.mp4"), Path("/out/s.mp4"), slow_factor=3.0)
    i = cmd.index("-vf")
    assert cmd[i + 1] == (
        "minterpolate=fps=72:mi_mode=mci:mc_mode=aobmc:vsbmc=1,setpts=3*PTS"
    )


def test_build_retime_cmd_custom_fps():
    cmd = retime_mod.build_retime_cmd(
        Path("/in/a.mp4"), Path("/out/s.mp4"), slow_factor=2.0, target_fps=30
    )
    i = cmd.index("-vf")
    assert "minterpolate=fps=60:" in cmd[i + 1]
    assert cmd[cmd.index("-r") + 1] == "30"


def test_build_retime_cmd_drops_audio_and_is_web_ready():
    cmd = retime_mod.build_retime_cmd(Path("/in/a.mp4"), Path("/out/s.mp4"))
    assert "-an" in cmd
    assert "+faststart" in cmd
    assert cmd[cmd.index("-c:v") + 1] == "libx264"
    assert cmd[cmd.index("-pix_fmt") + 1] == "yuv420p"
    # video-only: no audio codec args
    assert "-c:a" not in cmd


# --- retime_video (subprocess mocked) ----------------------------------------------------------


def test_retime_video_success_writes_named_output(tmp_path: Path):
    def fake_run(cmd, **kwargs):
        Path(cmd[-1]).write_bytes(b"\0" * (32 * 1024))
        return mock.Mock(returncode=0)

    with mock.patch.object(retime_mod.subprocess, "run", side_effect=fake_run) as run:
        out = retime_mod.retime_video(tmp_path / "in.mp4", tmp_path, "vid-0000")
    assert out == tmp_path / "slow-vid-0000.mp4"
    assert out.exists()
    # timeout is passed — minterpolate is slow
    assert run.call_args.kwargs["timeout"] == retime_mod.FFMPEG_TIMEOUT_S


def test_retime_video_failure_returns_none(tmp_path: Path):
    err = retime_mod.subprocess.CalledProcessError(1, ["ffmpeg"])
    with mock.patch.object(retime_mod.subprocess, "run", side_effect=err):
        assert retime_mod.retime_video(tmp_path / "in.mp4", tmp_path, "vid-0000") is None


def test_retime_video_tiny_output_returns_none(tmp_path: Path):
    def fake_run(cmd, **kwargs):
        Path(cmd[-1]).write_bytes(b"\0" * 100)  # sub-16KB: broken encode
        return mock.Mock(returncode=0)

    with mock.patch.object(retime_mod.subprocess, "run", side_effect=fake_run):
        assert retime_mod.retime_video(tmp_path / "in.mp4", tmp_path, "vid-0000") is None


# --- manifest augmentation (ffmpeg + network faked) --------------------------------------------


def _fake_fetch(monkeypatch):
    class Resp:
        content = b"fake-mp4-bytes"

        def raise_for_status(self):
            return None

    monkeypatch.setattr(retime_mod.requests, "get", lambda *a, **k: Resp())


def _fake_retime_fn(src: Path, dst_dir: Path, asset_id: str) -> Path:
    p = dst_dir / f"slow-{asset_id}.mp4"
    p.write_bytes(b"\0" * (32 * 1024))
    return p


def test_annotate_bakes_videos_only(tmp_path: Path, monkeypatch):
    _fake_fetch(monkeypatch)
    out, derivs = retime_mod.annotate(_manifest(), tmp_path, retime_fn=_fake_retime_fn)
    assert set(derivs) == {"vid-0000", "vid-0001"}
    assert all(p.exists() and p.name == f"slow-{aid}.mp4" for aid, p in derivs.items())
    # slowSrc is NOT set by annotate (that happens post-upload via apply_urls)
    by_id = {a["id"]: a for a in out["assets"]}
    assert "slowSrc" not in by_id["vid-0000"]
    assert out["version"] != "2026.07.01-0000"


def test_annotate_only_missing_skips_already_baked(tmp_path: Path, monkeypatch):
    _fake_fetch(monkeypatch)
    _, derivs = retime_mod.annotate(
        _manifest(), tmp_path, only_missing=True, retime_fn=_fake_retime_fn
    )
    assert set(derivs) == {"vid-0000"}


def test_annotate_limit(tmp_path: Path, monkeypatch):
    _fake_fetch(monkeypatch)
    _, derivs = retime_mod.annotate(_manifest(), tmp_path, limit=1, retime_fn=_fake_retime_fn)
    assert set(derivs) == {"vid-0000"}


def test_annotate_skips_failed_retimes(tmp_path: Path, monkeypatch):
    _fake_fetch(monkeypatch)
    _, derivs = retime_mod.annotate(
        _manifest(), tmp_path, retime_fn=lambda src, d, aid: None
    )
    assert derivs == {}


def test_apply_urls_sets_slow_src():
    m = _manifest()
    n = retime_mod.apply_urls(m, {"vid-0000": "https://cdn.test/media/slow-vid-0000.mp4"})
    assert n == 1
    by_id = {a["id"]: a for a in m["assets"]}
    assert by_id["vid-0000"]["slowSrc"] == "https://cdn.test/media/slow-vid-0000.mp4"
    assert "slowSrc" not in by_id["img-0000"]
