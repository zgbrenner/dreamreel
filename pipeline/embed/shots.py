"""Detect usable interior SHOT windows in each public-domain film (PySceneDetect, BSD-3) and bake
them onto the manifest's video assets, so the runtime plays a real shot instead of the film's
leader / title-card opening (the current behaviour — video assets point at the full archive.org
film and play from t=0). This gives DREAMREEL actual montage grammar, with no re-transcode.

Per film: ffmpeg pulls a bounded, downscaled INTERIOR segment (skipping the leader), PySceneDetect
finds shot cuts in it, the cut times are offset back to absolute film seconds, filtered to usable
windows (duration band, long shots trimmed, capped + spread across the film), and baked as
`shots: [{start, end}]`. The runtime (`render/VideoPool` + `dream/conductor.pickShot`) then seeks to
a deterministically-chosen shot and loops within it.

The filter logic (`usable_shots`) is pure and unit-tested; detection lazy-imports scenedetect (the
`video` extra) + needs ffmpeg. Manifest-only reship (mirrors remood/add_tempo).

Usage (from pipeline/, needs the `video` extra + ffmpeg):
    python -m embed.shots --out out --limit 3
    python -m embed.shots --manifest out/manifest.json --out out --upload
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

LEAD_SKIP = 20.0      # seconds skipped at the film head (leaders, title cards, studio logos)
WINDOW = 180.0        # seconds of interior film to scan for shots
MIN_DUR = 1.5         # a shot shorter than this is too flickery to read
MAX_DUR = 8.0         # a shot longer than this is trimmed (a "video asset" should not over-stay)
MAX_SHOTS = 6         # at most this many windows per film, spread across the scanned interior


def usable_shots(
    scenes_sec: list[tuple[float, float]],
    offset: float = 0.0,
    min_dur: float = MIN_DUR,
    max_dur: float = MAX_DUR,
    max_n: int = MAX_SHOTS,
) -> list[dict]:
    """Pure: turn raw (start,end)-seconds scenes into a curated list of absolute shot windows.

    Drops sub-`min_dur` flickers, trims long shots to `max_dur`, offsets to absolute film time, and
    evenly spreads the kept windows to at most `max_n` (so one film contributes varied moments).
    """
    kept: list[dict] = []
    for s, e in scenes_sec:
        if e - s < min_dur:
            continue
        end = min(e, s + max_dur)
        kept.append({"start": round(s + offset, 2), "end": round(end + offset, 2)})
    if len(kept) <= max_n:
        return kept
    # Evenly sample max_n windows across the kept set (spread across the film, not the first few).
    step = len(kept) / max_n
    return [kept[int(i * step)] for i in range(max_n)]


def _encode_url(u: str) -> str:
    p = urlsplit(u)
    return urlunsplit((p.scheme, p.netloc, quote(p.path), p.query, p.fragment))


def _extract_segment(url: str, dest: Path, lead: float, window: float) -> bool:
    """ffmpeg-pull a downscaled interior segment (fast keyframe seek) for scene detection."""
    cmd = [
        "ffmpeg", "-y", "-ss", str(lead), "-i", _encode_url(url), "-t", str(window),
        "-an", "-vf", "scale=320:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
        str(dest),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=300)
        return dest.exists() and dest.stat().st_size > 0
    except (subprocess.CalledProcessError, FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return False


def detect_shots(path: str) -> list[tuple[float, float]]:
    """Raw (start,end)-seconds scene list via PySceneDetect, or [] if scenedetect is unavailable."""
    try:
        from scenedetect import ContentDetector, detect  # noqa: PLC0415 — optional `video` extra
    except ImportError:
        return []
    try:
        scenes = detect(path, ContentDetector())
    except Exception:
        return []
    return [(s.get_seconds(), e.get_seconds()) for s, e in scenes]


def annotate(
    manifest: dict[str, Any],
    work_dir: Path,
    limit: int | None = None,
    lead: float = LEAD_SKIP,
    window: float = WINDOW,
    max_shots: int = MAX_SHOTS,
    only_missing: bool = False,
) -> tuple[dict, int]:
    """Bake `shots` onto video assets. Returns (manifest, n_annotated).

    `only_missing` restricts work to videos that don't already carry `shots[]` — so a tuned
    coverage backfill (smaller `lead`/`window`, more `max_shots`) recovers the gaps WITHOUT
    re-detecting (and thereby changing) the shots already shipped for other films.
    """
    out = json.loads(json.dumps(manifest))
    work_dir.mkdir(parents=True, exist_ok=True)
    videos = [a for a in out.get("assets", []) if a.get("type") == "video" and a.get("src")]
    if only_missing:
        videos = [a for a in videos if not a.get("shots")]
    if limit is not None:
        videos = videos[:limit]

    annotated = 0
    for a in videos:
        seg = work_dir / f"{a['id']}.mp4"
        if not (seg.exists() and seg.stat().st_size > 0):
            if not _extract_segment(a["src"], seg, lead, window):
                print(f"[shots] WARN segment extract failed: {a['id']}")
                continue
        scenes = detect_shots(str(seg))
        shots = usable_shots(scenes, offset=lead, max_n=max_shots)
        if not shots:
            print(f"[shots] no usable shots: {a['id']}")
            continue
        a["shots"] = shots
        annotated += 1
        print(f"[shots] {a['id']}: {len(shots)} shots")

    out["version"] = datetime.now(timezone.utc).strftime("%Y.%m.%d-%H%M")
    out["createdAt"] = datetime.now(timezone.utc).isoformat()
    return out, annotated


def load_manifest(path: Path | None, url: str | None) -> dict[str, Any]:
    if path and path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    fetch_url = url or DEFAULT_MANIFEST_URL
    print(f"[shots] fetching {fetch_url}")
    resp = requests.get(fetch_url, timeout=120)
    resp.raise_for_status()
    return resp.json()


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="DREAMREEL shot detection (PySceneDetect montage grammar)")
    ap.add_argument("--manifest", type=Path, default=None)
    ap.add_argument("--url", type=str, default=None)
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--limit", type=int, default=None, help="annotate only the first N video assets")
    ap.add_argument("--lead", type=float, default=LEAD_SKIP, help=f"seconds skipped at film head (default {LEAD_SKIP})")
    ap.add_argument("--window", type=float, default=WINDOW, help=f"seconds of interior film scanned (default {WINDOW})")
    ap.add_argument("--max-shots", type=int, default=MAX_SHOTS, help=f"max shots per film (default {MAX_SHOTS})")
    ap.add_argument("--only-missing", action="store_true", help="only annotate videos lacking shots[] (coverage backfill; leaves existing shots untouched)")
    ap.add_argument("--upload", action="store_true", help="upload manifest-only to R2 (needs R2_* env)")
    args = ap.parse_args()

    manifest = load_manifest(args.manifest, args.url)
    annotated, n = annotate(
        manifest, args.out / "shots_work", args.limit,
        lead=args.lead, window=args.window, max_shots=args.max_shots, only_missing=args.only_missing,
    )
    total = sum(1 for a in annotated.get("assets", []) if a.get("type") == "video")
    print(f"[shots] annotated {n}/{total} video assets")

    args.out.mkdir(parents=True, exist_ok=True)
    out_path = args.out / "manifest.json"
    out_path.write_text(json.dumps(annotated, indent=2) + "\n", encoding="utf-8")
    print(f"[shots] wrote {out_path}: v{annotated['version']}")

    if args.upload:
        have = sum(1 for a in annotated.get("assets", []) if a.get("shots"))
        if have == 0:
            raise SystemExit("[shots] refusing to upload: no assets carry shots (is scenedetect installed?)")
        required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE")
        missing = [k for k in required if not os.environ.get(k)]
        if missing:
            raise SystemExit(f"[shots] --upload requires R2 env: {missing}")
        from publish.upload_r2 import publish_manifest, write_local_copy

        urls = publish_manifest(annotated, {})
        write_local_copy(annotated, args.out)
        print(f"[shots] published: {urls}")


if __name__ == "__main__":
    main()
