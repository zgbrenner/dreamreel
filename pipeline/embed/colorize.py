"""Bake COLORIZED variants of public-domain vintage clips via DeOldify (a "dream turns to color").

The offline pass fetches each B/W film clip, explodes it to frames with ffmpeg, runs DeOldify's
image colorizer frame-by-frame, and reassembles a web-ready H.264 mp4 (`color-<id>.mp4`) that
lands next to the media on R2. Its URL is baked as `colorSrc`. Absent `colorSrc` the runtime
falls back to `src`, exactly as before — legacy manifests are unaffected. The runtime stages a
rare, seeded "dream turns to color" moment on a gentle beat when `colorSrc` exists (and simply
plays `src` otherwise).

License note (hard constraint, commercial product): DeOldify (github.com/jantic/DeOldify) ships
its CODE **and** its pretrained weights BOTH under the MIT license — unusually permissive, so it
is ship-safe to run in our pipeline. The repo was archived in Oct 2024 (read-only / frozen, but
still usable) and requires Linux + a GPU (4GB+) + the fastai/PyTorch stack. It runs ONLY in this
offline pipeline, NEVER at runtime, and is integrated behind a lazy import so CI and the
license/manifest tests never load it (they inject fakes instead).

⚠ Cost note: colorized variants roughly DOUBLE per-clip R2 storage — run with --limit first and
measure before a full pass. Colorization is also slow (a model pass per frame). Only `type=="video"`
assets are targeted for now — the moving image is the headline; stills stay B/W flash-frames.

Usage (from pipeline/, needs the `colorize` extra + ffmpeg on PATH):
    python -m embed.colorize --out out --limit 2               # smoke a few
    python -m embed.colorize --out out --only-missing --upload  # bake + ship (needs R2_* env)
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import requests

DEFAULT_MANIFEST_URL = (
    "https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json"
)
TARGET_FPS = 24
DEFAULT_RENDER_FACTOR = 21  # DeOldify quality/vram knob; higher = crisper color, slower
MIN_OUTPUT_BYTES = 16 * 1024  # a sub-16KB mp4 is a broken/empty encode, not a clip
FFMPEG_TIMEOUT_S = 600  # frame extract / reassemble; give each ffmpeg step up to 10 minutes
FRAME_GLOB = "frame-*.png"
FRAME_PATTERN = "frame-%06d.png"  # zero-padded so lexical == numeric order for reassembly

# (in_png, out_png[, render_factor]) -> ok. render_factor carries a default, so a 2-arg call is fine.
ColorizeFn = Callable[..., bool]
ExtractFn = Callable[[Path, Path, int], "list[Path]"]
AssembleFn = Callable[[Path, Path, Path, int], "Path | None"]


# --- pure argv builders (unit-tested) ----------------------------------------------------------


def build_extract_frames_cmd(src: Path, frames_dir: Path, fps: int = TARGET_FPS) -> list[str]:
    """ffmpeg argv to explode a clip into zero-padded numbered PNG frames at `fps`. Pure."""
    return [
        "ffmpeg", "-y",
        "-i", str(src),
        "-vf", f"fps={fps:g}",
        str(Path(frames_dir) / FRAME_PATTERN),
    ]


def build_colorize_video_cmd(
    src: Path,
    colorized_frames_dir: Path,
    dst: Path,
    fps: int = TARGET_FPS,
) -> list[str]:
    """ffmpeg argv to reassemble colorized frames into a web-ready H.264 mp4. Pure; unit-tested.

    Reads the numbered PNG sequence at `fps` (input 0) and re-muxes the ORIGINAL audio from `src`
    (input 1) with an optional map (`1:a:0?`) so a silent source degrades gracefully. Because both
    extract and reassemble resample to the same `fps`, clip duration is preserved and audio stays
    in sync. Encoded yuv420p + `+faststart` so it streams; the runtime may still mute in favor of
    the generative bed.
    """
    pattern = str(Path(colorized_frames_dir) / FRAME_PATTERN)
    return [
        "ffmpeg", "-y",
        "-framerate", f"{fps:g}",
        "-i", pattern,
        "-i", str(src),
        "-map", "0:v:0",
        "-map", "1:a:0?",
        "-c:v", "libx264", "-crf", "20", "-preset", "medium",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-shortest", "-movflags", "+faststart",
        str(dst),
    ]


# --- lazy DeOldify colorizer (faked in tests) --------------------------------------------------


def _make_colorizer() -> tuple[ColorizeFn | None, bool]:
    """Lazy DeOldify image colorizer. Returns (colorize_fn, ok) or (None, False).

    colorize_fn(in_png, out_png, render_factor=21) -> bool colorizes a single PNG frame, writing
    the color result to out_png; it returns False (never raises) on any model failure. If DeOldify
    isn't importable or the model can't be built (no GPU/weights), returns (None, False).
    """
    try:
        from deoldify.visualize import get_image_colorizer
    except ImportError:
        return None, False

    try:
        colorizer = get_image_colorizer(artistic=True)
    except Exception as e:  # noqa: BLE001 — model build downloads weights / needs a GPU
        print(f"[colorize] note: DeOldify present but colorizer build failed: {e}")
        return None, False

    def colorize(in_png: Path, out_png: Path, render_factor: int = DEFAULT_RENDER_FACTOR) -> bool:
        try:
            img = colorizer.get_transformed_image(
                path=str(in_png), render_factor=render_factor, watermarked=False
            )
            if img is None:
                return False
            out_png.parent.mkdir(parents=True, exist_ok=True)
            img.save(out_png)
            return out_png.exists() and out_png.stat().st_size > 0
        except Exception as e:  # noqa: BLE001
            print(f"[colorize] WARN colorization failed for {in_png.name}: {e}")
            return False

    return colorize, True


# --- media plumbing (subprocess; overridable in tests) -----------------------------------------


def _extract_frames(src: Path, frames_dir: Path, fps: int = TARGET_FPS) -> list[Path]:
    """Explode a clip to numbered PNGs via ffmpeg; returns the sorted frame paths ([] on failure)."""
    frames_dir.mkdir(parents=True, exist_ok=True)
    cmd = build_extract_frames_cmd(src, frames_dir, fps)
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=FFMPEG_TIMEOUT_S)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as e:
        print(f"[colorize] WARN frame extraction failed: {type(e).__name__}")
        return []
    return sorted(frames_dir.glob(FRAME_GLOB))


def _assemble_video(src: Path, colorized_frames_dir: Path, dst: Path, fps: int = TARGET_FPS) -> Path | None:
    """Reassemble colorized frames into an mp4 via ffmpeg; returns dst, or None on ffmpeg failure."""
    cmd = build_colorize_video_cmd(src, colorized_frames_dir, dst, fps)
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=FFMPEG_TIMEOUT_S)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as e:
        print(f"[colorize] WARN reassembly failed: {type(e).__name__}")
        return None
    return dst


def colorize_video(
    src: Path,
    work_dir: Path,
    asset_id: str,
    colorize_fn: ColorizeFn,
    fps: int = TARGET_FPS,
    extract_fn: ExtractFn | None = None,
    assemble_fn: AssembleFn | None = None,
) -> Path | None:
    """Extract → colorize each frame → reassemble to `color-<asset_id>.mp4`.

    Returns None on any failure (no frames, a failed frame, ffmpeg error) or a sub-16KB output.
    Per-asset raw/colorized frame dirs are temp subdirs of work_dir, always cleaned in a finally.
    extract_fn/assemble_fn default to the ffmpeg subprocess steps but can be injected for tests.
    """
    work_dir.mkdir(parents=True, exist_ok=True)
    raw_dir = work_dir / f"frames-raw-{asset_id}"
    col_dir = work_dir / f"frames-col-{asset_id}"
    dst = work_dir / f"color-{asset_id}.mp4"
    extract = extract_fn or _extract_frames
    assemble = assemble_fn or _assemble_video
    try:
        raw_dir.mkdir(parents=True, exist_ok=True)
        col_dir.mkdir(parents=True, exist_ok=True)

        frames = extract(src, raw_dir, fps)
        if not frames:
            print(f"[colorize] WARN no frames extracted for {asset_id}")
            return None

        for frame in frames:
            out_png = col_dir / frame.name
            if not colorize_fn(frame, out_png):
                print(f"[colorize] WARN colorization failed on a frame of {asset_id} — dropped")
                return None

        result = assemble(src, col_dir, dst, fps)
        if result is None or not result.exists() or result.stat().st_size < MIN_OUTPUT_BYTES:
            print(f"[colorize] WARN output missing/too small for {asset_id} — dropped")
            return None
        return result
    finally:
        shutil.rmtree(raw_dir, ignore_errors=True)
        shutil.rmtree(col_dir, ignore_errors=True)


def _ensure_local(src: str, dest_dir: Path, asset_id: str) -> Path | None:
    ext = os.path.splitext(src.split("?")[0])[1] or ".mp4"
    dest = dest_dir / f"{asset_id}{ext}"
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    try:
        r = requests.get(src, timeout=120)
        r.raise_for_status()
        dest.write_bytes(r.content)
        return dest
    except Exception as e:  # noqa: BLE001
        print(f"[colorize] WARN could not fetch {asset_id}: {e}")
        return None


# --- manifest augmentation ---------------------------------------------------------------------


def annotate(
    manifest: dict[str, Any],
    work_dir: Path,
    limit: int | None = None,
    only_missing: bool = False,
    colorize_fn: ColorizeFn | None = None,
    extract_fn: ExtractFn | None = None,
    assemble_fn: AssembleFn | None = None,
) -> tuple[dict[str, Any], dict[str, Path]]:
    """Bake colorized mp4s for video assets. Returns (manifest copy, {asset_id: mp4 path}).

    `colorSrc` itself is written by apply_urls() after the mp4s are uploaded — a local-only run
    produces the derivatives without touching the manifest fields. colorize_fn/extract_fn/
    assemble_fn are injected in tests so no model/ffmpeg/network is needed; a real run lazily
    builds DeOldify via _make_colorizer and no-ops (empty derivs) when it isn't available.
    """
    out = json.loads(json.dumps(manifest))
    fn = colorize_fn
    if fn is None:
        fn, ok = _make_colorizer()
        if not ok:
            print("[colorize] note: needs the `colorize` extra (DeOldify + torch, Linux+GPU) — nothing baked")
            return out, {}

    videos = [a for a in out.get("assets", []) if a.get("type") == "video" and a.get("src")]
    if only_missing:
        videos = [a for a in videos if not a.get("colorSrc")]
    if limit is not None:
        videos = videos[:limit]

    work_dir.mkdir(parents=True, exist_ok=True)
    derivs: dict[str, Path] = {}
    for a in videos:
        local = _ensure_local(a["src"], work_dir, a["id"])
        if local is None:
            continue
        colored = colorize_video(
            local, work_dir, a["id"], fn, extract_fn=extract_fn, assemble_fn=assemble_fn
        )
        if colored is None:
            continue
        derivs[a["id"]] = colored

    out["version"] = datetime.now(timezone.utc).strftime("%Y.%m.%d-%H%M")
    out["createdAt"] = datetime.now(timezone.utc).isoformat()
    return out, derivs


def apply_urls(manifest: dict[str, Any], urls: dict[str, str]) -> int:
    """Set colorSrc from uploaded {asset_id: url}. Returns the number of assets updated. Pure."""
    n = 0
    for a in manifest.get("assets", []):
        url = urls.get(a["id"])
        if url:
            a["colorSrc"] = url
            n += 1
    return n


def load_manifest(path: Path | None, url: str | None) -> dict[str, Any]:
    if path and path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    fetch_url = url or DEFAULT_MANIFEST_URL
    print(f"[colorize] fetching {fetch_url}")
    resp = requests.get(fetch_url, timeout=120)
    resp.raise_for_status()
    return resp.json()


def main() -> None:
    ap = argparse.ArgumentParser(description="DREAMREEL colorized-variant baking (DeOldify)")
    ap.add_argument("--manifest", type=Path, default=None)
    ap.add_argument("--url", type=str, default=None)
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--limit", type=int, default=None, help="bake only the first N videos (smoke)")
    ap.add_argument("--only-missing", action="store_true", help="skip assets that already carry colorSrc")
    ap.add_argument("--upload", action="store_true", help="upload color mp4s + manifest to R2 (needs R2_* env)")
    args = ap.parse_args()

    manifest = load_manifest(args.manifest, args.url)
    work_dir = args.out / "colorize"
    annotated, derivs = annotate(manifest, work_dir, args.limit, args.only_missing)
    total_vid = sum(1 for a in annotated.get("assets", []) if a.get("type") == "video")
    print(f"[colorize] baked {len(derivs)}/{total_vid} colorized variants")

    args.out.mkdir(parents=True, exist_ok=True)

    if args.upload:
        if not derivs:
            raise SystemExit("[colorize] refusing to upload: 0 colorized variants baked")
        required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE")
        missing = [k for k in required if not os.environ.get(k)]
        if missing:
            raise SystemExit(f"[colorize] --upload requires R2 env: {missing}")
        from publish.upload_r2 import publish_manifest, upload_media, write_local_copy

        urls = upload_media(derivs)
        n = apply_urls(annotated, urls)
        print(f"[colorize] colorSrc set on {n} assets")
        pub = publish_manifest(annotated, {})
        write_local_copy(annotated, args.out)
        print(f"[colorize] published: {pub}")

    out_path = args.out / "manifest.json"
    out_path.write_text(json.dumps(annotated, indent=2) + "\n", encoding="utf-8")
    print(f"[colorize] wrote {out_path}: v{annotated['version']}")


if __name__ == "__main__":
    main()
