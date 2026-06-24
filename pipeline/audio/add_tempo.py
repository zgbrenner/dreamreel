"""Enrich a shipped manifest's audio[] with librosa tempo + energy, without rebuilding the corpus.

For a corpus already on R2, this loads manifest/latest.json (or a local file), downloads each
audio clip (cached under --out/audio), runs `tempo.analyze_audio`, writes back `bpm`/`energy`,
bumps the version, and optionally uploads MANIFEST-ONLY to R2 (media URLs are untouched). Mirrors
embed.remood_manifest; needs the `audio` extra (librosa) installed for the analysis to do anything.

Usage (from pipeline/):
    python -m audio.add_tempo --out out
    python -m audio.add_tempo --manifest out/manifest.json --out out --upload
"""

from __future__ import annotations

import argparse
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

from .tempo import analyze_audio

DEFAULT_MANIFEST_URL = (
    "https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json"
)


def load_manifest(path: Path | None, url: str | None) -> dict[str, Any]:
    if path and path.exists():
        import json

        return json.loads(path.read_text(encoding="utf-8"))
    fetch_url = url or DEFAULT_MANIFEST_URL
    print(f"[tempo] fetching {fetch_url}")
    resp = requests.get(fetch_url, timeout=120)
    resp.raise_for_status()
    return resp.json()


def _ensure_local(src: str, dest_dir: Path, asset_id: str) -> Path | None:
    """Download `src` to dest_dir/<id><ext> (cached); return the path or None on failure."""
    ext = os.path.splitext(src.split("?")[0])[1] or ".m4a"
    dest = dest_dir / f"{asset_id}{ext}"
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    try:
        resp = requests.get(src, timeout=120)
        resp.raise_for_status()
        dest.write_bytes(resp.content)
        return dest
    except Exception as e:  # network / 4xx — skip this clip, keep going
        print(f"[tempo] WARN could not fetch {asset_id}: {e}")
        return None


def add_tempo(manifest: dict[str, Any], audio_dir: Path, force: bool = False) -> tuple[dict, int]:
    """Annotate audio[] in place-ish (returns a copy). Returns (manifest, n_annotated)."""
    import json

    out = json.loads(json.dumps(manifest))  # deep copy
    annotated = 0
    for a in out.get("audio", []):
        if not force and "bpm" in a and "energy" in a:
            continue
        local = _ensure_local(a["src"], audio_dir, a["id"])
        if local is None:
            continue
        rhythm = analyze_audio(str(local))
        if not rhythm:
            continue
        if "bpm" in rhythm:
            a["bpm"] = rhythm["bpm"]
        if "energy" in rhythm:
            a["energy"] = rhythm["energy"]
        annotated += 1

    out["version"] = datetime.now(timezone.utc).strftime("%Y.%m.%d-%H%M")
    out["createdAt"] = datetime.now(timezone.utc).isoformat()
    return out, annotated


def main() -> None:
    ap = argparse.ArgumentParser(description="DREAMREEL add_tempo (librosa bpm + energy on audio[])")
    ap.add_argument("--manifest", type=Path, default=None, help="local manifest.json (else fetch --url)")
    ap.add_argument("--url", type=str, default=None, help=f"manifest URL (default: {DEFAULT_MANIFEST_URL})")
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--force", action="store_true", help="re-analyze even if bpm+energy already present")
    ap.add_argument("--upload", action="store_true", help="upload manifest-only to R2 (needs R2_* env)")
    args = ap.parse_args()

    import importlib.util

    if importlib.util.find_spec("librosa") is None:
        print("[tempo] note: librosa is not installed — install the `audio` extra "
              "(pip install librosa soundfile); nothing will be annotated")

    manifest = load_manifest(args.manifest, args.url)
    audio_dir = args.out / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)

    enriched, annotated = add_tempo(manifest, audio_dir, force=args.force)
    out_path = args.out / "manifest.json"
    import json

    out_path.write_text(json.dumps(enriched, indent=2) + "\n", encoding="utf-8")
    print(
        f"[tempo] wrote {out_path}: v{enriched['version']}, annotated {annotated}/"
        f"{len(enriched.get('audio', []))} audio clips"
    )

    if args.upload:
        # Guard against uploading a manifest with no tempo data at all (e.g. librosa missing on a
        # fresh manifest). A re-upload of an already-enriched manifest annotates 0 but is fine.
        have_tempo = sum(1 for a in enriched.get("audio", []) if "energy" in a or "bpm" in a)
        if have_tempo == 0:
            raise SystemExit("[tempo] refusing to upload: no clips carry tempo data (is librosa installed?)")
        required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE")
        missing = [k for k in required if not os.environ.get(k)]
        if missing:
            raise SystemExit(f"[tempo] --upload requires R2 env: {missing}")
        from publish.upload_r2 import publish_manifest, write_local_copy

        urls = publish_manifest(enriched, {})  # manifest-only; media src URLs unchanged
        write_local_copy(enriched, args.out)
        print(f"[tempo] published: {urls}")


if __name__ == "__main__":
    main()
