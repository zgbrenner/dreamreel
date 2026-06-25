"""Animated entity cutouts via SAM 2 VIDEO tracking — a recurring figure that actually MOVES.

For video assets that carry shots[], this extracts a shot's frames, finds the entity in frame 0
(Grounding DINO), tracks its mask across all frames (SAM 2 video), crops every frame to the union
box so the figure moves WITHIN a fixed cell, and assembles the per-frame RGBA cutouts into a grid
sprite SHEET PNG. The baked EntitySprite gets `frames`/`cols`/`fps`, and the runtime SpriteField
cycles the sheet so the segmented figure walks/flaps as it drifts back into a later dream.

Builds on embed/sprites.py (Grounding DINO box + cutout). The grid/union-box helpers are pure and
unit-tested; tracking lazy-imports the `sprites` extra (transformers SAM 2 video) + needs ffmpeg.
Appends animated sprites to the manifest's entitySprites[] pool (manifest-only reship after upload).

Usage (from pipeline/, needs the `sprites` extra + ffmpeg):
    python -m embed.sprite_clips --out out --max 8 --frames 12
    python -m embed.sprite_clips --manifest out/manifest.json --out out --max 8 --upload
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit

import numpy as np
import requests

from embed.sprites import GDINO_ID, _box_ok, cutout_from_mask, detect_box

DEFAULT_MANIFEST_URL = (
    "https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json"
)
SAM2_VIDEO_ID = "facebook/sam2.1-hiera-small"
DEFAULT_FPS = 10


def grid_dims(n: int, max_cols: int = 4) -> tuple[int, int]:
    """(cols, rows) for an n-frame sheet. Pure."""
    cols = min(max_cols, max(1, n))
    rows = math.ceil(n / cols)
    return cols, rows


def union_box(masks: list[np.ndarray]) -> tuple[int, int, int, int] | None:
    """Bounding box (x0,y0,x1,y1) covering all True pixels across every frame mask. Pure."""
    ys: list[np.ndarray] = []
    xs: list[np.ndarray] = []
    for m in masks:
        idx = np.argwhere(m)
        if idx.size:
            ys.append(idx[:, 0])
            xs.append(idx[:, 1])
    if not ys:
        return None
    y = np.concatenate(ys)
    x = np.concatenate(xs)
    return int(x.min()), int(y.min()), int(x.max()) + 1, int(y.max()) + 1


def assemble_sheet(cells: list, cols: int):
    """Paste equal-size RGBA cells into a cols×rows grid sheet (PIL). Returns (sheet, cell_w, cell_h)."""
    from PIL import Image

    cw = max(c.width for c in cells)
    ch = max(c.height for c in cells)
    rows = math.ceil(len(cells) / cols)
    sheet = Image.new("RGBA", (cw * cols, ch * rows), (0, 0, 0, 0))
    for i, c in enumerate(cells):
        r, col = divmod(i, cols)
        sheet.paste(c, (col * cw, r * ch), c)  # cells are uniform (all cropped to the union box)
    return sheet, cw, ch


def _encode_url(u: str) -> str:
    p = urlsplit(u)
    return urlunsplit((p.scheme, p.netloc, quote(p.path), p.query, p.fragment))


def _extract_frames(src: str, start: float, end: float, n: int, dest_dir: Path, key: str) -> list[Path]:
    """ffmpeg-sample n evenly-spaced frames in [start,end] (absolute film seconds)."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    span = max(0.5, end - start)
    for i in range(n):
        t = start + span * (i / max(1, n - 1))
        out = dest_dir / f"{key}_{i:02d}.png"
        if not (out.exists() and out.stat().st_size > 0):
            cmd = ["ffmpeg", "-y", "-ss", str(t), "-i", _encode_url(src), "-frames:v", "1",
                   "-vf", "scale=512:-2", "-q:v", "3", str(out)]
            try:
                subprocess.run(cmd, check=True, capture_output=True, timeout=120)
            except (subprocess.CalledProcessError, FileNotFoundError, OSError, subprocess.TimeoutExpired):
                continue
        if out.exists() and out.stat().st_size > 0:
            paths.append(out)
    return paths


def _make_models():
    """(gdino_proc, gdino, sam2v_proc, sam2v, torch) or None if the `sprites` extra is missing."""
    try:
        import torch
        from transformers import (
            AutoModelForZeroShotObjectDetection,
            AutoProcessor,
            Sam2VideoModel,
            Sam2VideoProcessor,
        )
    except ImportError:
        return None
    try:
        gp = AutoProcessor.from_pretrained(GDINO_ID)
        gm = AutoModelForZeroShotObjectDetection.from_pretrained(GDINO_ID).eval()
        sp = Sam2VideoProcessor.from_pretrained(SAM2_VIDEO_ID)
        sm = Sam2VideoModel.from_pretrained(SAM2_VIDEO_ID).eval()
        return gp, gm, sp, sm, torch
    except Exception as e:  # noqa: BLE001
        print(f"[clips] model load failed: {e}")
        return None


def track_masks(frames: list, box, sp, sm, torch) -> list[np.ndarray]:
    """SAM 2 video-track the box from frame 0 across all frames → per-frame bool masks (best effort)."""
    session = sp.init_video_session(video=frames, inference_device="cpu")
    sp.add_inputs_to_inference_session(
        inference_session=session, frame_idx=0, obj_ids=1, input_boxes=[[list(box)]]
    )
    out: dict[int, np.ndarray] = {}
    with torch.no_grad():
        for res in sm.propagate_in_video_iterator(session):
            masks = sp.post_process_masks([res.pred_masks], [session.video_height, session.video_width])[0]
            arr = masks.cpu().numpy() if hasattr(masks, "cpu") else np.asarray(masks)
            while arr.ndim > 2:
                arr = arr[0]
            out[int(res.frame_idx)] = arr > 0.0
    return [out[i] for i in sorted(out)]


