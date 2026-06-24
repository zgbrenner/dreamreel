"""Bake a LAION aesthetic score (~0..10) onto each image asset in the manifest.

The LAION aesthetic predictor (github.com/LAION-AI/aesthetic-predictor, MIT) is a single linear
head over CLIP embeddings — BUT it was trained on OpenAI-CLIP ViT-B/32 features, while DREAMREEL's
manifest carries OpenCLIP (laion2b) ViT-B/32 features in a DIFFERENT space. So we cannot apply the
head to the baked embeddings; we re-embed each image with OpenAI CLIP ViT-B/32 (downloaded once),
L2-normalize, and apply the head. Media is fetched from the asset's R2 `src` (cached) — no
re-transcode. The score is baked as `aesthetic` and the runtime gently biases the dream walk toward
higher-scored assets (`dream/dreamwalker.ts` aestheticBoost). Determinism is unaffected (a static
per-asset scalar). Video/procedural/title-card assets are skipped (no still to score).

Pure scoring math (`score_embeddings`) is unit-tested without torch; the embed/head steps lazy-import
torch + open_clip (the `embed` extra) so CI and the license/manifest tests never need them.

Usage (from pipeline/, needs the `embed` extra + Pillow):
    python -m embed.aesthetic --out out --limit 5     # smoke a few
    python -m embed.aesthetic --manifest out/manifest.json --out out --upload
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import requests

DEFAULT_MANIFEST_URL = (
    "https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json"
)
AESTHETIC_HEAD_URL = (
    "https://github.com/LAION-AI/aesthetic-predictor/raw/main/sa_0_4_vit_b_32_linear.pth"
)


def score_embeddings(emb: np.ndarray, w: np.ndarray, b: float) -> np.ndarray:
    """LAION aesthetic score for L2-normalized-or-not CLIP embeddings. Pure; no torch needed."""
    e = np.asarray(emb, dtype=np.float64)
    if e.ndim == 1:
        e = e[None, :]
    e = e / (np.linalg.norm(e, axis=1, keepdims=True) + 1e-9)
    return e @ np.asarray(w, dtype=np.float64) + float(b)


def load_aesthetic_head(cache_dir: Path) -> tuple[np.ndarray, float] | None:
    """Download (once) + load the MIT LAION linear head; returns (weight[512], bias) or None."""
    try:
        import torch
    except ImportError:
        return None
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / "sa_0_4_vit_b_32_linear.pth"
    if not path.exists():
        print(f"[aesthetic] downloading head {AESTHETIC_HEAD_URL}")
        r = requests.get(AESTHETIC_HEAD_URL, timeout=120)
        r.raise_for_status()
        path.write_bytes(r.content)
    sd = torch.load(path, map_location="cpu")
    w = sd["weight"].squeeze().to(torch.float64).numpy()
    b = float(sd["bias"].squeeze().to(torch.float64).numpy())
    return w, b


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
    except Exception as e:
        print(f"[aesthetic] WARN could not fetch {asset_id}: {e}")
        return None


def _make_openai_clip():
    """Lazy OpenAI-CLIP-B/32 image embedder. Returns (embed_fn, ok) or (None, False)."""
    try:
        import open_clip
        import torch
        from PIL import Image
    except ImportError:
        return None, False

    model, _, preprocess = open_clip.create_model_and_transforms("ViT-B-32", pretrained="openai")
    model.eval()

    def embed(path: Path) -> np.ndarray | None:
        try:
            img = preprocess(Image.open(path).convert("RGB")).unsqueeze(0)
            with torch.no_grad():
                f = model.encode_image(img)
            return f[0].to(torch.float64).cpu().numpy()
        except Exception:
            return None

    return embed, True


def annotate(manifest: dict[str, Any], img_dir: Path, limit: int | None = None) -> tuple[dict, int]:
    """Bake `aesthetic` onto image assets. Returns (manifest, n_scored)."""
    out = json.loads(json.dumps(manifest))
    head = load_aesthetic_head(img_dir)
    embed, ok = _make_openai_clip()
    if head is None or not ok:
        print("[aesthetic] note: needs the `embed` extra (torch + open_clip) + Pillow — nothing scored")
        return out, 0
    w, b = head

    images = [a for a in out.get("assets", []) if a.get("type") == "image"]
    if limit is not None:
        images = images[:limit]
    scored = 0
    for a in images:
        local = _ensure_local(a["src"], img_dir, a["id"])
        if local is None:
            continue
        emb = embed(local)
        if emb is None:
            continue
        a["aesthetic"] = round(float(score_embeddings(emb, w, b)[0]), 2)
        scored += 1

    out["version"] = datetime.now(timezone.utc).strftime("%Y.%m.%d-%H%M")
    out["createdAt"] = datetime.now(timezone.utc).isoformat()
    return out, scored


def load_manifest(path: Path | None, url: str | None) -> dict[str, Any]:
    if path and path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    fetch_url = url or DEFAULT_MANIFEST_URL
    print(f"[aesthetic] fetching {fetch_url}")
    resp = requests.get(fetch_url, timeout=120)
    resp.raise_for_status()
    return resp.json()


def main() -> None:
    ap = argparse.ArgumentParser(description="DREAMREEL aesthetic scoring (LAION head over OpenAI CLIP)")
    ap.add_argument("--manifest", type=Path, default=None)
    ap.add_argument("--url", type=str, default=None)
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--limit", type=int, default=None, help="score only the first N images (smoke)")
    ap.add_argument("--upload", action="store_true", help="upload manifest-only to R2 (needs R2_* env)")
    args = ap.parse_args()

    manifest = load_manifest(args.manifest, args.url)
    img_dir = args.out / "aesthetic"
    annotated, scored = annotate(manifest, img_dir, args.limit)
    total_img = sum(1 for a in annotated.get("assets", []) if a.get("type") == "image")
    print(f"[aesthetic] scored {scored}/{total_img} image assets")

    args.out.mkdir(parents=True, exist_ok=True)
    out_path = args.out / "manifest.json"
    out_path.write_text(json.dumps(annotated, indent=2) + "\n", encoding="utf-8")
    print(f"[aesthetic] wrote {out_path}: v{annotated['version']}")

    if args.upload:
        if scored == 0:
            raise SystemExit("[aesthetic] refusing to upload: 0 assets scored")
        required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE")
        missing = [k for k in required if not os.environ.get(k)]
        if missing:
            raise SystemExit(f"[aesthetic] --upload requires R2 env: {missing}")
        from publish.upload_r2 import publish_manifest, write_local_copy

        urls = publish_manifest(annotated, {})
        write_local_copy(annotated, args.out)
        print(f"[aesthetic] published: {urls}")


if __name__ == "__main__":
    main()
