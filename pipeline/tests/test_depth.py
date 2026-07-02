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


def test_annotate_bakes_pngs_for_images_only(tmp_path: Path, monkeypatch):
    _fake_fetch(monkeypatch)
    out, derivs = depth_mod.annotate(_manifest(), tmp_path, depth_fn=_fake_depth_fn)
    assert set(derivs) == {"img-0000", "img-0001"}
    assert all(p.exists() for p in derivs.values())
    # depthSrc is NOT set by annotate (that happens post-upload via apply_urls)
    by_id = {a["id"]: a for a in out["assets"]}
    assert "depthSrc" not in by_id["img-0000"]
    assert out["version"] != "2026.07.01-0000"


def test_annotate_only_missing_skips_already_baked(tmp_path: Path, monkeypatch):
    _fake_fetch(monkeypatch)
    _, derivs = depth_mod.annotate(_manifest(), tmp_path, only_missing=True, depth_fn=_fake_depth_fn)
    assert set(derivs) == {"img-0000"}


def test_annotate_limit(tmp_path: Path, monkeypatch):
    _fake_fetch(monkeypatch)
    _, derivs = depth_mod.annotate(_manifest(), tmp_path, limit=1, depth_fn=_fake_depth_fn)
    assert len(derivs) == 1


def test_apply_urls_sets_depth_src():
    m = _manifest()
    n = depth_mod.apply_urls(m, {"img-0000": "https://cdn.test/media/depth-img-0000.png"})
    assert n == 1
    by_id = {a["id"]: a for a in m["assets"]}
    assert by_id["img-0000"]["depthSrc"] == "https://cdn.test/media/depth-img-0000.png"
    assert "depthSrc" not in by_id["vid-0000"]