def _pick_video_targets(manifest: dict[str, Any], max_n: int) -> list[tuple[str, dict]]:
    """(entity, video-asset) pairs: videos with shots + entities, entity = a non-skip tag. Pure-ish."""
    from embed.sprites import _SKIP

    out: list[tuple[str, dict]] = []
    for a in manifest.get("assets", []):
        if a.get("type") != "video" or not a.get("shots") or not a.get("entities"):
            continue
        ent = next((e for e in a["entities"] if e not in _SKIP), None)
        if ent is None:
            continue
        out.append((ent, a))
        if len(out) >= max_n:
            break
    return out


def build_clips(manifest, out_dir: Path, max_n: int, n_frames: int) -> tuple[list[dict], dict]:
    from PIL import Image

    models = _make_models()
    if models is None:
        print("[clips] needs the `sprites` extra (transformers SAM 2 video + torch) — nothing built")
        return [], {}
    gp, gm, sp, sm, torch = models
    frames_dir = out_dir / "frames"
    sheet_dir = out_dir / "sheets"
    sheet_dir.mkdir(parents=True, exist_ok=True)

    sprites: list[dict] = []
    local: dict[str, Path] = {}
    for entity, asset in _pick_video_targets(manifest, max_n):
        shot = asset["shots"][0]
        paths = _extract_frames(asset["src"], shot["start"], shot["end"], n_frames, frames_dir, asset["id"])
        if len(paths) < 4:
            print(f"[clips] too few frames for {asset['id']}")
            continue
        try:
            imgs = [Image.open(p).convert("RGB") for p in paths]
            box = detect_box(imgs[0], entity, gp, gm, torch)
            if box is None or not _box_ok(box, imgs[0].width, imgs[0].height):
                print(f"[clips] no box for '{entity}' in {asset['id']} frame 0")
                continue
            masks = track_masks(imgs, box, sp, sm, torch)
            ub = union_box(masks)
            if ub is None:
                continue
            cells = [cutout_from_mask(im, ub, m) for im, m in zip(imgs, masks)]
            cols, _ = grid_dims(len(cells))
            sheet, cw, ch = assemble_sheet(cells, cols)
        except Exception as e:  # noqa: BLE001
            print(f"[clips] WARN '{entity}' {asset['id']}: {e}")
            continue
        sid = f"clip-{entity.replace(' ', '-')}-{asset['id']}"
        png = sheet_dir / f"{sid}.png"
        sheet.save(png)
        local[sid] = png
        sprites.append({
            "id": sid, "entity": entity, "src": f"sprite/{sid}.png",
            "aspect": round(cw / max(1, ch), 4), "frames": len(cells), "cols": cols, "fps": DEFAULT_FPS,
            "source": asset["source"], "license": asset["license"],
            **({"attribution": asset["attribution"]} if asset.get("attribution") else {}),
        })
        print(f"[clips] {sid}: {len(cells)} frames {cw}x{ch} from {asset['id']}")
    return sprites, local


def load_manifest(path: Path | None, url: str | None) -> dict[str, Any]:
    if path and path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    fetch_url = url or DEFAULT_MANIFEST_URL
    print(f"[clips] fetching {fetch_url}")
    resp = requests.get(fetch_url, timeout=120)
    resp.raise_for_status()
    return resp.json()


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="DREAMREEL animated entity cutouts (SAM 2 video tracking)")
    ap.add_argument("--manifest", type=Path, default=None)
    ap.add_argument("--url", type=str, default=None)
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--max", type=int, default=8, help="max animated cutouts to build")
    ap.add_argument("--frames", type=int, default=12, help="frames per animated cutout")
    ap.add_argument("--upload", action="store_true", help="upload sheets + manifest to R2 (R2_* env)")
    args = ap.parse_args()

    manifest = load_manifest(args.manifest, args.url)
    clips, local = build_clips(manifest, args.out / "clips_work", args.max, args.frames)
    manifest["entitySprites"] = list(manifest.get("entitySprites", [])) + clips
    manifest["version"] = datetime.now(timezone.utc).strftime("%Y.%m.%d-%H%M")
    manifest["createdAt"] = datetime.now(timezone.utc).isoformat()
    print(f"[clips] built {len(clips)} animated cutouts (entitySprites now {len(manifest['entitySprites'])})")

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"[clips] wrote {args.out / 'manifest.json'}: v{manifest['version']}")

    if args.upload:
        if not clips:
            raise SystemExit("[clips] refusing to upload: no animated cutouts built")
        required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE")
        missing = [k for k in required if not os.environ.get(k)]
        if missing:
            raise SystemExit(f"[clips] --upload requires R2 env: {missing}")
        from publish.upload_r2 import publish_manifest, upload_media, write_local_copy

        urls = upload_media(local)
        for s in clips:
            if s["id"] in urls:
                s["src"] = urls[s["id"]]
        out_urls = publish_manifest(manifest, {})
        write_local_copy(manifest, args.out)
        print(f"[clips] published {len(urls)} sheets + manifest: {out_urls}")


if __name__ == "__main__":
    main()
