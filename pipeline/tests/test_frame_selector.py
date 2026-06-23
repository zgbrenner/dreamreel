"""Content-aware frame pick: choose the interior frame least like a title card / logo."""
from __future__ import annotations
from pathlib import Path
import numpy as np
from embed import frame_selector as fs

class FakeEmbedder:
    backend = "open_clip"
    dim = 4
    def embed_texts(self, texts):
        # "avoid" concept points along axis 0
        return np.tile(np.array([1.0, 0, 0, 0]), (len(texts), 1))
    def embed_images(self, paths):
        # frame i's similarity to axis 0 decreases with i; the LAST frame is least title-card-like
        rows = []
        for i, _ in enumerate(paths):
            v = np.array([1.0 - i * 0.2, i * 0.1, 0, 0])
            rows.append(v / np.linalg.norm(v))
        return np.array(rows)

def test_build_avoid_vector_is_unit(monkeypatch):
    v = fs.build_avoid_vector(FakeEmbedder())
    assert abs(float(np.linalg.norm(v)) - 1.0) < 1e-6

def test_select_best_frame_picks_least_titlecard(tmp_path, monkeypatch):
    # extract_poster writes a stub jpg per requested second and returns its path
    def fake_extract(video, dst_dir, at_seconds=1.0):
        dst_dir.mkdir(parents=True, exist_ok=True)
        p = dst_dir / f"f_{int(round(at_seconds))}.jpg"
        p.write_bytes(b"jpeg")
        return p
    monkeypatch.setattr(fs, "extract_poster", fake_extract)
    emb = FakeEmbedder()
    avoid = fs.build_avoid_vector(emb)
    video = tmp_path / "film.mp4"; video.write_bytes(b"v")
    poster, ts = fs.select_best_frame(video, tmp_path / "posters", emb, avoid, duration=1000.0,
                                      fractions=(0.2, 0.5, 0.8))
    assert poster is not None and poster.exists()
    # last fraction (0.8 -> 800s) is least like the avoid concept
    assert ts == 800.0

def test_select_best_frame_falls_back_for_hash_backend(tmp_path, monkeypatch):
    class Hash(FakeEmbedder): backend = "hash-fallback"
    called = {}
    def fake_extract(video, dst_dir, at_seconds=1.0):
        called["at"] = at_seconds
        p = dst_dir / "p.jpg"; dst_dir.mkdir(parents=True, exist_ok=True); p.write_bytes(b"j"); return p
    monkeypatch.setattr(fs, "extract_poster", fake_extract)
    video = tmp_path / "f.mp4"; video.write_bytes(b"v")
    poster, ts = fs.select_best_frame(video, tmp_path/"o", Hash(), np.array([1.0,0,0,0]), duration=1000.0)
    assert poster is not None
    assert ts == 300.0  # 30% single-frame fallback, no scoring
