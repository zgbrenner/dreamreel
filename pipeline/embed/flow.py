"""Bake per-video OPTICAL-FLOW metadata (RAFT-Small via torchvision — BSD-3, weights included).

Motion metadata unlocks the runtime's motion-aware effects: the offline pass samples a frame
pair near each clip's head (the IN signature) and one near its tail (the OUT signature), runs
RAFT optical flow on each pair, and bakes a compact `motion` blob onto the video asset plus a
tiny RG-encoded flow PNG (`flowSrc`) the compositor can sample as a displacement hint. Absent
`motion`/`flowSrc` the runtime behaves exactly as before — legacy manifests are unaffected.

Manifest field shapes (frozen; mirror these in the app schema):
    motion:  { energy: float 0..1 (rounded 3),   # mean pair magnitude / frame diagonal
               inSig:  [9 floats, rounded 4],    # head-of-clip signature (see flow_signature)
               outSig: [9 floats, rounded 4] }   # tail-of-clip signature
    flowSrc: str URL                             # OUT-flow RG PNG (see flow_to_png encoding)

License note (commercial product): torchvision is BSD-3 and distributes the RAFT-Small
weights itself (`Raft_Small_Weights.DEFAULT`) — no extra weight license to clear.

The model step lazy-imports torch + torchvision (the `flow` extra) and frame extraction
shells out to ffmpeg/ffprobe, so CI and the license/manifest tests never need them; the
signature/encoding math is pure and unit-tested with injected fakes.

Usage (from pipeline/, needs the `flow` extra + ffmpeg):
    python -m embed.flow --out out --limit 3                # smoke a few
    python -m embed.flow --out out --only-missing --upload  # bake + ship (needs R2_* env)
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import numpy as np
import requests

DEFAULT_MANIFEST_URL = (
    "https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json"
)

DOWNSCALE = 8          # flow PNG at 1/8 the flow-field resolution — a displacement *hint*
FRAME_WIDTH = 384      # frames are extracted downscaled (RAFT on CPU; signatures are scale-free)
SIG_BINS = 8           # direction histogram bins (bin k centered at k*pi/4, bin 0 = rightward)
IN_PAIR = (0.5, 0.9)   # head-of-clip sample times (deployed clips are short, ~12 s)
OUT_FALLBACK = (8.0, 8.4)  # tail pair when ffprobe cannot report a duration

FlowFn = Callable[[np.ndarray, np.ndarray], "np.ndarray | None"]
ExtractFn = Callable[[Path, "list[float]"], "list[np.ndarray | None]"]
ProbeFn = Callable[[Path], "float | None"]


# --- pure math (unit-tested) -------------------------------------------------------------------


def _diag(flow: np.ndarray) -> float:
    h, w = flow.shape[0], flow.shape[1]
    return float(np.hypot(w, h))


def flow_signature(flow: np.ndarray) -> list[float]:
    """Compact 9-float motion signature of an HxWx2 pixel-displacement field. Pure, deterministic.

    Floats 0..7: an 8-bin direction histogram — bin k is centered at angle k*pi/4 of
    arctan2(dy, dx), so bin 0 is rightward flow — weighted by vector magnitude and normalized
    to sum 1 (an all-zero field yields uniform 1/8 bins). Float 8: mean vector magnitude
    normalized by the frame diagonal (hypot(W, H)).
    """
    f = np.asarray(flow, dtype=np.float64)
    dx, dy = f[..., 0], f[..., 1]
    mag = np.hypot(dx, dy)
    angle = np.arctan2(dy, dx)
    bins = (np.floor((angle + np.pi / SIG_BINS) / (2.0 * np.pi / SIG_BINS)).astype(np.int64)) % SIG_BINS
    hist = np.bincount(bins.ravel(), weights=mag.ravel(), minlength=SIG_BINS)[:SIG_BINS]
    total = float(hist.sum())
    if total < 1e-12:
        hist = np.full(SIG_BINS, 1.0 / SIG_BINS)
    else:
        hist = hist / total
    mean_mag = float(mag.mean()) / _diag(f)
    return [float(x) for x in hist] + [mean_mag]


def motion_energy(flow: np.ndarray) -> float:
    """Mean flow magnitude normalized by the frame diagonal, clamped to 0..1. Pure."""
    f = np.asarray(flow, dtype=np.float64)
    e = float(np.hypot(f[..., 0], f[..., 1]).mean()) / _diag(f)
    return min(1.0, max(0.0, e))


def flow_to_png(flow: np.ndarray, dest: Path, downscale: int = DOWNSCALE) -> Path:
    """Quantize an HxWx2 flow field into a downscaled RG uint8 PNG (B=0) at `dest`.

    Encoding (the runtime shader decodes with the inverse): per component,
        value = clamp(component / (0.1 * diag) * 0.5 + 0.5, 0, 1) * 255
    where diag = hypot(W, H) of the FULL-resolution flow field (before downscale — the runtime
    can recover it as hypot(png_w, png_h) * downscale). R encodes dx, G encodes dy, B is 0.
    Decode: component = (value / 255 - 0.5) * 2 * 0.1 * diag.
    """
    from PIL import Image

    f = np.asarray(flow, dtype=np.float64)
    h, w = f.shape[0], f.shape[1]
    scale = 0.1 * _diag(f)
    enc = np.clip(f / scale * 0.5 + 0.5, 0.0, 1.0)
    rgb = np.zeros((h, w, 3), dtype=np.uint8)
    rgb[..., :2] = np.round(enc * 255.0).astype(np.uint8)
    im = Image.fromarray(rgb, mode="RGB")
    im = im.resize((max(1, w // downscale), max(1, h // downscale)), Image.BILINEAR)
    dest.parent.mkdir(parents=True, exist_ok=True)
    im.save(dest, "PNG", optimize=True)
    return dest


def sample_times(duration: float | None) -> tuple[float, float, float, float]:
    """Frame-pair sample times (in_a, in_b, out_a, out_b) for a clip of `duration` seconds.

    The IN pair sits at the clip head; the OUT pair 1.2s/0.8s before the end. A missing or
    bogus duration (ffprobe failed) falls back to OUT_FALLBACK. Pure.
    """
    in_a, in_b = IN_PAIR
    if duration is None or not np.isfinite(duration) or duration <= 0:
        out_a, out_b = OUT_FALLBACK
    else:
        out_a = max(0.0, duration - 1.2)
        out_b = max(out_a + 0.1, duration - 0.8)
    return in_a, in_b, out_a, out_b


# --- model + media plumbing (lazy; faked in tests) ----------------------------------------------


def _make_flow_model() -> tuple[FlowFn | None, bool]:
    """Lazy RAFT-Small via torchvision. Returns (flow_fn, ok) or (None, False).

    flow_fn(frame_a, frame_b) takes two HxWx3 uint8 RGB frames and returns an HxWx2 float64
    pixel-displacement field (dx, dy), or None on failure.
    """
    try:
        import torch
        import torch.nn.functional as F
        from torchvision.models.optical_flow import Raft_Small_Weights, raft_small
    except ImportError:
        return None, False

    weights = Raft_Small_Weights.DEFAULT
    model = raft_small(weights=weights).eval()
    transforms = weights.transforms()

    def flow(frame_a: np.ndarray, frame_b: np.ndarray) -> np.ndarray | None:
        try:
            if frame_a.shape != frame_b.shape:
                print(f"[flow] WARN frame pair shape mismatch {frame_a.shape} vs {frame_b.shape}")
                return None
            h, w = frame_a.shape[0], frame_a.shape[1]
            a = torch.from_numpy(np.ascontiguousarray(frame_a)).permute(2, 0, 1).unsqueeze(0)
            b = torch.from_numpy(np.ascontiguousarray(frame_b)).permute(2, 0, 1).unsqueeze(0)
            a, b = transforms(a, b)
            h8, w8 = max(8, h // 8 * 8), max(8, w // 8 * 8)  # RAFT wants dims divisible by 8
            if (h8, w8) != (h, w):
                a = F.interpolate(a, size=(h8, w8), mode="bilinear", align_corners=False)
                b = F.interpolate(b, size=(h8, w8), mode="bilinear", align_corners=False)
            with torch.no_grad():
                pred = model(a, b)[-1]  # (1, 2, h8, w8) pixel displacements
            if (h8, w8) != (h, w):
                pred = F.interpolate(pred, size=(h, w), mode="bilinear", align_corners=False)
                pred[:, 0] *= w / w8
                pred[:, 1] *= h / h8
            return pred[0].permute(1, 2, 0).cpu().numpy().astype(np.float64)
        except Exception as e:  # noqa: BLE001
            print(f"[flow] WARN inference failed: {e}")
            return None

    return flow, True


def _probe_duration(video_path: Path) -> float | None:
    """Clip duration in seconds via ffprobe, or None if probing fails."""
    cmd = [
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(video_path),
    ]
    try:
        res = subprocess.run(cmd, check=True, capture_output=True, timeout=60, text=True)
        d = float(res.stdout.strip())
    except (subprocess.CalledProcessError, FileNotFoundError, OSError,
            subprocess.TimeoutExpired, ValueError):
        return None
    return d if np.isfinite(d) and d > 0 else None


def _extract_frames(video_path: Path, times: list[float]) -> list["np.ndarray | None"]:
    """Grab one downscaled RGB frame (HxWx3 uint8) per time via ffmpeg; None where a grab fails."""
    from PIL import Image

    frames: list[np.ndarray | None] = []
    with tempfile.TemporaryDirectory(prefix="flow-frames-") as td:
        for i, t in enumerate(times):
            dest = Path(td) / f"frame-{i}.png"
            cmd = [
                "ffmpeg", "-y", "-ss", f"{max(0.0, t):.3f}", "-i", str(video_path),
                "-frames:v", "1", "-vf", f"scale={FRAME_WIDTH}:-2", str(dest),
            ]
            try:
                subprocess.run(cmd, check=True, capture_output=True, timeout=120)
            except (subprocess.CalledProcessError, FileNotFoundError, OSError,
                    subprocess.TimeoutExpired):
                frames.append(None)
                continue
            if not (dest.exists() and dest.stat().st_size > 0):
                frames.append(None)
                continue
            with Image.open(dest) as im:
                frames.append(np.asarray(im.convert("RGB"), dtype=np.uint8))
    return frames


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
        print(f"[flow] WARN could not fetch {asset_id}: {e}")
        return None


# --- manifest augmentation -----------------------------------------------------------------------


def annotate(
    manifest: dict[str, Any],
    work_dir: Path,
    limit: int | None = None,
    only_missing: bool = False,
    flow_fn: FlowFn | None = None,
    extract_fn: ExtractFn | None = None,
    probe_fn: ProbeFn | None = None,
) -> tuple[dict[str, Any], dict[str, Path]]:
    """Bake `motion` + OUT-flow PNGs for video assets. Returns (manifest copy, {asset_id: png}).

    `motion` ({energy, inSig, outSig}) is set here — it needs no URL; energy is the mean of the
    IN and OUT pair energies. `flowSrc` is written by apply_urls() after the PNGs are uploaded —
    a local-only run produces the derivatives without touching URL fields. An asset is skipped
    (untouched) unless BOTH pairs yield flow, so the motion blob's shape is uniform.
    """
    out = json.loads(json.dumps(manifest))
    fn = flow_fn
    if fn is None:
        fn, ok = _make_flow_model()
        if not ok:
            print("[flow] note: needs the `flow` extra (torch + torchvision) + Pillow — nothing baked")
            return out, {}
    extract = extract_fn or _extract_frames
    probe = probe_fn or _probe_duration

    work_dir.mkdir(parents=True, exist_ok=True)
    videos = [a for a in out.get("assets", []) if a.get("type") == "video" and a.get("src")]
    if only_missing:
        videos = [a for a in videos if not a.get("motion")]
    if limit is not None:
        videos = videos[:limit]

    derivs: dict[str, Path] = {}
    for a in videos:
        local = _ensure_local(a["src"], work_dir, a["id"])
        if local is None:
            continue
        times = list(sample_times(probe(local)))
        frames = list(extract(local, times))
        frames += [None] * (4 - len(frames))
        in_flow = fn(frames[0], frames[1]) if frames[0] is not None and frames[1] is not None else None
        out_flow = fn(frames[2], frames[3]) if frames[2] is not None and frames[3] is not None else None
        if in_flow is None or out_flow is None:
            print(f"[flow] WARN no flow pair for {a['id']} — skipped")
            continue
        energy = (motion_energy(in_flow) + motion_energy(out_flow)) / 2.0
        a["motion"] = {
            "energy": round(energy, 3),
            "inSig": [round(x, 4) for x in flow_signature(in_flow)],
            "outSig": [round(x, 4) for x in flow_signature(out_flow)],
        }
        derivs[a["id"]] = flow_to_png(out_flow, work_dir / f"flow-{a['id']}.png")

    out["version"] = datetime.now(timezone.utc).strftime("%Y.%m.%d-%H%M")
    out["createdAt"] = datetime.now(timezone.utc).isoformat()
    return out, derivs


def apply_urls(manifest: dict[str, Any], urls: dict[str, str]) -> int:
    """Set flowSrc from uploaded {asset_id: url}. Returns the number of assets updated. Pure."""
    n = 0
    for a in manifest.get("assets", []):
        url = urls.get(a["id"])
        if url:
            a["flowSrc"] = url
            n += 1
    return n


def load_manifest(path: Path | None, url: str | None) -> dict[str, Any]:
    if path and path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    fetch_url = url or DEFAULT_MANIFEST_URL
    print(f"[flow] fetching {fetch_url}")
    resp = requests.get(fetch_url, timeout=120)
    resp.raise_for_status()
    return resp.json()


def main() -> None:
    ap = argparse.ArgumentParser(description="DREAMREEL optical-flow baking (RAFT-Small via torchvision)")
    ap.add_argument("--manifest", type=Path, default=None)
    ap.add_argument("--url", type=str, default=None)
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--limit", type=int, default=None, help="bake only the first N videos (smoke)")
    ap.add_argument("--only-missing", action="store_true", help="skip assets that already carry motion")
    ap.add_argument("--upload", action="store_true", help="upload flow PNGs + manifest to R2 (needs R2_* env)")
    args = ap.parse_args()

    manifest = load_manifest(args.manifest, args.url)
    work_dir = args.out / "flow"
    annotated, derivs = annotate(manifest, work_dir, args.limit, args.only_missing)
    total_vid = sum(1 for a in annotated.get("assets", []) if a.get("type") == "video")
    print(f"[flow] baked {len(derivs)}/{total_vid} video flow maps")

    args.out.mkdir(parents=True, exist_ok=True)

    if args.upload:
        if not derivs:
            raise SystemExit("[flow] refusing to upload: 0 flow maps baked")
        required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE")
        missing = [k for k in required if not os.environ.get(k)]
        if missing:
            raise SystemExit(f"[flow] --upload requires R2 env: {missing}")
        from publish.upload_r2 import publish_manifest, upload_media, write_local_copy

        urls = upload_media(derivs)
        n = apply_urls(annotated, urls)
        print(f"[flow] flowSrc set on {n} assets")
        pub = publish_manifest(annotated, {})
        write_local_copy(annotated, args.out)
        print(f"[flow] published: {pub}")

    out_path = args.out / "manifest.json"
    out_path.write_text(json.dumps(annotated, indent=2) + "\n", encoding="utf-8")
    print(f"[flow] wrote {out_path}: v{annotated['version']}")


if __name__ == "__main__":
    main()
