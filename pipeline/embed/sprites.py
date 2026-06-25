"""Extract segmented ENTITY CUTOUTS for the dream's most-recurring motifs (Grounding DINO box →
SAM 2 mask, both Apache-2.0) and bake a manifest-level `entitySprites[]` pool. At runtime, when the
dream strongly remembers one of these entities, it summons the actual cutout as a drifting ghost —
literal motif recurrence (render/SpriteField.ts).

Per target: Grounding DINO localizes the entity in a source PD image, SAM 2 segments it, and the
masked crop is written as an RGBA PNG, uploaded to R2, and recorded with the source asset's license.

The target-selection and cutout compositing (`pick_targets`, `cutout_from_mask`) are pure and
unit-tested; detection/segmentation lazy-import the `sprites` extra (transformers, torch, Pillow).

Usage (from pipeline/, needs the `sprites` extra):
    python -m embed.sprites --out out --max 40
    python -m embed.sprites --manifest out/manifest.json --out out --max 40 --upload
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import requests

DEFAULT_MANIFEST_URL = (
    "https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json"
)
GDINO_ID = "IDEA-Research/grounding-dino-tiny"
SAM2_ID = "facebook/sam2.1-hiera-small"

# Entities that recur but are styles/abstractions, not segmentable objects — skip as sprite targets.
_SKIP = {
    "drawing", "painting", "art", "black", "white", "stand", "system", "blanket", "portrait",
    "illustration", "manuscript", "book", "text", "old", "vintage", "background",
}
MIN_BOX_FRAC = 0.02  # ignore boxes smaller than this fraction of the image (noise)
MAX_BOX_FRAC = 0.85  # ignore near-whole-image boxes (not a discrete entity)


def pick_targets(manifest: dict[str, Any], max_sprites: int) -> list[tuple[str, dict]]:
    """The most-recurring concrete entities, each paired with its best source IMAGE asset. Pure.

    Frequency is counted over image assets carrying entities; the source per entity is the
    highest-`aesthetic` image containing it (id tie-break). Deterministic.
    """
    images = [a for a in manifest.get("assets", []) if a.get("type") == "image" and a.get("entities")]
    freq: Counter[str] = Counter()
    for a in images:
        for e in a["entities"]:
            if e not in _SKIP:
                freq[e] += 1

    out: list[tuple[str, dict]] = []
    for entity, _ in sorted(freq.items(), key=lambda kv: (-kv[1], kv[0])):
        sources = [a for a in images if entity in a["entities"]]
        if not sources:
            continue
        best = sorted(sources, key=lambda a: (-a.get("aesthetic", 0.0), a["id"]))[0]
        out.append((entity, best))
        if len(out) >= max_sprites:
            break
    return out


def cutout_from_mask(img, box: tuple[float, float, float, float], mask: np.ndarray):
    """Crop `img` (PIL RGB) to `box` and set alpha from `mask` (HxW bool, full image). Returns RGBA."""
    from PIL import Image

    w, h = img.size
    x0, y0, x1, y1 = (int(round(v)) for v in box)
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(w, x1), min(h, y1)
    crop = img.crop((x0, y0, x1, y1)).convert("RGBA")
    arr = np.array(crop)
    m = mask[y0:y1, x0:x1]
    arr[..., 3] = (m.astype(np.uint8) * 255)
    return Image.fromarray(arr, "RGBA")


def _box_ok(box, w: int, h: int) -> bool:
    x0, y0, x1, y1 = box
    frac = (abs(x1 - x0) * abs(y1 - y0)) / max(1.0, w * h)
    return MIN_BOX_FRAC <= frac <= MAX_BOX_FRAC


def _make_models():
    """Lazy-load (gdino_proc, gdino, sam2_proc, sam2, torch) or None if the extra is unavailable."""
    try:
        import torch
        from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor, Sam2Model
    except ImportError:
        return None
    try:
        gp = AutoProcessor.from_pretrained(GDINO_ID)
        gm = AutoModelForZeroShotObjectDetection.from_pretrained(GDINO_ID).eval()
        sp = AutoProcessor.from_pretrained(SAM2_ID)
        sm = Sam2Model.from_pretrained(SAM2_ID).eval()
        return gp, gm, sp, sm, torch
    except Exception as e:  # noqa: BLE001
        print(f"[sprites] model load failed: {e}")
        return None


def detect_box(img, entity: str, gp, gm, torch):
    """Best Grounding DINO box for `entity` in `img` (PIL RGB), or None."""
    inputs = gp(images=img, text=f"{entity}.", return_tensors="pt")
    with torch.no_grad():
        outputs = gm(**inputs)
    res = gp.post_process_grounded_object_detection(
        outputs, inputs["input_ids"], threshold=0.3, text_threshold=0.25,
        target_sizes=[(img.size[1], img.size[0])],
    )[0]
    boxes, scores = res["boxes"], res["scores"]
    best, best_score = None, 0.0
    w, h = img.size
    for b, s in zip(boxes.tolist(), scores.tolist()):
        if s > best_score and _box_ok(b, w, h):
            best, best_score = b, s
    return best


def segment(img, box, sp, sm, torch) -> np.ndarray | None:
    """SAM 2 binary mask for the `box` region of `img` (PIL RGB), or None.

    SAM 2 emits 3 candidate masks per box (multimask output); we keep the largest-area one.
    """
    inputs = sp(images=img, input_boxes=[[box]], return_tensors="pt")
    with torch.no_grad():
        outputs = sm(**inputs)
    masks = sp.post_process_masks(outputs.pred_masks, inputs["original_sizes"])[0]
    arr = masks.cpu().numpy() if hasattr(masks, "cpu") else np.asarray(masks)
    while arr.ndim > 3:  # drop leading box dims → (candidates, H, W)
        arr = arr[0]
    if arr.ndim == 2:
        return arr > 0.0
    binmask = arr > 0.0
    areas = binmask.reshape(binmask.shape[0], -1).sum(axis=1)
    return binmask[int(areas.argmax())]


def _ensure_image(src: str, dest_dir: Path, asset_id: str) -> Path | None:
    dest_dir.mkdir(parents=True, exist_ok=True)
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
        print(f"[sprites] WARN fetch {asset_id}: {e}")
        return None


def build_sprites(manifest: dict[str, Any], out_dir: Path, max_sprites: int) -> tuple[list[dict], dict]:
    """Returns (entity_sprites, local_png_by_id). Needs the `sprites` extra."""
    from PIL import Image

    models = _make_models()
    if models is None:
        print("[sprites] needs the `sprites` extra (transformers + torch + Pillow) — nothing built")
        return [], {}
    gp, gm, sp, sm, torch = models
    img_dir = out_dir / "src_imgs"
    png_dir = out_dir / "cutouts"
    png_dir.mkdir(parents=True, exist_ok=True)

    sprites: list[dict] = []
    local: dict[str, Path] = {}
    for entity, asset in pick_targets(manifest, max_sprites):
        path = _ensure_image(asset["src"], img_dir, asset["id"])
        if path is None:
            continue
        try:
            img = Image.open(path).convert("RGB")
            box = detect_box(img, entity, gp, gm, torch)
            if box is None:
                print(f"[sprites] no box for '{entity}' in {asset['id']}")
                continue
            mask = segment(img, box, sp, sm, torch)
            if mask is None or not mask.any():
                continue
            cut = cutout_from_mask(img, box, mask)
        except Exception as e:  # noqa: BLE001
            print(f"[sprites] WARN '{entity}' {asset['id']}: {e}")
            continue
        sid = f"sprite-{entity.replace(' ', '-')}"
        png = png_dir / f"{sid}.png"
        cut.save(png)
        local[sid] = png
        sprites.append({
            "id": sid,
            "entity": entity,
            "src": f"sprite/{sid}.png",  # rewritten to the R2 URL on upload
            "aspect": round(cut.width / max(1, cut.height), 4),
            "source": asset["source"],
            "license": asset["license"],
            **({"attribution": asset["attribution"]} if asset.get("attribution") else {}),
            **({"attributionUrl": asset["attributionUrl"]} if asset.get("attributionUrl") else {}),
        })
        print(f"[sprites] {sid}: {cut.width}x{cut.height} from {asset['id']}")
    return sprites, local


def load_manifest(path: Path | None, url: str | None) -> dict[str, Any]:
    if path and path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    fetch_url = url or DEFAULT_MANIFEST_URL
    print(f"[sprites] fetching {fetch_url}")
    resp = requests.get(fetch_url, timeout=120)
    resp.raise_for_status()
    return resp.json()


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="DREAMREEL entity sprites (Grounding DINO + SAM 2)")
    ap.add_argument("--manifest", type=Path, default=None)
    ap.add_argument("--url", type=str, default=None)
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--max", type=int, default=40, help="max entity cutouts to build")
    ap.add_argument("--upload", action="store_true", help="upload cutouts + manifest to R2 (R2_* env)")
    args = ap.parse_args()

    manifest = load_manifest(args.manifest, args.url)
    sprites, local = build_sprites(manifest, args.out / "sprites_work", args.max)
    manifest["entitySprites"] = sprites
    manifest["version"] = datetime.now(timezone.utc).strftime("%Y.%m.%d-%H%M")
    manifest["createdAt"] = datetime.now(timezone.utc).isoformat()
    print(f"[sprites] built {len(sprites)} entity cutouts")

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"[sprites] wrote {args.out / 'manifest.json'}: v{manifest['version']}")

    if args.upload:
        if not sprites:
            raise SystemExit("[sprites] refusing to upload: no cutouts built")
        required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE")
        missing = [k for k in required if not os.environ.get(k)]
        if missing:
            raise SystemExit(f"[sprites] --upload requires R2 env: {missing}")
        from publish.upload_r2 import publish_manifest, upload_media, write_local_copy

        urls = upload_media(local)  # id -> R2 url
        for s in sprites:
            if s["id"] in urls:
                s["src"] = urls[s["id"]]
        out_urls = publish_manifest(manifest, {})
        write_local_copy(manifest, args.out)
        print(f"[sprites] published {len(urls)} cutouts + manifest: {out_urls}")


if __name__ == "__main__":
    main()
