"""repair_srcs: restore mirrored R2 srcs clobbered by the Round 5 hotlink regression, and the
publish-time hotlink guard that keeps the regression from shipping again."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from publish import upload_r2
from publish.repair_srcs import repair_srcs

BASE = "https://cdn.dreamreel.test"


def _live_manifest() -> dict:
    return {
        "version": "2026.06.29-2332",
        "assets": [
            # hotlinked video with stale full-film shots -> restored, shots dropped
            {
                "id": "vid-0000",
                "type": "video",
                "src": "https://archive.org/download/x/x.mp4",
                "shots": [{"start": 20.0, "end": 28.0}, {"start": 170.0, "end": 180.0}],
            },
            # hotlinked image -> restored
            {"id": "img-0000", "type": "image", "src": "https://images.metmuseum.org/a.jpg"},
            # already mirrored -> untouched
            {"id": "img-0001", "type": "image", "src": f"{BASE}/media/b.webp"},
            # hotlinked but unknown to the reference -> reported unrepairable
            {"id": "img-9999", "type": "image", "src": "https://images.metmuseum.org/z.jpg"},
            # procedural: no src -> ignored
            {"id": "proc-fog", "type": "procedural", "kind": "fog"},
        ],
        "audio": [{"id": "aud-0", "src": f"{BASE}/media/a.m4a"}],
    }


def _reference_manifest() -> dict:
    return {
        "assets": [
            {"id": "vid-0000", "type": "video", "src": f"{BASE}/media/f125.mp4"},
            {"id": "img-0000", "type": "image", "src": f"{BASE}/media/c0ff.webp"},
            {"id": "img-0001", "type": "image", "src": f"{BASE}/media/b.webp"},
            # reference rows that are themselves hotlinked must never be used as a repair source
            {"id": "img-9999", "type": "image", "src": "https://images.metmuseum.org/z.jpg"},
        ]
    }


def test_repair_restores_r2_srcs_and_drops_stale_shots():
    repaired, stats = repair_srcs(_live_manifest(), _reference_manifest(), BASE)

    by_id = {a["id"]: a for a in repaired["assets"]}
    assert by_id["vid-0000"]["src"] == f"{BASE}/media/f125.mp4"
    assert "shots" not in by_id["vid-0000"]  # full-film offsets are invalid for the short clip
    assert by_id["img-0000"]["src"] == f"{BASE}/media/c0ff.webp"
    assert by_id["img-0001"]["src"] == f"{BASE}/media/b.webp"
    assert by_id["img-9999"]["src"] == "https://images.metmuseum.org/z.jpg"

    assert stats["repaired"] == 2
    assert stats["shots_dropped"] == 1
    assert stats["already_mirrored"] == 1
    assert stats["unrepairable"] == ["img-9999"]


def test_repair_is_a_copy_and_bumps_version():
    live = _live_manifest()
    repaired, _ = repair_srcs(live, _reference_manifest(), BASE)
    assert live["assets"][0]["src"] == "https://archive.org/download/x/x.mp4"  # input untouched
    assert repaired["version"] != live["version"]


# --- publish-time hotlink guard -------------------------------------------------------------


def _publish_env(monkeypatch) -> MagicMock:
    monkeypatch.setenv("R2_BUCKET", "dreamreel-media")
    monkeypatch.setenv("R2_PUBLIC_BASE", BASE)
    fake_client = MagicMock()
    monkeypatch.setattr(upload_r2, "_client", lambda: fake_client)
    return fake_client


def test_publish_manifest_refuses_hotlinked_media(monkeypatch):
    _publish_env(monkeypatch)
    manifest = {
        "version": "2026.07.01-0000",
        "assets": [{"id": "vid-0000", "type": "video", "src": "https://archive.org/download/x/x.mp4"}],
    }
    with pytest.raises(ValueError, match="hotlink"):
        upload_r2.publish_manifest(manifest, {})


def test_publish_manifest_hotlink_override(monkeypatch):
    fake_client = _publish_env(monkeypatch)
    monkeypatch.setenv("R2_ALLOW_HOTLINKS", "1")
    manifest = {
        "version": "2026.07.01-0000",
        "assets": [{"id": "vid-0000", "type": "video", "src": "https://archive.org/download/x/x.mp4"}],
    }
    upload_r2.publish_manifest(manifest, {})
    assert fake_client.put_object.call_count == 2  # versioned + latest


def test_publish_manifest_accepts_fully_mirrored(monkeypatch):
    fake_client = _publish_env(monkeypatch)
    manifest = {
        "version": "2026.07.01-0000",
        "assets": [
            {"id": "img-0000", "type": "image", "src": f"{BASE}/media/a.webp"},
            {"id": "proc-fog", "type": "procedural"},
        ],
        "audio": [{"id": "aud-0", "src": f"{BASE}/media/a.m4a"}],
        "entitySprites": [{"id": "spr-0", "src": f"{BASE}/media/s.png"}],
    }
    upload_r2.publish_manifest(manifest, {})
    assert fake_client.put_object.call_count == 2
