"""Re-project a shipped manifest onto the 12-axis mood taxonomy without re-downloading media.

For a corpus already on R2, this loads manifest/latest.json (or a local file), rebuilds mood-axis
vectors (CLIP for visual/text embeddings, CLAP for audio), re-projects every baked mood from the
existing embeddings, bumps the version, and optionally uploads manifest-only to R2 (visual/audio
media URLs are untouched).

Usage (from pipeline/):
    python -m embed.remood_manifest --out out/
    python -m embed.remood_manifest --manifest out/manifest.json --out out/ --upload
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

from audio.clap_backend import get_audio_embedder
from audio.clap_transformers import get_transformers_audio_embedder
from embed.clip_backend import get_embedder, l2_normalize
from embed.mood_axes import MOOD_AXES, build_axes, project_mood

DEFAULT_MANIFEST_URL = (
    "https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json"
)


def _emb_list(v: np.ndarray) -> list[float]:
    return [round(float(x), 6) for x in v.tolist()]


def _best_audio_embedder():
    emb = get_transformers_audio_embedder()
    return emb if emb is not None else get_audio_embedder()


def _project_item_mood(item: dict, axes: dict[str, np.ndarray]) -> dict[str, float]:
    emb = np.asarray(item["embedding"], dtype=np.float32)
    emb = l2_normalize(emb.reshape(1, -1))[0]
    return project_mood(emb, axes)


def remood_manifest(manifest: dict[str, Any], clip_embedder=None, audio_embedder=None) -> dict[str, Any]:
    """Return a new manifest dict with 12-axis moodAxes and re-projected per-item moods."""
    clip = clip_embedder or get_embedder()
    audio = audio_embedder or _best_audio_embedder()
    clip_axes = build_axes(clip)
    audio_axes = build_axes(audio)

    out = json.loads(json.dumps(manifest))  # deep copy via JSON
    out["moodAxes"] = {axis: _emb_list(clip_axes[axis]) for axis in MOOD_AXES}

    for a in out.get("assets", []):
        a["mood"] = _project_item_mood(a, clip_axes)
    for t in out.get("texts", []):
        t["mood"] = _project_item_mood(t, clip_axes)
    for a in out.get("audio", []):
        a["mood"] = _project_item_mood(a, audio_axes)

    out["version"] = datetime.now(timezone.utc).strftime("%Y.%m.%d-%H%M")
    out["createdAt"] = datetime.now(timezone.utc).isoformat()
    return out


def load_manifest(path: Path | None, url: str | None) -> dict[str, Any]:
    if path and path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    fetch_url = url or DEFAULT_MANIFEST_URL
    print(f"[remood] fetching {fetch_url}")
    resp = requests.get(fetch_url, timeout=120)
    resp.raise_for_status()
    return resp.json()


def main() -> None:
    ap = argparse.ArgumentParser(description="DREAMREEL remood_manifest (12-axis re-projection)")
    ap.add_argument("--manifest", type=Path, default=None, help="local manifest.json (else fetch --url)")
    ap.add_argument("--url", type=str, default=None, help=f"manifest URL (default: {DEFAULT_MANIFEST_URL})")
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--upload", action="store_true", help="upload manifest-only to R2 (needs R2_* env)")
    args = ap.parse_args()

    manifest = load_manifest(args.manifest, args.url)
    clip = get_embedder()
    audio = _best_audio_embedder()
    print(f"[remood] clip backend: {clip.backend}, audio backend: {audio.backend}")

    remooded = remood_manifest(manifest, clip_embedder=clip, audio_embedder=audio)
    args.out.mkdir(parents=True, exist_ok=True)
    out_path = args.out / "manifest.json"
    out_path.write_text(json.dumps(remooded, indent=2) + "\n", encoding="utf-8")
    print(
        f"[remood] wrote {out_path}: v{remooded['version']}, "
        f"{len(remooded.get('assets', []))} visual, {len(remooded.get('audio', []))} audio, "
        f"{len(remooded.get('texts', []))} texts"
    )

    if args.upload:
        required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE")
        missing = [k for k in required if not os.environ.get(k)]
        if missing:
            raise SystemExit(f"[remood] --upload requires R2 env: {missing}")
        from publish.upload_r2 import publish_manifest, write_local_copy

        urls = publish_manifest(remooded, {})  # manifest-only; media src URLs unchanged
        write_local_copy(remooded, args.out)
        print(f"[remood] published: {urls}")


if __name__ == "__main__":
    main()
