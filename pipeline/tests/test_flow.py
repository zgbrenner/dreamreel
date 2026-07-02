"""embed/flow.py: optical-flow baking (pure signature/encoding math + manifest augmentation,
model/ffmpeg/ffprobe faked — no torch, no network)."""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pytest

from embed import flow as flow_mod

PIL = pytest.importorskip("PIL")
from PIL import Image  # noqa: E402

# A (H=24, W=32) frame has diagonal hypot(32, 24) == 40.0 exactly — friendly test numbers.
H, W = 24, 32
DIAG = 40.0


def _uniform_flow(dx: float, dy: float, h: int = H, w: int = W) -> np.ndarray:
    f = np.zeros((h, w, 2), dtype=np.float64)
    f[..., 0] = dx
    f[..., 1] = dy
    return f


# --- flow_signature ----------------------------------------------------------------------------


def test_signature_uniform_rightward_flow_fills_bin_zero():
    sig = flow_mod.flow_signature(_uniform_flow(3.0, 0.0))
    assert len(sig) == 9
    assert sig[0] == pytest.approx(1.0)
    assert all(b == pytest.approx(0.0) for b in sig[1:8])
    assert sig[8] == pytest.approx(3.0 / DIAG)


def test_signature_zero_flow_is_uniform_bins_not_nan():
    sig = flow_mod.flow_signature(_uniform_flow(0.0, 0.0))
    assert sig[:8] == pytest.approx([1.0 / 8.0] * 8)
    assert sig[8] == 0.0


def test_signature_direction_binning():
    # Bin k is centered at angle k*pi/4 of arctan2(dy, dx).
    assert flow_mod.flow_signature(_uniform_flow(1.0, 1.0))[1] == pytest.approx(1.0)  # pi/4
    assert flow_mod.flow_signature(_uniform_flow(0.0, 1.0))[2] == pytest.approx(1.0)  # pi/2
    assert flow_mod.flow_signature(_uniform_flow(-1.0, 0.0))[4] == pytest.approx(1.0)  # pi
    assert flow_mod.flow_signature(_uniform_flow(-1.0, -1.0))[5] == pytest.approx(1.0)  # -3pi/4


