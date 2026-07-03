"""embed/colorize.py: colorized-variant baking (pure argv builders + manifest augmentation).

All model (DeOldify) and ffmpeg calls are faked/mocked — no GPU, ffmpeg, or network is touched.
"""

from __future__ import annotations

from pathlib import Path
from unittest import mock

from embed import colorize as colorize_mod


def _manifest() -> dict:
    return {
        "version": "2026.07.01-0000",
        "assets": [
            {"id": "vid-0000", "type": "video", "src": "https://cdn.test/media/a.mp4"},
            {
                "id": "vid-0001",
                "type": "video",
                "src": "https://cdn.test/media/b.mp4",
                "colorSrc": "https://cdn.test/media/color-vid-0001.mp4",
            },
            {"id": "vid-nosrc", "type": "video"},
            {"id": "img-0000", "type": "image", "src": "https://cdn.test/media/c.webp"},
            {"id": "proc-fog", "type": "procedural"},
        ],
    }


# --- pure argv builders ------------------------------------------------------------------------


def test_build_extract_frames_cmd_default_fps():
    cmd = colorize_mod.build_extract_frames_cmd(Path("/in/a.mp4"), Path("/work/raw"))
    assert cmd[0] == "ffmpeg"
    assert cmd[cmd.index("-i") + 1] == "/in/a.mp4"
    assert cmd[cmd.index("-vf") + 1] == "fps=24"
    assert cmd[-1] == "/work/raw/frame-%06d.png"


def test_build_extract_frames_cmd_custom_fps():
    cmd = colorize_mod.build_extract_frames_cmd(Path("/in/a.mp4"), Path("/work/raw"), fps=30)
    assert cmd[cmd.index("-vf") + 1] == "fps=30"


def test_build_colorize_video_cmd_reassembles_from_frame_sequence():
    cmd = colorize_mod.build_colorize_video_cmd(
        Path("/in/a.mp4"), Path("/work/col"), Path("/out/color-a.mp4")
    )
    assert cmd[0] == "ffmpeg"
    assert cmd[-1] == "/out/color-a.mp4"
    # image sequence input needs -framerate BEFORE its -i; pattern lives in the frames dir
    fr = cmd.index("-framerate")
    assert cmd[fr + 1] == "24"
    assert cmd[fr + 2] == "-i"
    assert cmd[fr + 3] == "/work/col/frame-%06d.png"
    # the original clip is a second input (for optional audio re-mux)
    assert "/in/a.mp4" in cmd


def test_build_colorize_video_cmd_is_web_ready_h264():
    cmd = colorize_mod.build_colorize_video_cmd(
        Path("/in/a.mp4"), Path("/work/col"), Path("/out/c.mp4")
    )
    assert cmd[cmd.index("-c:v") + 1] == "libx264"
    assert cmd[cmd.index("-pix_fmt") + 1] == "yuv420p"
    assert "+faststart" in cmd
    # original audio muxed optionally so a silent source degrades gracefully
    assert "1:a:0?" in cmd


def test_build_colorize_video_cmd_custom_fps():
    cmd = colorize_mod.build_colorize_video_cmd(
        Path("/in/a.mp4"), Path("/work/col"), Path("/out/c.mp4"), fps=30
    )
    assert cmd[cmd.index("-framerate") + 1] == "30"


# --- colorize_video (subprocess mocked, colorizer faked) ---------------------------------------


def _fake_colorize(in_png: Path, out_png: Path, render_factor: int = 21) -> bool:
    out_png.parent.mkdir(parents=True, exist_ok=True)
    out_png.write_bytes(b"col")
    return True


def _fake_run_ok(cmd, **kwargs):
    """Fake ffmpeg: the extract call writes numbered frames; the reassemble call writes the mp4."""
    last = Path(cmd[-1])
    if "%06d" in last.name:  # extract → drop a couple of frames into the raw dir
        last.parent.mkdir(parents=True, exist_ok=True)
        (last.parent / "frame-000001.png").write_bytes(b"raw")
        (last.parent / "frame-000002.png").write_bytes(b"raw")
    else:  # reassemble → a healthy mp4
        last.write_bytes(b"\0" * (32 * 1024))
    return mock.Mock(returncode=0)


def test_colorize_video_success_writes_named_output_and_cleans_temp(tmp_path: Path):
    with mock.patch.object(colorize_mod.subprocess, "run", side_effect=_fake_run_ok) as run:
        out = colorize_mod.colorize_video(tmp_path / "in.mp4", tmp_path, "vid-0000", _fake_colorize)
    assert out == tmp_path / "color-vid-0000.mp4"
    assert out.exists()
    # per-asset frame dirs are cleaned in the finally
    assert not (tmp_path / "frames-raw-vid-0000").exists()
    assert not (tmp_path / "frames-col-vid-0000").exists()
    # ffmpeg steps carry the timeout (extract + reassemble)
    assert all(c.kwargs["timeout"] == colorize_mod.FFMPEG_TIMEOUT_S for c in run.call_args_list)


