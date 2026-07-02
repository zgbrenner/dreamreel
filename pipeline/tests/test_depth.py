"""embed/depth.py: depth-map baking (pure encoding math + manifest augmentation, model faked)."""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import pytest

from embed import depth as depth_mod

PIL = pytest.importorskip("PIL")
from PIL import Image  # noqa: E402


def _fake_image_bytes(w: int = 64, h: int = 48) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (120, 90, 60)).save(buf, "PNG")
    return buf.getvalue()


def _manifest() -> dict:
    return {
        "version": "2026.07.01-0000",
        "assets": [
            {"id": "img-0000", "type": "image", "src": "https://cdn.test/media/a.webp"},
            {"id": "img-0001", "type": "image", "src": "https://cdn.test/media/b.webp", "depthSrc": "https://cdn.test/media/depth-img-0001.png"},
            {"id": "vid-0000", "type": "video", "src": "https://cdn.test/media/v.mp4"},
            {"id": "proc-fog", "type": "procedural"},
        ],
    }


# --- pure encoding math ----------------------------------------------------------------------


def test_depth_to_gray_normalizes_full_range():
    d = np.array([[0.0, 5.0], [10.0, 2.5]])
    g = depth_mod.depth_to_gray(d)
    assert g.dtype == np.uint8
    assert g[0, 0] == 0 and g[1, 0] == 255
    assert 0 < g[1, 1] < 255


def test_depth_to_gray_flat_input_is_black_not_nan():
    g = depth_mod.depth_to_gray(np.full((4, 4), 3.0))
    assert g.max() == 0


def test_save_depth_png_downscales_grayscale(tmp_path: Path):
    d = np.linspace(0, 1, 64 * 48).reshape(48, 64)
    out = depth_mod.save_depth_png(d, tmp_path / "d.png", downscale=4)
    with Image.open(out) as im:
        assert im.mode == "L"
        assert im.size == (16, 12)


# --- manifest augmentation (model + network faked) --------------------------------------------


def _fake_fetch(monkeypatch):
    class Resp:
        content = _fake_image_bytes()

        def raise_for_status(self):
            return None

    monkeypatch.setattr(depth_mod.requests, "get", lambda *a, **k: Resp())


def _fake_depth_fn(path: Path):
    return np.linspace(0, 1, 32 * 24).reshape(24, 32)


def test_annotate_bakes_pngs_for_images_only_when_video_excluded(tmp_path: Path, monkeypatch):
    _fake_fetch(monkeypatch)
    out, derivs = depth_mod.annotate(
        _manifest(), tmp_path, depth_fn=_fake_depth_fn, include_video=False
    )
    assert set(derivs) == {"img-0000", "img-0001"}
    assert all(p.exists() for p in derivs.values())
    # depthSrc is NOT set by annotate (that happens post-upload via apply_urls)
    by_id = {a["id"]: a for a in out["assets"]}
    assert "depthSrc" not in by_id["img-0000"]
    assert out["version"] != "2026.07.01-0000"


def test_annotate_bakes_video_depth_from_midframe(tmp_path: Path, monkeypatch):
    _fake_fetch(monkeypatch)
    grabbed: list[str] = []

    def fake_midframe(_local: Path, dest_dir: Path, asset_id: str) -> Path:
        grabbed.append(asset_id)
        p = dest_dir / f"{asset_id}-midframe.png"
        p.write_bytes(_fake_image_bytes())
        return p

    _, derivs = depth_mod.annotate(
        _manifest(), tmp_path, depth_fn=_fake_depth_fn, midframe_fn=fake_midframe
    )
    assert set(derivs) == {"img-0000", "img-0001", "vid-0000"}
    assert grabbed == ["vid-0000"]  # midframe extraction runs for videos only


def test_annotate_video_midframe_failure_skips_gracefully(tmp_path: Path, monkeypatch):
    _fake_fetch(monkeypatch)
    _, derivs = depth_mod.annotate(
        _manifest(), tmp_path, depth_fn=_fake_depth_fn, midframe_fn=lambda *_: None
    )
    assert set(derivs) == {"img-0000", "img-0001"}  # video skipped, stills unaffected


def test_annotate_only_missing_skips_already_baked(tmp_path: Path, monkeypatch):
    _fake_fetch(monkeypatch)
    _, derivs = depth_mod.annotate(
        _manifest(), tmp_path, only_missing=True, depth_fn=_fake_depth_fn, include_video=False
    )
    assert set(derivs) == {"img-0000"}


def test_annotate_limit(tmp_path: Path, monkeypatch):
    _fake_fetch(monkeypatch)
    _, derivs = depth_mod.annotate(
        _manifest(), tmp_path, limit=1, depth_fn=_fake_depth_fn, include_video=False
    )
    assert len(derivs) == 1


def test_apply_urls_sets_depth_src():
    m = _manifest()
    n = depth_mod.apply_urls(m, {"img-0000": "https://cdn.test/media/depth-img-0000.png"})
    assert n == 1
    by_id = {a["id"]: a for a in m["assets"]}
    assert by_id["img-0000"]["depthSrc"] == "https://cdn.test/media/depth-img-0000.png"
    assert "depthSrc" not in by_id["vid-0000"]