def test_signature_is_magnitude_weighted_and_normalized():
    f = _uniform_flow(0.0, 0.0)
    f[:, : W // 2, 0] = 3.0  # left half: rightward, magnitude 3
    f[:, W // 2 :, 1] = 1.0  # right half: dy-positive, magnitude 1
    sig = flow_mod.flow_signature(f)
    assert sig[0] == pytest.approx(0.75)
    assert sig[2] == pytest.approx(0.25)
    assert sum(sig[:8]) == pytest.approx(1.0)
    assert sig[8] == pytest.approx(2.0 / DIAG)  # mean magnitude / diagonal


def test_signature_is_deterministic():
    rng = np.random.default_rng(7)
    f = rng.normal(size=(H, W, 2))
    assert flow_mod.flow_signature(f) == flow_mod.flow_signature(f.copy())


# --- motion_energy -----------------------------------------------------------------------------


def test_motion_energy_normalizes_by_diagonal():
    assert flow_mod.motion_energy(_uniform_flow(4.0, 0.0)) == pytest.approx(4.0 / DIAG)
    assert flow_mod.motion_energy(_uniform_flow(0.0, 0.0)) == 0.0


def test_motion_energy_clamped_to_one():
    assert flow_mod.motion_energy(_uniform_flow(9999.0, 0.0)) == 1.0


# --- flow_to_png -------------------------------------------------------------------------------


def test_flow_to_png_mode_size_and_blue_channel(tmp_path: Path):
    out = flow_mod.flow_to_png(_uniform_flow(1.0, -2.0), tmp_path / "f.png", downscale=8)
    with Image.open(out) as im:
        assert im.mode == "RGB"
        assert im.size == (W // 8, H // 8)
        b = np.asarray(im)[..., 2]
    assert b.max() == 0


def test_flow_to_png_round_trips_uniform_flow_within_quantization(tmp_path: Path):
    dx, dy = 1.0, -2.0
    out = flow_mod.flow_to_png(_uniform_flow(dx, dy), tmp_path / "f.png")
    scale = 0.1 * DIAG  # docstring encoding: value = clamp(comp/(0.1*diag)*0.5 + 0.5, 0, 1)
    with Image.open(out) as im:
        px = np.asarray(im, dtype=np.float64)
    dec_dx = (px[..., 0] / 255.0 - 0.5) * 2.0 * scale
    dec_dy = (px[..., 1] / 255.0 - 0.5) * 2.0 * scale
    quantum = 2.0 * scale / 255.0
    assert np.all(np.abs(dec_dx - dx) <= quantum + 1e-9)
    assert np.all(np.abs(dec_dy - dy) <= quantum + 1e-9)


def test_flow_to_png_clamps_out_of_range_flow(tmp_path: Path):
    out = flow_mod.flow_to_png(_uniform_flow(1000.0, -1000.0), tmp_path / "f.png")
    with Image.open(out) as im:
        px = np.asarray(im)
    assert np.all(px[..., 0] == 255)
    assert np.all(px[..., 1] == 0)


# --- sample_times ------------------------------------------------------------------------------


def test_sample_times_from_probed_duration():
    assert flow_mod.sample_times(12.0) == pytest.approx((0.5, 0.9, 10.8, 11.2))


def test_sample_times_fallback_when_probe_fails():
    assert flow_mod.sample_times(None) == pytest.approx((0.5, 0.9, 8.0, 8.4))
    assert flow_mod.sample_times(-3.0) == pytest.approx((0.5, 0.9, 8.0, 8.4))
    assert flow_mod.sample_times(math.nan) == pytest.approx((0.5, 0.9, 8.0, 8.4))


def test_sample_times_clamped_for_tiny_clips():
    in_a, in_b, out_a, out_b = flow_mod.sample_times(1.0)
    assert (in_a, in_b) == (0.5, 0.9)
    assert out_a >= 0.0
    assert out_b > out_a


# --- annotate (model + ffmpeg + network faked) --------------------------------------------------


def _manifest() -> dict:
    return {
        "version": "2026.07.01-0000",
        "assets": [
            {"id": "vid-0000", "type": "video", "src": "https://cdn.test/media/v0.mp4"},
            {
                "id": "vid-0001",
                "type": "video",
                "src": "https://cdn.test/media/v1.mp4",
                "motion": {"energy": 0.1, "inSig": [0.0] * 9, "outSig": [0.0] * 9},
            },
            {"id": "img-0000", "type": "image", "src": "https://cdn.test/media/a.webp"},
            {"id": "proc-fog", "type": "procedural"},
        ],
    }


def _fake_fetch(monkeypatch):
    class Resp:
        content = b"\x00\x00fake-mp4-bytes"

        def raise_for_status(self):
            return None

    monkeypatch.setattr(flow_mod.requests, "get", lambda *a, **k: Resp())


def _frame() -> np.ndarray:
    return np.full((H, W, 3), 100, dtype=np.uint8)


def _fake_extract(path: Path, times: list[float]):
    return [_frame() for _ in times]


def _fake_flow(a: np.ndarray, b: np.ndarray):
    return _uniform_flow(2.0, 0.0)  # rightward, energy 2/40 = 0.05


def test_annotate_sets_motion_and_bakes_pngs_for_videos_only(tmp_path: Path, monkeypatch):
    _fake_fetch(monkeypatch)
    out, derivs = flow_mod.annotate(
        _manifest(), tmp_path, flow_fn=_fake_flow, extract_fn=_fake_extract, probe_fn=lambda p: 12.0
    )
    assert set(derivs) == {"vid-0000", "vid-0001"}
    assert all(p.exists() for p in derivs.values())
    assert derivs["vid-0000"].name == "flow-vid-0000.png"

    by_id = {a["id"]: a for a in out["assets"]}
    motion = by_id["vid-0000"]["motion"]
    assert set(motion) == {"energy", "inSig", "outSig"}
    assert motion["energy"] == pytest.approx(0.05)
    assert len(motion["inSig"]) == 9 and len(motion["outSig"]) == 9
    assert motion["inSig"][0] == pytest.approx(1.0)
    assert sum(motion["inSig"][:8]) == pytest.approx(1.0)
    # flowSrc is NOT set by annotate (that happens post-upload via apply_urls)
    assert "flowSrc" not in by_id["vid-0000"]
    assert "motion" not in by_id["img-0000"]
    assert "motion" not in by_id["proc-fog"]
    assert out["version"] != "2026.07.01-0000"


def test_annotate_samples_head_and_tail_pairs(tmp_path: Path, monkeypatch):
    _fake_fetch(monkeypatch)
    seen: list[list[float]] = []

    def recording_extract(path: Path, times: list[float]):
        seen.append(list(times))
        return _fake_extract(path, times)

    flow_mod.annotate(
        _manifest(), tmp_path, limit=1,
        flow_fn=_fake_flow, extract_fn=recording_extract, probe_fn=lambda p: 12.0,
    )
    assert seen == [pytest.approx([0.5, 0.9, 10.8, 11.2])]

    seen.clear()
    flow_mod.annotate(
        _manifest(), tmp_path, limit=1,
        flow_fn=_fake_flow, extract_fn=recording_extract, probe_fn=lambda p: None,
    )
    assert seen == [pytest.approx([0.5, 0.9, 8.0, 8.4])]


def test_annotate_only_missing_skips_already_annotated(tmp_path: Path, monkeypatch):
    _fake_fetch(monkeypatch)
    _, derivs = flow_mod.annotate(
        _manifest(), tmp_path, only_missing=True,
        flow_fn=_fake_flow, extract_fn=_fake_extract, probe_fn=lambda p: 12.0,
    )
    assert set(derivs) == {"vid-0000"}


def test_annotate_limit(tmp_path: Path, monkeypatch):
    _fake_fetch(monkeypatch)
    _, derivs = flow_mod.annotate(
        _manifest(), tmp_path, limit=1,
        flow_fn=_fake_flow, extract_fn=_fake_extract, probe_fn=lambda p: 12.0,
    )
    assert len(derivs) == 1


def test_annotate_skips_asset_when_frames_missing(tmp_path: Path, monkeypatch):
    _fake_fetch(monkeypatch)
    out, derivs = flow_mod.annotate(
        _manifest(), tmp_path, limit=1,
        flow_fn=_fake_flow, extract_fn=lambda p, t: [None] * len(t), probe_fn=lambda p: 12.0,
    )
    assert derivs == {}
    by_id = {a["id"]: a for a in out["assets"]}
    assert "motion" not in by_id["vid-0000"]


def test_annotate_skips_asset_when_flow_fails(tmp_path: Path, monkeypatch):
    _fake_fetch(monkeypatch)
    out, derivs = flow_mod.annotate(
        _manifest(), tmp_path, limit=1,
        flow_fn=lambda a, b: None, extract_fn=_fake_extract, probe_fn=lambda p: 12.0,
    )
    assert derivs == {}
    assert "motion" not in {a["id"]: a for a in out["assets"]}["vid-0000"]


def test_annotate_without_model_is_a_noop(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(flow_mod, "_make_flow_model", lambda: (None, False))
    out, derivs = flow_mod.annotate(_manifest(), tmp_path)
    assert derivs == {}
    assert {a["id"] for a in out["assets"]} == {"vid-0000", "vid-0001", "img-0000", "proc-fog"}


# --- apply_urls --------------------------------------------------------------------------------


def test_apply_urls_sets_flow_src():
    m = _manifest()
    n = flow_mod.apply_urls(m, {"vid-0000": "https://cdn.test/media/flow-vid-0000.png"})
    assert n == 1
    by_id = {a["id"]: a for a in m["assets"]}
    assert by_id["vid-0000"]["flowSrc"] == "https://cdn.test/media/flow-vid-0000.png"
    assert "flowSrc" not in by_id["vid-0001"]
    assert "flowSrc" not in by_id["img-0000"]