def test_colorize_video_extract_failure_returns_none(tmp_path: Path):
    err = colorize_mod.subprocess.CalledProcessError(1, ["ffmpeg"])
    with mock.patch.object(colorize_mod.subprocess, "run", side_effect=err):
        out = colorize_mod.colorize_video(tmp_path / "in.mp4", tmp_path, "vid-0000", _fake_colorize)
    assert out is None
    assert not (tmp_path / "frames-raw-vid-0000").exists()


def test_colorize_video_failed_frame_returns_none_and_cleans(tmp_path: Path):
    def fail_colorize(i: Path, o: Path, render_factor: int = 21) -> bool:
        return False

    with mock.patch.object(colorize_mod.subprocess, "run", side_effect=_fake_run_ok):
        out = colorize_mod.colorize_video(tmp_path / "in.mp4", tmp_path, "vid-0000", fail_colorize)
    assert out is None
    assert not (tmp_path / "frames-col-vid-0000").exists()


def test_colorize_video_tiny_output_returns_none(tmp_path: Path):
    def fake_run_small(cmd, **kwargs):
        last = Path(cmd[-1])
        if "%06d" in last.name:
            last.parent.mkdir(parents=True, exist_ok=True)
            (last.parent / "frame-000001.png").write_bytes(b"raw")
        else:
            last.write_bytes(b"\0" * 100)  # sub-16KB: broken encode
        return mock.Mock(returncode=0)

    with mock.patch.object(colorize_mod.subprocess, "run", side_effect=fake_run_small):
        assert colorize_mod.colorize_video(tmp_path / "in.mp4", tmp_path, "vid-0000", _fake_colorize) is None


# --- manifest augmentation (colorizer + ffmpeg + network faked) --------------------------------


def _fake_fetch(monkeypatch):
    class Resp:
        content = b"fake-mp4-bytes"

        def raise_for_status(self):
            return None

    monkeypatch.setattr(colorize_mod.requests, "get", lambda *a, **k: Resp())


def _fake_extract(src: Path, frames_dir: Path, fps: int) -> list[Path]:
    frames_dir.mkdir(parents=True, exist_ok=True)
    p = frames_dir / "frame-000001.png"
    p.write_bytes(b"raw")
    return [p]


def _fake_assemble(src: Path, colorized_frames_dir: Path, dst: Path, fps: int) -> Path:
    dst.write_bytes(b"\0" * (32 * 1024))
    return dst


def _annotate(manifest, work_dir, **kw):
    return colorize_mod.annotate(
        manifest,
        work_dir,
        colorize_fn=_fake_colorize,
        extract_fn=_fake_extract,
        assemble_fn=_fake_assemble,
        **kw,
    )


def test_annotate_bakes_videos_only(tmp_path: Path, monkeypatch):
    _fake_fetch(monkeypatch)
    out, derivs = _annotate(_manifest(), tmp_path)
    assert set(derivs) == {"vid-0000", "vid-0001"}
    assert all(p.exists() and p.name == f"color-{aid}.mp4" for aid, p in derivs.items())
    # colorSrc is NOT set by annotate (that happens post-upload via apply_urls)
    by_id = {a["id"]: a for a in out["assets"]}
    assert "colorSrc" not in by_id["vid-0000"]
    assert out["version"] != "2026.07.01-0000"


def test_annotate_only_missing_skips_already_baked(tmp_path: Path, monkeypatch):
    _fake_fetch(monkeypatch)
    _, derivs = _annotate(_manifest(), tmp_path, only_missing=True)
    assert set(derivs) == {"vid-0000"}


def test_annotate_limit(tmp_path: Path, monkeypatch):
    _fake_fetch(monkeypatch)
    _, derivs = _annotate(_manifest(), tmp_path, limit=1)
    assert set(derivs) == {"vid-0000"}


def test_annotate_skips_failed_colorizations(tmp_path: Path, monkeypatch):
    _fake_fetch(monkeypatch)
    _, derivs = colorize_mod.annotate(
        _manifest(),
        tmp_path,
        colorize_fn=lambda i, o, render_factor=21: False,
        extract_fn=_fake_extract,
        assemble_fn=_fake_assemble,
    )
    assert derivs == {}


def test_annotate_no_model_bakes_nothing(tmp_path: Path, monkeypatch):
    _fake_fetch(monkeypatch)
    # colorize_fn=None + no DeOldify available → empty derivs, no crash
    monkeypatch.setattr(colorize_mod, "_make_colorizer", lambda: (None, False))
    out, derivs = colorize_mod.annotate(_manifest(), tmp_path, colorize_fn=None)
    assert derivs == {}
    assert out["assets"]  # manifest returned intact


def test_apply_urls_sets_color_src():
    m = _manifest()
    n = colorize_mod.apply_urls(m, {"vid-0000": "https://cdn.test/media/color-vid-0000.mp4"})
    assert n == 1
    by_id = {a["id"]: a for a in m["assets"]}
    assert by_id["vid-0000"]["colorSrc"] == "https://cdn.test/media/color-vid-0000.mp4"
    assert "colorSrc" not in by_id["img-0000"]
