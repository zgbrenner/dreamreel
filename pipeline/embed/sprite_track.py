"""Animated entity cutouts via trackfx (torchvision Mask R-CNN + ByteTrack) — a third
producer of the manifest's `entitySprites[]` pool, alongside embed/sprites.py (static,
Grounding DINO + SAM 2) and embed/sprite_clips.py (animated, SAM 2 video tracking).

Where sprite_clips.py locks onto whatever Grounding DINO finds in frame 0 and propagates
that one mask, this walks a shot with ByteTrack and keeps the LONGEST-LIVED track — the
object genuinely present through the shot, which is the better recurrence candidate — then
crops every frame of that track to its union box and assembles a grid sprite SHEET. The
baked EntitySprite gets the same `frames`/`cols`/`fps` the runtime already cycles
(render/SpriteField.ts), so this needs ZERO runtime/manifest-schema changes.

Recurrence gate: Mask R-CNN only knows 80 COCO classes, but recurrence (dream/memory.ts)
matches EntitySprite.entity against the source asset's open-vocabulary RAM++ entities[].
So a cutout is emitted ONLY when the tracked object's COCO class (or a small synonym)
appears in that asset's entities[] — and the sprite is named with the matched RAM++ tag,
guaranteeing it can actually be remembered and summoned. Objects with no such overlap are
skipped.

Model licensing (this may ship): torchvision Mask R-CNN code + weights are BSD-3-Clause;
supervision (ByteTrack/IO) is MIT. Both permissive, no copyleft — same policy bar as the
Apache-2.0 Grounding DINO + SAM 2 used by the sibling modules.

The pure helpers (target/entity/track selection, sheet assembly reuse) are unit-tested;
detection+tracking lazy-imports `trackfx` (install the `track` extra: torch, torchvision,
supervision) + needs ffmpeg for frame extraction. A graceful no-op if trackfx is absent.

Usage (from pipeline/, needs the `track` extra + ffmpeg):
    python -m embed.sprite_track --out out --max 8 --frames 12
    python -m embed.sprite_track --manifest out/manifest.json --out out --max 8 --upload
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import requests

# Reuse the pure sheet/box/cutout helpers + ffmpeg frame sampler from the sibling modules
# (all light at import — they lazy-import PIL/torch internally).
from embed.sprite_clips import DEFAULT_FPS, _extract_frames, assemble_sheet, grid_dims, union_box
from embed.sprites import _SKIP, cutout_from_mask

DEFAULT_MANIFEST_URL = (
    "https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json"
)
MIN_TRACK_FRAMES = 4  # a track must persist this many frames to be worth a sprite

# COCO class name -> extra RAM++ entity tags that mean the same thing, since the two
# taxonomies name things differently. The gate matches the COCO class OR any synonym
# against the asset's entities[]; the emitted sprite is named with the matched entities[]
# tag (so it equals a real recurrence key). Lowercase throughout.
COCO_SYNONYMS: dict[str, tuple[str, ...]] = {
    "person": ("man", "woman", "people", "figure", "child", "boy", "girl", "portrait"),
    "tv": ("television", "screen", "monitor"),
    "couch": ("sofa",),
    "airplane": ("aeroplane", "plane", "aircraft"),
    "motorcycle": ("motorbike",),
    "potted plant": ("plant", "flower", "pottedplant"),
    "dining table": ("table",),
    "cell phone": ("phone",),
    "boat": ("ship", "sailboat"),
    "bicycle": ("bike",),
}


def pick_track_targets(manifest: dict[str, Any], max_n: int) -> list[dict]:
    """Video assets eligible for track-based cutouts: have shots[] AND entities[]. Pure.

    Order follows manifest order (deterministic); unlike sprite_clips we don't pre-pick an
    entity — ByteTrack decides which object recurs most, and the gate decides if it's kept.
    """
    out: list[dict] = []
    for a in manifest.get("assets", []):
        if a.get("type") == "video" and a.get("shots") and a.get("entities"):
            out.append(a)
            if len(out) >= max_n:
                break
    return out


def resolve_entity(coco_name: str, asset_entities: list[str]) -> str | None:
    """The RAM++ entity tag to name this cutout, or None if the class doesn't recur here.

    Gate-on-intersection: returns the asset's own entities[] string that matches the COCO
    class (or a synonym), so the sprite's `entity` is a real recurrence key. Deterministic;
    prefers the direct COCO-name match over a synonym. Pure.
    """
    coco_name = coco_name.lower()
    if not coco_name or coco_name in {"__background__", "n/a"} or coco_name in _SKIP:
        return None
    lower_to_original = {e.lower(): e for e in asset_entities}
    for candidate in (coco_name, *COCO_SYNONYMS.get(coco_name, ())):
        if candidate in lower_to_original:
            return lower_to_original[candidate]
    return None


def longest_track(tracks: dict[int, dict[str, object]]) -> tuple[int, dict[str, object]] | None:
    """The (tracker_id, track) with the most tracked frames, or None if empty. Pure.

    Tie-break on lowest tracker_id for determinism.
    """
    if not tracks:
        return None
    tid = min(tracks, key=lambda t: (-len(tracks[t]["frames"]), t))  # type: ignore[arg-type]
    return tid, tracks[tid]


def dominant_class_id(class_ids: list[int]) -> int | None:
    """Most frequent class id across a track (lowest id breaks ties). Pure."""
    if not class_ids:
        return None
    from collections import Counter

    counts = Counter(class_ids)
    return min(counts, key=lambda c: (-counts[c], c))


def _ordered_frame_masks(track: dict[str, object]) -> list[tuple[int, np.ndarray]]:
    """(frame_index, mask) pairs for a track, in frame order."""
    frames: dict[int, np.ndarray] = track["frames"]  # type: ignore[assignment]
    return [(i, frames[i]) for i in sorted(frames)]


def build_track_sprites(
    manifest: dict[str, Any], out_dir: Path, max_n: int, n_frames: int
) -> tuple[list[dict], dict]:
    """Returns (entity_sprites, local_png_by_id). Needs the `track` extra + ffmpeg."""
    try:
        from PIL import Image

        from trackfx.detector import build_detector
        from trackfx.tracking import collect_track_masks
    except ImportError:
        print("[track] needs the `track` extra (trackfx: torch + torchvision + supervision) — nothing built")
        return [], {}

    detector = build_detector("maskrcnn", device="auto", conf_threshold=0.5)
    frames_dir = out_dir / "frames"
    sheet_dir = out_dir / "sheets"
    sheet_dir.mkdir(parents=True, exist_ok=True)

    sprites: list[dict] = []
    local: dict[str, Path] = {}
    for asset in pick_track_targets(manifest, max_n):
        shot = asset["shots"][0]
        paths = _extract_frames(asset["src"], shot["start"], shot["end"], n_frames, frames_dir, asset["id"])
        if len(paths) < MIN_TRACK_FRAMES:
            print(f"[track] too few frames for {asset['id']}")
            continue
        try:
            imgs = [Image.open(p).convert("RGB") for p in paths]
            # trackfx's detector expects BGR (it flips to RGB internally); masks come back
            # aligned to these exact pixels, so no resize between here and cutout.
            bgr_frames = [np.asarray(im)[:, :, ::-1].copy() for im in imgs]
            tracks = collect_track_masks(bgr_frames, detector, frame_rate=DEFAULT_FPS)
            picked = longest_track(tracks)
            if picked is None:
                print(f"[track] no tracks in {asset['id']}")
                continue
            _, track = picked
            ordered = _ordered_frame_masks(track)
            if len(ordered) < MIN_TRACK_FRAMES:
                print(f"[track] longest track too short in {asset['id']}")
                continue
            class_id = dominant_class_id(track["class_ids"])  # type: ignore[arg-type]
            coco_name = detector.class_names[class_id] if class_id is not None else ""
            entity = resolve_entity(coco_name, asset["entities"])
            if entity is None:
                print(f"[track] tracked '{coco_name}' not in {asset['id']} entities — skipping (gate)")
                continue

            masks = [m for _, m in ordered]
            ub = union_box(masks)
            if ub is None:
                continue
            frame_imgs = [imgs[i] for i, _ in ordered]
            cells = [cutout_from_mask(im, ub, m) for im, m in zip(frame_imgs, masks)]
            cols, _ = grid_dims(len(cells))
            sheet, cw, ch = assemble_sheet(cells, cols)
        except Exception as e:  # noqa: BLE001
            print(f"[track] WARN {asset['id']}: {e}")
            continue

        sid = f"track-{entity.replace(' ', '-')}-{asset['id']}"
        png = sheet_dir / f"{sid}.png"
        sheet.save(png)
        local[sid] = png
        sprites.append({
            "id": sid, "entity": entity, "src": f"sprite/{sid}.png",
            "aspect": round(cw / max(1, ch), 4), "frames": len(cells), "cols": cols, "fps": DEFAULT_FPS,
            "source": asset["source"], "license": asset["license"],
            **({"attribution": asset["attribution"]} if asset.get("attribution") else {}),
            **({"attributionUrl": asset["attributionUrl"]} if asset.get("attributionUrl") else {}),
        })
        print(f"[track] {sid}: {len(cells)} frames {cw}x{ch} from {asset['id']}")
    return sprites, local


def load_manifest(path: Path | None, url: str | None) -> dict[str, Any]:
    if path and path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    fetch_url = url or DEFAULT_MANIFEST_URL
    print(f"[track] fetching {fetch_url}")
    resp = requests.get(fetch_url, timeout=120)
    resp.raise_for_status()
    return resp.json()


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="DREAMREEL entity cutouts via trackfx (Mask R-CNN + ByteTrack)")
    ap.add_argument("--manifest", type=Path, default=None)
    ap.add_argument("--url", type=str, default=None)
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--max", type=int, default=8, help="max tracked cutouts to build")
    ap.add_argument("--frames", type=int, default=12, help="frames sampled per shot")
    ap.add_argument("--upload", action="store_true", help="upload sheets + manifest to R2 (R2_* env)")
    args = ap.parse_args()

    manifest = load_manifest(args.manifest, args.url)
    sprites, local = build_track_sprites(manifest, args.out / "track_work", args.max, args.frames)
    manifest["entitySprites"] = list(manifest.get("entitySprites", [])) + sprites
    manifest["version"] = datetime.now(timezone.utc).strftime("%Y.%m.%d-%H%M")
    manifest["createdAt"] = datetime.now(timezone.utc).isoformat()
    print(f"[track] built {len(sprites)} tracked cutouts (entitySprites now {len(manifest['entitySprites'])})")

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"[track] wrote {args.out / 'manifest.json'}: v{manifest['version']}")

    if args.upload:
        if not sprites:
            raise SystemExit("[track] refusing to upload: no cutouts built")
        required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE")
        missing = [k for k in required if not os.environ.get(k)]
        if missing:
            raise SystemExit(f"[track] --upload requires R2 env: {missing}")
        from publish.upload_r2 import publish_manifest, upload_media, write_local_copy

        urls = upload_media(local)
        for s in sprites:
            if s["id"] in urls:
                s["src"] = urls[s["id"]]
        out_urls = publish_manifest(manifest, {})
        write_local_copy(manifest, args.out)
        print(f"[track] published {len(urls)} sheets + manifest: {out_urls}")


if __name__ == "__main__":
    main()
