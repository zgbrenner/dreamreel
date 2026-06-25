"""Re-embed the live manifest's visual + text pools into SigLIP 2 space, refit the 12 mood axes,
and re-project every mood — the semantic-core upgrade. Audio (CLAP), `claptext`, `aesthetic`, and
`bpm`/`energy` are preserved untouched; only `embedding`/`mood` (visual + text), `moodAxes`, and
`embeddingDim` change.

Image assets are embedded from their R2 image (cached); video assets from an ffmpeg-extracted poster
frame; procedural/synthetic assets (no real still) from a SigLIP-text embedding of their tags — so
the whole visual pool lives in ONE consistent space. Texts are embedded with the SigLIP text tower.

The pure transform (`reembed_manifest`) takes an injected embedder + image resolver and is unit-tested
with fakes; `main()` supplies the real SigLIP 2 embedder + R2/ffmpeg I/O (the `embed` extra + ffmpeg).

Usage (from pipeline/, needs the `embed` extra + ffmpeg):
    python -m embed.reembed_siglip --out out --limit 5
    python -m embed.reembed_siglip --manifest out/manifest.json --out out --upload
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote, urlsplit, urlunsplit

import numpy as np
import requests

from embed.mood_axes import build_axes, project_mood

DEFAULT_MANIFEST_URL = (
    "https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json"
)


def _emb_list(v: np.ndarray) -> list[float]:
    return [round(float(x), 6) for x in np.asarray(v).tolist()]


def _tags_text(asset: dict) -> str:
    tags = asset.get("tags") or []
    return ", ".join(tags) if tags else (asset.get("kind") or asset.get("type") or "image")


def reembed_manifest(
    manifest: dict[str, Any],
    embedder,
    image_for: Callable[[dict], str | None],
    limit: int | None = None,
) -> tuple[dict, int]:
    """Pure transform: returns (new_manifest, n_embedded). `image_for(asset)` yields a local image
    path for image/video assets (or None → fall back to a tag text-embedding)."""
    out = json.loads(json.dumps(manifest))
    axes = build_axes(embedder)

    assets = out.get("assets", [])
    if limit is not None:
        assets = assets[:limit]
        out["assets"] = assets
    n = 0
    for a in assets:
        emb: np.ndarray | None = None
        if a.get("type") in ("image", "video"):
            path = image_for(a)
            if path is not None:
                emb = embedder.embed_images([path])[0]
        if emb is None:
            # procedural / synthetic / failed media → place it by its tags in SigLIP text space
            emb = embedder.embed_texts([_tags_text(a)])[0]
        a["embedding"] = _emb_list(emb)
        a["mood"] = project_mood(np.asarray(emb, dtype=np.float64), axes)
        n += 1

    for t in out.get("texts", []):
        emb = embedder.embed_texts([t.get("text", "")])[0]
        t["embedding"] = _emb_list(emb)
        t["mood"] = project_mood(np.asarray(emb, dtype=np.float64), axes)
        n += 1

    out["moodAxes"] = {axis: _emb_list(axes[axis]) for axis in axes}
    out["embeddingDim"] = int(embedder.dim)
    out["version"] = datetime.now(timezone.utc).strftime("%Y.%m.%d-%H%M")
    out["createdAt"] = datetime.now(timezone.utc).isoformat()
    return out, n


# --- real I/O resolvers -------------------------------------------------------

def _ensure_image(src: str, dest_dir: Path, asset_id: str) -> str | None:
    ext = os.path.splitext(src.split("?")[0])[1] or ".webp"
    dest = dest_dir / f"{asset_id}{ext}"
    if dest.exists() and dest.stat().st_size > 0:
        return str(dest)
    try:
        r = requests.get(src, timeout=120)
        r.raise_for_status()
        dest.write_bytes(r.content)
        return str(dest)
    except Exception as e:
        print(f"[siglip] WARN image fetch {asset_id}: {e}")
        return None


def _encode_url(u: str) -> str:
    """Percent-encode the path so URLs with spaces/parens (common on archive.org) work in ffmpeg."""
    p = urlsplit(u)
    return urlunsplit((p.scheme, p.netloc, quote(p.path), p.query, p.fragment))


def _video_poster(src: str, dest_dir: Path, asset_id: str) -> str | None:
    dest = dest_dir / f"{asset_id}.png"
    if dest.exists() and dest.stat().st_size > 0:
        return str(dest)
    # Pull a single frame ~1 s in, streaming from the URL (no full download). `-ss` AFTER `-i`
    # (output seeking) is reliable over HTTP where input seeking needs byte-range support.
    cmd = ["ffmpeg", "-y", "-i", _encode_url(src), "-ss", "1", "-frames:v", "1", "-q:v", "3", str(dest)]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=60)
        return str(dest) if dest.exists() and dest.stat().st_size > 0 else None
    except (subprocess.CalledProcessError, FileNotFoundError, OSError, subprocess.TimeoutExpired) as e:
        print(f"[siglip] WARN poster extract {asset_id}: {type(e).__name__}")
        return None


def make_image_resolver(media_dir: Path) -> Callable[[dict], str | None]:
    media_dir.mkdir(parents=True, exist_ok=True)

    def resolve(asset: dict) -> str | None:
        src = asset.get("src")
        if not src:
            return None
        if asset.get("type") == "video":
            return _video_poster(src, media_dir, asset["id"])
        return _ensure_image(src, media_dir, asset["id"])

    return resolve


def load_manifest(path: Path | None, url: str | None) -> dict[str, Any]:
    if path and path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    fetch_url = url or DEFAULT_MANIFEST_URL
    print(f"[siglip] fetching {fetch_url}")
    resp = requests.get(fetch_url, timeout=120)
    resp.raise_for_status()
    return resp.json()


def main() -> None:
    # Windows consoles default to cp1252; force UTF-8 so any non-ASCII output never crashes the run.
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="DREAMREEL SigLIP 2 re-embed (semantic-core upgrade)")
    ap.add_argument("--manifest", type=Path, default=None)
    ap.add_argument("--url", type=str, default=None)
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--limit", type=int, default=None, help="re-embed only the first N assets (smoke)")
    ap.add_argument("--model", type=str, default=None, help="SigLIP2 model id (default: base; so400m for max quality)")
    ap.add_argument("--upload", action="store_true", help="upload manifest-only to R2 (needs R2_* env)")
    args = ap.parse_args()

    from embed.siglip_backend import MODEL_ID, get_siglip_embedder

    embedder = get_siglip_embedder(args.model or MODEL_ID)
    if embedder is None:
        raise SystemExit("[siglip] needs the `embed` extra (torch + transformers>=4.49) + the model")
    print(f"[siglip] backend ready, dim={embedder.dim}")

    manifest = load_manifest(args.manifest, args.url)
    media_dir = args.out / "siglip_media"
    resolver = make_image_resolver(media_dir)
    reembedded, n = reembed_manifest(manifest, embedder, resolver, args.limit)
    print(
        f"[siglip] re-embedded {n} items "
        f"({len(reembedded.get('assets', []))} visual + {len(reembedded.get('texts', []))} texts) "
        f"-> dim {reembedded['embeddingDim']}"
    )

    args.out.mkdir(parents=True, exist_ok=True)
    out_path = args.out / "manifest.json"
    out_path.write_text(json.dumps(reembedded, indent=2) + "\n", encoding="utf-8")
    print(f"[siglip] wrote {out_path}: v{reembedded['version']}")

    if args.upload:
        required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE")
        missing = [k for k in required if not os.environ.get(k)]
        if missing:
            raise SystemExit(f"[siglip] --upload requires R2 env: {missing}")
        from publish.upload_r2 import publish_manifest, write_local_copy

        urls = publish_manifest(reembedded, {})
        write_local_copy(reembedded, args.out)
        print(f"[siglip] published: {urls}")


if __name__ == "__main__":
    main()
