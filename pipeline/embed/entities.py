"""Tag each visual asset with the concrete ENTITIES it contains (RAM++ open-set recognition,
Apache-2.0 code + weights) and bake them as `entities[]`. This is DREAMREEL's MEMORY index: at
runtime the dream keeps a decaying memory of surfaced entities and leans toward assets that echo
them, so motifs RECUR across a dream (dream/memory.ts). This is NOT "better tags" for selection —
it is the substrate for dream recurrence.

RAM++ (xinyu1205/recognize-anything-plus-model) recognizes common, uncommon, AND open-set
categories, so it captures the rich, surreal vocabulary the dream needs (clock, staircase, bird,
hands, moon, mirror, ...). Images are tagged directly; video assets from an ffmpeg-extracted frame
(the first baked shot, or ~30s in). Procedural/title-card assets are skipped.

The tag-cleaning (`clean_tags`) is pure and unit-tested; tagging lazy-imports the `ram` package +
torch (the `entities` extra) and downloads the Apache-2.0 checkpoint once. Manifest-only reship.

Usage (from pipeline/, needs the `entities` extra + ffmpeg):
    python -m embed.entities --out out --limit 5
    python -m embed.entities --manifest out/manifest.json --out out --upload
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit

import requests

DEFAULT_MANIFEST_URL = (
    "https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json"
)
RAM_REPO = "xinyu1205/recognize-anything-plus-model"
RAM_CKPT = "ram_plus_swin_large_14m.pth"
IMAGE_SIZE = 384

# Uninformative meta-tags RAM may emit that carry no dream meaning — dropped from the entity set.
_STOP = {
    "image", "photo", "photograph", "picture", "illustration", "screenshot", "wallpaper",
    "collage", "graphic", "art", "blur", "background",
}
MAX_TAGS = 12


def clean_tags(raw: str | list[str], max_tags: int = MAX_TAGS) -> list[str]:
    """Parse + normalize RAM output into a tidy entity list. Pure (no torch)."""
    parts = raw.split("|") if isinstance(raw, str) else list(raw)
    seen: list[str] = []
    for p in parts:
        t = p.strip().lower()
        if not t or t in _STOP or t in seen:
            continue
        seen.append(t)
        if len(seen) >= max_tags:
            break
    return seen


def _encode_url(u: str) -> str:
    p = urlsplit(u)
    return urlunsplit((p.scheme, p.netloc, quote(p.path), p.query, p.fragment))


def _ensure_image(src: str, dest_dir: Path, asset_id: str) -> Path | None:
    ext = os.path.splitext(src.split("?")[0])[1] or ".webp"
    dest = dest_dir / f"{asset_id}{ext}"
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    try:
        r = requests.get(src, timeout=120)
        r.raise_for_status()
        dest.write_bytes(r.content)
        return dest
    except Exception as e:
        print(f"[entities] WARN image fetch {asset_id}: {e}")
        return None


def _video_frame(asset: dict, dest_dir: Path) -> Path | None:
    dest = dest_dir / f"{asset['id']}.png"
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    shots = asset.get("shots") or []
    at = shots[0]["start"] if shots else 30.0  # a baked interior shot, else ~30s in
    cmd = ["ffmpeg", "-y", "-ss", str(at), "-i", _encode_url(asset["src"]), "-frames:v", "1",
           "-q:v", "3", str(dest)]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=120)
        return dest if dest.exists() and dest.stat().st_size > 0 else None
    except (subprocess.CalledProcessError, FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return None


def _make_ram(cache_dir: Path):
    """Load RAM++ (model, transform, inference_fn) or None if the `entities` extra is unavailable."""
    try:
        import torch  # noqa: F401
        from huggingface_hub import hf_hub_download
        from ram import get_transform, inference_ram
        from ram.models import ram_plus
    except ImportError:
        return None
    try:
        ckpt = hf_hub_download(RAM_REPO, RAM_CKPT, cache_dir=str(cache_dir))
        model = ram_plus(pretrained=ckpt, image_size=IMAGE_SIZE, vit="swin_l").eval()
        transform = get_transform(image_size=IMAGE_SIZE)
        return model, transform, inference_ram
    except Exception as e:  # noqa: BLE001
        print(f"[entities] RAM++ load failed: {e}")
        return None


def annotate(manifest: dict[str, Any], work_dir: Path, limit: int | None = None) -> tuple[dict, int]:
    out = json.loads(json.dumps(manifest))
    work_dir.mkdir(parents=True, exist_ok=True)
    ram = _make_ram(work_dir / "ram_cache")
    if ram is None:
        print("[entities] needs the `entities` extra (ram + torch) + the checkpoint — nothing tagged")
        return out, 0
    model, transform, inference_ram = ram
    from PIL import Image

    visuals = [a for a in out.get("assets", []) if a.get("type") in ("image", "video") and a.get("src")]
    if limit is not None:
        visuals = visuals[:limit]

    tagged = 0
    for a in visuals:
        img_path = (
            _video_frame(a, work_dir / "frames")
            if a.get("type") == "video"
            else _ensure_image(a["src"], work_dir / "imgs", a["id"])
        )
        if img_path is None:
            continue
        try:
            tensor = transform(Image.open(img_path).convert("RGB")).unsqueeze(0)
            res = inference_ram(tensor, model)
            tags = clean_tags(res[0] if isinstance(res, (list, tuple)) else res)
        except Exception as e:  # noqa: BLE001
            print(f"[entities] WARN tag failed {a['id']}: {e}")
            continue
        if tags:
            a["entities"] = tags
            tagged += 1
            print(f"[entities] {a['id']}: {tags}")

    out["version"] = datetime.now(timezone.utc).strftime("%Y.%m.%d-%H%M")
    out["createdAt"] = datetime.now(timezone.utc).isoformat()
    return out, tagged


def load_manifest(path: Path | None, url: str | None) -> dict[str, Any]:
    if path and path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    fetch_url = url or DEFAULT_MANIFEST_URL
    print(f"[entities] fetching {fetch_url}")
    resp = requests.get(fetch_url, timeout=120)
    resp.raise_for_status()
    return resp.json()


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="DREAMREEL entity tagging (RAM++ memory index)")
    ap.add_argument("--manifest", type=Path, default=None)
    ap.add_argument("--url", type=str, default=None)
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--limit", type=int, default=None, help="tag only the first N visual assets")
    ap.add_argument("--upload", action="store_true", help="upload manifest-only to R2 (needs R2_* env)")
    args = ap.parse_args()

    manifest = load_manifest(args.manifest, args.url)
    annotated, n = annotate(manifest, args.out / "entities_work", args.limit)
    total = sum(1 for a in annotated.get("assets", []) if a.get("type") in ("image", "video"))
    print(f"[entities] tagged {n}/{total} visual assets")

    args.out.mkdir(parents=True, exist_ok=True)
    out_path = args.out / "manifest.json"
    out_path.write_text(json.dumps(annotated, indent=2) + "\n", encoding="utf-8")
    print(f"[entities] wrote {out_path}: v{annotated['version']}")

    if args.upload:
        if not any(a.get("entities") for a in annotated.get("assets", [])):
            raise SystemExit("[entities] refusing to upload: nothing tagged (is the `entities` extra installed?)")
        required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE")
        missing = [k for k in required if not os.environ.get(k)]
        if missing:
            raise SystemExit(f"[entities] --upload requires R2 env: {missing}")
        from publish.upload_r2 import publish_manifest, write_local_copy

        urls = publish_manifest(annotated, {})
        write_local_copy(annotated, args.out)
        print(f"[entities] published: {urls}")


if __name__ == "__main__":
    main()
