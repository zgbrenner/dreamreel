"""Bake a grayscale DEPTH map per image asset (Depth Anything V2 Small — Apache-2.0).

Depth unlocks the runtime's 2.5D treatments (depth-parallax drift, rack-focus, in-scene fog):
the offline pass runs monocular depth estimation on each still, writes a quarter-resolution
grayscale PNG next to the media on R2, and bakes its URL as `depthSrc`. Absent `depthSrc` the
runtime renders flat, exactly as before — legacy manifests are unaffected.

License note (hard constraint, commercial product): ONLY the Small checkpoint
(depth-anything/Depth-Anything-V2-Small-hf) is Apache-2.0 — the Base/Large/Giant weights are
CC-BY-NC-4.0 and must not be used, even pipeline-side. This module pins Small.

The model steps lazy-import transformers + torch (the `depth` extra) so CI and the
license/manifest tests never need them; the PNG-encoding math is pure and unit-tested.

Usage (from pipeline/, needs the `depth` extra + Pillow):
    python -m embed.depth --out out --limit 5              # smoke a few
    python -m embed.depth --out out --only-missing --upload  # bake + ship (needs R2_* env)
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import numpy as np
import requests

DEFAULT_MANIFEST_URL = (
    "https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json"
)
# The ONLY commercially-usable DAv2 checkpoint (Apache-2.0). Do not swap for Base/Large/Giant.
MODEL_ID = "depth-anything/Depth-Anything-V2-Small-hf"
DOWNSCALE = 4  # depth map at 1/4 the source resolution — plenty for UV displacement

DepthFn = Callable[[Path], "np.ndarray | None"]


def depth_to_gray(depth: np.ndarray) -> np.ndarray:
    """Normalize a raw depth array to uint8 0..255 (near=bright). Pure; unit-tested."""
    d = np.asarray(depth, dtype=np.float64)
    lo = float(d.min())
    hi = float(d.max())
    if not np.isfinite(lo) or not np.isfinite(hi) or hi - lo < 1e-9:
        return np.zeros(d.shape, dtype=np.uint8)
    return ((d - lo) / (hi - lo) * 255.0).round().astype(np.uint8)


def save_depth_png(depth: np.ndarray, dest: Path, downscale: int = DOWNSCALE) -> Path:
    """Encode a normalized depth map as a downscaled grayscale PNG."""
    from PIL import Image

    gray = depth_to_gray(depth)
    im = Image.fromarray(gray, mode="L")
    w = max(1, im.width // downscale)
    h = max(1, im.height // downscale)
    im = im.resize((w, h), Image.BILINEAR)
    dest.parent.mkdir(parents=True, exist_ok=True)
    im.save(dest, "PNG", optimize=True)
    return dest


def _make_depth_model() -> tuple[DepthFn | None, bool]:
    """Lazy Depth Anything V2 Small via transformers. Returns (depth_fn, ok) or (None, False)."""
    try:
        import torch  # noqa: F401
        from PIL import Image
        from transformers import pipeline as hf_pipeline
    except ImportError:
        return None, False

    pipe = hf_pipeline("depth-estimation", model=MODEL_ID)

    def depth(path: Path) -> np.ndarray | None:
        try:
            result = pipe(Image.open(path).convert("RGB"))
            return np.asarray(result["depth"], dtype=np.float64)
        except Exception as e:  # noqa: BLE001
            print(f"[depth] WARN inference failed for {path.name}: {e}")
            return None

    return depth, True


def _ensure_local(src: str, dest_dir: Path, asset_id: str) -> Path | None:
    ext = os.path.splitext(src.split("?")[0])[1] or ".webp"
    dest = dest_dir / f"{asset_id}{ext}"
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    try:
        r = requests.get(src, timeout=120)
        r.raise_for_status()
        dest.write_bytes(r.content)
        return dest
    except Exception as e:  # noqa: BLE001
        print(f"[depth] WARN could not fetch {asset_id}: {e}")
        return None


def annotate(
    manifest: dict[str, Any],
    work_dir: Path,
    limit: int | None = None,
    only_missing: bool = False,
    depth_fn: DepthFn | None = None,
) -> tuple[dict[str, Any], dict[str, Path]]:
    """Bake depth PNGs for image assets. Returns (manifest copy, {asset_id: png path}).

    `depthSrc` itself is written by apply_urls() after the PNGs are uploaded — a local-only run
    produces the derivatives without touching the manifest fields.
    """
    out = json.loads(json.dumps(manifest))
    fn = depth_fn
    if fn is None:
        fn, ok = _make_depth_model()
        if not ok:
            print("[depth] note: needs the `depth` extra (transformers + torch) + Pillow — nothing baked")
            return out, {}

    images = [a for a in out.get("assets", []) if a.get("type") == "image" and a.get("src")]
    if only_missing:
        images = [a for a in images if not a.get("depthSrc")]
    if limit is not None:
        images = images[:limit]

    derivs: dict[str, Path] = {}
    for a in images:
        local = _ensure_local(a["src"], work_dir, a["id"])
        if local is None:
            continue
        depth = fn(local)
        if depth is None:
            continue
        derivs[a["id"]] = save_depth_png(depth, work_dir / f"depth-{a['id']}.png")

    out["version"] = datetime.now(timezone.utc).strftime("%Y.%m.%d-%H%M")
    out["createdAt"] = datetime.now(timezone.utc).isoformat()
    return out, derivs


def apply_urls(manifest: dict[str, Any], urls: dict[str, str]) -> int:
    """Set depthSrc from uploaded {asset_id: url}. Returns the number of assets updated. Pure."""
    n = 0
    for a in manifest.get("assets", []):
        url = urls.get(a["id"])
        if url:
            a["depthSrc"] = url
            n += 1
    return n


def load_manifest(path: Path | None, url: str | None) -> dict[str, Any]:
    if path and path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    fetch_url = url or DEFAULT_MANIFEST_URL
    print(f"[depth] fetching {fetch_url}")
    resp = requests.get(fetch_url, timeout=120)
    resp.raise_for_status()
    return resp.json()


def main() -> None:
    ap = argparse.ArgumentParser(description="DREAMREEL depth baking (Depth Anything V2 Small)")
    ap.add_argument("--manifest", type=Path, default=None)
    ap.add_argument("--url", type=str, default=None)
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--limit", type=int, default=None, help="bake only the first N images (smoke)")
    ap.add_argument("--only-missing", action="store_true", help="skip assets that already carry depthSrc")
    ap.add_argument("--upload", action="store_true", help="upload depth PNGs + manifest to R2 (needs R2_* env)")
    args = ap.parse_args()

    manifest = load_manifest(args.manifest, args.url)
    work_dir = args.out / "depth"
    annotated, derivs = annotate(manifest, work_dir, args.limit, args.only_missing)
    total_img = sum(1 for a in annotated.get("assets", []) if a.get("type") == "image")
    print(f"[depth] baked {len(derivs)}/{total_img} image depth maps")

    args.out.mkdir(parents=True, exist_ok=True)

    if args.upload:
        if not derivs:
            raise SystemExit("[depth] refusing to upload: 0 depth maps baked")
        required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE")
        missing = [k for k in required if not os.environ.get(k)]
        if missing:
            raise SystemExit(f"[depth] --upload requires R2 env: {missing}")
        from publish.upload_r2 import publish_manifest, upload_media, write_local_copy

        urls = upload_media(derivs)
        n = apply_urls(annotated, urls)
        print(f"[depth] depthSrc set on {n} assets")
        pub = publish_manifest(annotated, {})
        write_local_copy(annotated, args.out)
        print(f"[depth] published: {pub}")

    out_path = args.out / "manifest.json"
    out_path.write_text(json.dumps(annotated, indent=2) + "\n", encoding="utf-8")
    print(f"[depth] wrote {out_path}: v{annotated['version']}")


if __name__ == "__main__":
    main()
