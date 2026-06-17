"""Publish step: derivative build + R2 upload wiring.

Proves the gap closed in publish/run.py: image derivatives are built from the locally
downloaded media, each surviving asset.id is correlated back to its local file, that map is
handed to upload_media(), and publish_manifest() rewrites asset.src to the R2 CDN URLs.

boto3 is an optional extra and may be absent; we never touch it — _client() is monkeypatched
to a MagicMock so the upload path runs fully offline.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

from publish import run as publish_run
from publish import upload_r2


def _make_jpeg(path: Path, color: tuple[int, int, int]) -> None:
    from PIL import Image

    Image.new("RGB", (300, 220), color).save(path, "JPEG")


def _write_fetched(out_dir: Path, n: int) -> Path:
    """Mimic the download step: real jpgs in out/images + a fetched.jsonl row per image."""
    img_dir = out_dir / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for i in range(n):
        p = img_dir / f"{i:016x}.jpg"
        _make_jpeg(p, (40 + i * 30, 30, 60))
        rows.append(
            {"candidate": {"source_url": f"https://media.example/{i}.jpg"}, "local_path": str(p)}
        )
    fpath = out_dir / "fetched.jsonl"
    with fpath.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    return fpath


# --- correlation: asset.id -> local file --------------------------------------------------


def test_local_paths_by_asset_id_indexes_like_build_manifest(tmp_path: Path):
    fetched = _write_fetched(tmp_path, 3)
    mapping = publish_run.local_paths_by_asset_id(fetched)

    assert set(mapping) == {"img-0000", "img-0001", "img-0002"}
    assert all(p.exists() for p in mapping.values())
    # img-0000 is the first fetched row (must match build_manifest's enumerate order)
    first_local = json.loads(fetched.read_text().splitlines()[0])["local_path"]
    assert str(mapping["img-0000"]) == first_local


def test_local_paths_by_asset_id_missing_file_is_empty(tmp_path: Path):
    assert publish_run.local_paths_by_asset_id(tmp_path / "nope.jsonl") == {}


# --- derivative build ----------------------------------------------------------------------


def test_build_derivatives_builds_webp_for_kept_images_only(tmp_path: Path):
    fetched = _write_fetched(tmp_path, 3)
    # QC dropped img-0001; survivors keep their sparse ids. Procedural assets have no derivative.
    kept = [
        {"id": "img-0000", "type": "image"},
        {"id": "img-0002", "type": "image"},
        {"id": "proc-fog", "type": "procedural"},
    ]
    deriv = publish_run.build_derivatives(kept, fetched, tmp_path / "derivatives")

    assert set(deriv) == {"img-0000", "img-0002"}
    for p in deriv.values():
        assert p.suffix == ".webp"
        assert p.exists() and p.stat().st_size > 0


def test_build_derivatives_empty_when_no_images(tmp_path: Path):
    fetched = _write_fetched(tmp_path, 0)
    kept = [{"id": "proc-fog", "type": "procedural"}]
    assert publish_run.build_derivatives(kept, fetched, tmp_path / "derivatives") == {}


# --- upload + manifest rewrite -------------------------------------------------------------


def test_upload_media_calls_client_and_publish_rewrites_src(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("R2_BUCKET", "dreamreel-media")
    monkeypatch.setenv("R2_PUBLIC_BASE", "https://cdn.dreamreel.test/")
    fake_client = MagicMock()
    monkeypatch.setattr(upload_r2, "_client", lambda: fake_client)

    (tmp_path / "a.webp").write_bytes(b"x")
    (tmp_path / "b.webp").write_bytes(b"y")
    derivatives = {"img-0000": tmp_path / "a.webp", "img-0002": tmp_path / "b.webp"}

    urls = upload_r2.upload_media(derivatives)
    assert fake_client.upload_file.call_count == 2
    assert urls["img-0000"] == "https://cdn.dreamreel.test/media/a.webp"

    manifest = {
        "version": "2026.06.17-1200",
        "assets": [
            {"id": "img-0000", "src": "https://media.example/0.jpg"},
            {"id": "img-0002", "src": "https://media.example/2.jpg"},
            {"id": "proc-fog"},  # untouched: not in the url map
        ],
    }
    out = upload_r2.publish_manifest(manifest, urls)

    assert manifest["assets"][0]["src"] == "https://cdn.dreamreel.test/media/a.webp"
    assert manifest["assets"][1]["src"] == "https://cdn.dreamreel.test/media/b.webp"
    assert "src" not in manifest["assets"][2]
    keys = [c.kwargs["Key"] for c in fake_client.put_object.call_args_list]
    assert "manifest/latest.json" in keys
    assert "manifest/manifest.2026.06.17-1200.json" in keys
    assert out["latest"].endswith("/manifest/latest.json")


# --- end-to-end: run.main --upload ---------------------------------------------------------


def _published_body(fake_client: MagicMock, key: str):
    for c in fake_client.put_object.call_args_list:
        if c.kwargs.get("Key") == key:
            return json.loads(c.kwargs["Body"].decode("utf-8"))
    return None


def test_main_upload_builds_derivatives_and_rewrites_src(tmp_path: Path, monkeypatch):
    out = tmp_path / "out"
    out.mkdir()
    fetched = _write_fetched(out, 2)
    assert fetched.exists()

    manifest = {
        "version": "2026.06.17-0900",
        "assets": [
            {"id": "img-0000", "type": "image", "src": "https://media.example/0.jpg",
             "license": "CC0", "source": "Openverse / Flickr Commons"},
            {"id": "img-0001", "type": "image", "src": "https://media.example/1.jpg",
             "license": "CC0", "source": "Openverse / Flickr Commons"},
            {"id": "proc-fog", "type": "procedural", "license": "CC0",
             "source": "DREAMREEL / procedural"},
        ],
    }
    (out / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(k, "test")
    monkeypatch.setenv("R2_BUCKET", "dreamreel-media")
    monkeypatch.setenv("R2_PUBLIC_BASE", "https://cdn.dreamreel.test")
    fake_client = MagicMock()
    monkeypatch.setattr(upload_r2, "_client", lambda: fake_client)
    monkeypatch.setattr("sys.argv", ["publish.run", "--out", str(out), "--upload"])

    publish_run.main()

    # two image derivatives uploaded
    assert fake_client.upload_file.call_count == 2
    # the published latest.json has image src rewritten to R2, procedural left alone
    body = _published_body(fake_client, "manifest/latest.json")
    assert body is not None
    by_id = {a["id"]: a for a in body["assets"]}
    assert by_id["img-0000"]["src"].startswith("https://cdn.dreamreel.test/media/")
    assert by_id["img-0001"]["src"].startswith("https://cdn.dreamreel.test/media/")
    assert "src" not in by_id["proc-fog"]
