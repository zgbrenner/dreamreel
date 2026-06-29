"""Tests for embed.entities.clean_tags — pure RAM-output normalization (no torch)."""

from __future__ import annotations

from embed.entities import clean_tags


def test_splits_lowercases_strips():
    assert clean_tags("Clock | Tower | SKY") == ["clock", "tower", "sky"]


def test_drops_stopwords_and_dedupes():
    assert clean_tags("photo | clock | image | clock | art") == ["clock"]


def test_accepts_list_input():
    assert clean_tags(["Bird", " bird ", "Nest"]) == ["bird", "nest"]


def test_caps_tag_count():
    raw = " | ".join(f"thing{i}" for i in range(30))
    assert len(clean_tags(raw, max_tags=12)) == 12


def test_empty():
    assert clean_tags("") == []
    assert clean_tags(" |  | ") == []


def test_only_missing_leaves_existing_entities_untouched(monkeypatch, tmp_path):
    # Stub RAM++ + frame/image fetch so we exercise just annotate()'s selection (annotate does a
    # local `from PIL import Image`, so feed it a real openable PNG rather than mocking PIL).
    from embed import entities
    from PIL import Image as PILImage

    frame = tmp_path / "f.png"
    PILImage.new("RGB", (8, 8)).save(frame)

    class _Tensor:
        def unsqueeze(self, _n):
            return self

    monkeypatch.setattr(entities, "_make_ram", lambda *a, **k: ("model", lambda _im: _Tensor(), lambda _t, _m: ["dog | tree"]))
    monkeypatch.setattr(entities, "_video_frame", lambda _a, _d: frame)
    monkeypatch.setattr(entities, "_ensure_image", lambda _s, _d, _i: frame)

    manifest = {
        "assets": [
            {"id": "img-has", "type": "image", "src": "u", "entities": ["clock", "moon"]},
            {"id": "vid-gap", "type": "video", "src": "v"},
            {"id": "proc-fog", "type": "procedural"},  # never eligible (not image|video / no src)
        ]
    }
    out, n = entities.annotate(manifest, tmp_path, only_missing=True)
    assert n == 1
    by_id = {a["id"]: a for a in out["assets"]}
    assert by_id["img-has"]["entities"] == ["clock", "moon"]  # untouched
    assert by_id["vid-gap"]["entities"] == ["dog", "tree"]     # newly tagged
    assert "entities" not in by_id["proc-fog"]                 # procedural skipped
