"""Repair hotlinked media srcs in a shipped manifest by restoring mirrored R2 URLs.

Round 5's `audio.build_corpus` was fed the local PRE-publish manifest (origin srcs) instead of
the live R2 manifest, so `v2026.06.23-1515` silently reverted every visual asset's `src` from its
R2 CDN URL back to the origin hotlink (archive.org / wellcomecollection / metmuseum). Archive.org
is not CORS-clean for WebGL video textures, so every video has been dark in production since.
Every manifest-only reship after that composed on top of the broken srcs.

This tool joins the live manifest against a reference manifest that still carries the mirrored
URLs (the last good publish, `manifest.2026.06.23-0359.json`), restores each visual asset's R2
src by asset id, and bumps the version. Video assets whose src is restored also DROP `shots[]`:
those timestamps were computed against the full-length origin film, while the mirrored R2 clip is
a short (~12 s) excerpt already cut at a content-aware interior start — the stale offsets would
seek past the end of the clip.

Usage (from pipeline/):
    python -m publish.repair_srcs --out out/                # dry run: fetch live + reference, report
    python -m publish.repair_srcs --out out/ --upload       # repair + ship (needs R2_* env)
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_MANIFEST_URL = (
    "https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json"
)
DEFAULT_REFERENCE_URL = (
    "https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/manifest.2026.06.23-0359.json"
)
DEFAULT_PUBLIC_BASE = "https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev"


def repair_srcs(
    manifest: dict[str, Any],
    reference: dict[str, Any],
    public_base: str = DEFAULT_PUBLIC_BASE,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return (repaired manifest copy, stats). Pure; no network.

    For every image/video asset whose src is NOT under public_base, restore the src recorded for
    the same asset id in the reference manifest (which must be under public_base). Restored video
    assets drop `shots[]` (full-film timestamps are invalid for the short mirrored clip).
    """
    base = public_base.rstrip("/") + "/"
    ref_map = {
        a["id"]: a["src"]
        for a in reference.get("assets", [])
        if a.get("src", "").startswith(base)
    }

    out = json.loads(json.dumps(manifest))  # deep copy via JSON
    stats: dict[str, Any] = {"already_mirrored": 0, "repaired": 0, "shots_dropped": 0, "unrepairable": []}
    for a in out.get("assets", []):
        src = a.get("src")
        if a.get("type") not in ("image", "video") or not src:
            continue
        if src.startswith(base):
            stats["already_mirrored"] += 1
            continue
        restored = ref_map.get(a["id"])
        if restored is None:
            stats["unrepairable"].append(a["id"])
            continue
        a["src"] = restored
        stats["repaired"] += 1
        if a.get("type") == "video" and a.pop("shots", None) is not None:
            stats["shots_dropped"] += 1

    out["version"] = datetime.now(timezone.utc).strftime("%Y.%m.%d-%H%M")
    out["createdAt"] = datetime.now(timezone.utc).isoformat()
    return out, stats


def _load(path: Path | None, url: str) -> dict[str, Any]:
    if path and path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    import requests

    print(f"[repair_srcs] fetching {url}")
    resp = requests.get(url, timeout=120)
    resp.raise_for_status()
    return resp.json()


def main() -> None:
    ap = argparse.ArgumentParser(description="DREAMREEL manifest src repair (restore mirrored R2 URLs)")
    ap.add_argument("--manifest", type=Path, default=None, help="local live manifest (else fetch --url)")
    ap.add_argument("--url", type=str, default=DEFAULT_MANIFEST_URL)
    ap.add_argument("--reference", type=Path, default=None, help="local reference manifest (else fetch --reference-url)")
    ap.add_argument("--reference-url", type=str, default=DEFAULT_REFERENCE_URL)
    ap.add_argument("--public-base", type=str, default=os.environ.get("R2_PUBLIC_BASE", DEFAULT_PUBLIC_BASE))
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--upload", action="store_true", help="upload manifest-only to R2 (needs R2_* env)")
    args = ap.parse_args()

    manifest = _load(args.manifest, args.url)
    reference = _load(args.reference, args.reference_url)
    repaired, stats = repair_srcs(manifest, reference, args.public_base)

    print(
        f"[repair_srcs] repaired {stats['repaired']} srcs "
        f"({stats['shots_dropped']} stale shots[] dropped), "
        f"{stats['already_mirrored']} already mirrored, "
        f"{len(stats['unrepairable'])} unrepairable: {stats['unrepairable'] or 'none'}"
    )

    args.out.mkdir(parents=True, exist_ok=True)
    out_path = args.out / "manifest.json"
    out_path.write_text(json.dumps(repaired, indent=2) + "\n", encoding="utf-8")
    print(f"[repair_srcs] wrote {out_path}: v{repaired['version']}")

    if stats["unrepairable"]:
        print("[repair_srcs] WARNING: some assets remain hotlinked; fix or drop them before shipping")

    if args.upload:
        required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE")
        missing = [k for k in required if not os.environ.get(k)]
        if missing:
            raise SystemExit(f"[repair_srcs] --upload requires R2 env: {missing}")
        from publish.upload_r2 import publish_manifest, write_local_copy

        urls = publish_manifest(repaired, {})  # manifest-only; media on R2 untouched
        write_local_copy(repaired, args.out)
        print(f"[repair_srcs] published: {urls}")


if __name__ == "__main__":
    main()
