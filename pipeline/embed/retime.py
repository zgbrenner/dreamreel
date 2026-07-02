"""Bake dreamy SLOW-MOTION variants of film clips via ffmpeg motion-compensated interpolation.

Uses ffmpeg's built-in `minterpolate` filter (mci/aobmc, no new ML deps — ffmpeg is already a
pipeline requirement): the clip is motion-interpolated up to `target_fps * slow_factor`, then
PTS-stretched by `slow_factor` and emitted at `target_fps`, so motion reads as fluid dream-slow
rather than a strobed frame-hold. Audio is dropped (`-an`) — slow-motion audio is unusable.
The mp4 lands next to the media on R2 and its URL is baked as `slowSrc`; absent `slowSrc` the
runtime falls back to `src`, exactly as before — legacy manifests are unaffected.

⚠ Cost note: slow variants roughly DOUBLE per-clip R2 storage — run with --limit first and
measure before a full pass. minterpolate is also CPU-slow (minutes per clip). At runtime the
app picks the slow variant deterministically on tender/nostalgic low-intensity beats and falls
back to `src` when `slowSrc` is absent.

Usage (from pipeline/, needs ffmpeg on PATH):
    python -m embed.retime --out out --limit 3               # smoke a few
    python -m embed.retime --out out --only-missing --upload  # bake + ship (needs R2_* env)
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import requests

DEFAULT_MANIFEST_URL = (
    "https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json"
)
SLOW_FACTOR = 2.0
TARGET_FPS = 24
MIN_OUTPUT_BYTES = 16 * 1024  # a sub-16KB mp4 is a broken/empty encode, not a clip
FFMPEG_TIMEOUT_S = 600  # minterpolate is slow; give each clip up to 10 minutes

RetimeFn = Callable[[Path, Path, str], "Path | None"]


def build_retime_cmd(
    src: Path,
    dst: Path,
    slow_factor: float = SLOW_FACTOR,
    target_fps: int = TARGET_FPS,
) -> list[str]:
    """ffmpeg argv for a motion-compensated slow-motion variant. Pure; unit-tested.

    minterpolate synthesizes intermediate frames up to target_fps*slow_factor, then setpts
    stretches presentation time by slow_factor and -r resamples to target_fps — fluid slow
    motion, not a strobed frame-hold. Video-only (-an): slow-motion audio is unusable.
    """
    interp_fps = target_fps * slow_factor
    vf = (
        f"minterpolate=fps={interp_fps:g}:mi_mode=mci:mc_mode=aobmc:vsbmc=1,"
        f"setpts={slow_factor:g}*PTS"
    )
    return [
        "ffmpeg", "-y",
        "-i", str(src),
        "-vf", vf,
        "-r", str(target_fps),
        "-c:v", "libx264", "-crf", "26", "-preset", "medium",
        "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart",
        str(dst),
    ]


def retime_video(
    src: Path,
    dst_dir: Path,
    asset_id: str,
    slow_factor: float = SLOW_FACTOR,
) -> Path | None:
    """Run ffmpeg to produce slow-<asset_id>.mp4. Returns None on failure or a tiny output."""
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / f"slow-{asset_id}.mp4"
    cmd = build_retime_cmd(src, dst, slow_factor)
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=FFMPEG_TIMEOUT_S)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as e:
        print(f"[retime] WARN ffmpeg failed for {asset_id}: {type(e).__name__}")
        return None
    if not dst.exists() or dst.stat().st_size < MIN_OUTPUT_BYTES:
        print(f"[retime] WARN output too small for {asset_id} — dropped")
        return None
    return dst


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
        print(f"[retime] WARN could not fetch {asset_id}: {e}")
        return None


def annotate(
    manifest: dict[str, Any],
    work_dir: Path,
    limit: int | None = None,
    only_missing: bool = False,
    retime_fn: RetimeFn | None = None,
) -> tuple[dict[str, Any], dict[str, Path]]:
    """Bake slow-motion mp4s for video assets. Returns (manifest copy, {asset_id: mp4 path}).

    `slowSrc` itself is written by apply_urls() after the mp4s are uploaded — a local-only run
    produces the derivatives without touching the manifest fields.
    """
    out = json.loads(json.dumps(manifest))
    fn = retime_fn or retime_video

    videos = [a for a in out.get("assets", []) if a.get("type") == "video" and a.get("src")]
    if only_missing:
        videos = [a for a in videos if not a.get("slowSrc")]
    if limit is not None:
        videos = videos[:limit]

    work_dir.mkdir(parents=True, exist_ok=True)
    derivs: dict[str, Path] = {}
    for a in videos:
        local = _ensure_local(a["src"], work_dir, a["id"])
        if local is None:
            continue
        slow = fn(local, work_dir, a["id"])
        if slow is None:
            continue
        derivs[a["id"]] = slow

    out["version"] = datetime.now(timezone.utc).strftime("%Y.%m.%d-%H%M")
    out["createdAt"] = datetime.now(timezone.utc).isoformat()
    return out, derivs


def apply_urls(manifest: dict[str, Any], urls: dict[str, str]) -> int:
    """Set slowSrc from uploaded {asset_id: url}. Returns the number of assets updated. Pure."""
    n = 0
    for a in manifest.get("assets", []):
        url = urls.get(a["id"])
        if url:
            a["slowSrc"] = url
            n += 1
    return n


def load_manifest(path: Path | None, url: str | None) -> dict[str, Any]:
    if path and path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    fetch_url = url or DEFAULT_MANIFEST_URL
    print(f"[retime] fetching {fetch_url}")
    resp = requests.get(fetch_url, timeout=120)
    resp.raise_for_status()
    return resp.json()


def main() -> None:
    ap = argparse.ArgumentParser(
        description="DREAMREEL slow-motion baking (ffmpeg minterpolate)"
    )
    ap.add_argument("--manifest", type=Path, default=None)
    ap.add_argument("--url", type=str, default=None)
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--limit", type=int, default=None, help="bake only the first N videos (smoke)")
    ap.add_argument("--only-missing", action="store_true", help="skip assets that already carry slowSrc")
    ap.add_argument("--upload", action="store_true", help="upload slow mp4s + manifest to R2 (needs R2_* env)")
    args = ap.parse_args()

    manifest = load_manifest(args.manifest, args.url)
    work_dir = args.out / "retime"
    annotated, derivs = annotate(manifest, work_dir, args.limit, args.only_missing)
    total_vid = sum(1 for a in annotated.get("assets", []) if a.get("type") == "video")
    print(f"[retime] baked {len(derivs)}/{total_vid} slow-motion variants")

    args.out.mkdir(parents=True, exist_ok=True)

    if args.upload:
        if not derivs:
            raise SystemExit("[retime] refusing to upload: 0 slow variants baked")
        required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE")
        missing = [k for k in required if not os.environ.get(k)]
        if missing:
            raise SystemExit(f"[retime] --upload requires R2 env: {missing}")
        from publish.upload_r2 import publish_manifest, upload_media, write_local_copy

        urls = upload_media(derivs)
        n = apply_urls(annotated, urls)
        print(f"[retime] slowSrc set on {n} assets")
        pub = publish_manifest(annotated, {})
        write_local_copy(annotated, args.out)
        print(f"[retime] published: {pub}")

    out_path = args.out / "manifest.json"
    out_path.write_text(json.dumps(annotated, indent=2) + "\n", encoding="utf-8")
    print(f"[retime] wrote {out_path}: v{annotated['version']}")


if __name__ == "__main__":
    main()
