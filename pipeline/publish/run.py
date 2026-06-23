"""QC + (optional) transcode + (optional) R2 publish for a built manifest.

Usage:
    python -m publish.run --out out/ [--upload]
R2 upload runs only when --upload is passed AND the R2_* env vars are present.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from embed.clip_window import clip_start_seconds, probe_duration

from .qc import run_qc, write_report
from .transcode import transcode_image, transcode_video
from .upload_r2 import publish_manifest, upload_media, write_local_copy


def local_paths_by_asset_id(fetched_path: Path) -> dict[str, Path]:
    """Reconstruct the image asset.id -> local file map the download step implies.

    build_manifest assigns image ids as ``img-{i:04d}`` by row order in fetched.jsonl, so we
    rebuild that same indexing here to correlate a surviving asset (ids may be sparse after QC
    drops) back to its locally downloaded file. Returns {} if fetched.jsonl is absent.
    """
    mapping: dict[str, Path] = {}
    if not (fetched_path and fetched_path.exists()):
        return mapping
    with fetched_path.open(encoding="utf-8") as f:
        i = 0
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            mapping[f"img-{i:04d}"] = Path(row["local_path"])
            i += 1
    return mapping


def build_derivatives(
    assets: list[dict], fetched_path: Path, deriv_dir: Path
) -> dict[str, Path]:
    """Build web derivatives for the kept visual assets; return {asset_id: derivative path}.

    Images are correlated to their downloaded file via fetched.jsonl and transcoded to webp
    (EXIF stripped, <=1600px). Videos are transcoded only when a local source is known on the
    asset (``_local``); today the download step fetches images only, so this is wired defensively
    for when video sourcing lands. Assets whose local file is missing or that fail transcode are
    skipped (they keep their original src and simply aren't uploaded).
    """
    id_to_local = local_paths_by_asset_id(fetched_path)
    derivatives: dict[str, Path] = {}
    for a in assets:
        type_ = a.get("type")
        if type_ == "image":
            local = id_to_local.get(a["id"])
            if local and local.exists():
                dst = transcode_image(local, deriv_dir)
                if dst is not None:
                    derivatives[a["id"]] = dst
        elif type_ == "video":
            raw = a.get("_local")
            local = Path(raw) if raw else None
            if local and local.exists():
                start = clip_start_seconds(probe_duration(local))
                dst = transcode_video(local, deriv_dir, start_seconds=start)
                if dst is not None:
                    derivatives[a["id"]] = dst
    return derivatives


def main() -> None:
    ap = argparse.ArgumentParser(description="DREAMREEL publish")
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--manifest", type=Path, default=None)
    ap.add_argument("--upload", action="store_true", help="upload to R2 (requires R2_* env)")
    args = ap.parse_args()

    manifest_path = args.manifest or (args.out / "manifest.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    # QC the visual assets (license re-check always; pixel checks when local images exist).
    image_root = args.out / "images"
    kept, report = run_qc(manifest["assets"], image_root if image_root.exists() else None)
    manifest["assets"] = kept
    write_report(report, args.out / "qc_report.json")
    print(f"[publish] QC kept {report.kept}, dropped {dict(report.dropped)}")

    # Always keep a local mirror of the shipped manifest.
    local = write_local_copy(manifest, args.out)
    print(f"[publish] local manifest -> {local}")

    if args.upload:
        required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE")
        if not all(os.environ.get(k) for k in required):
            print("[publish] --upload set but R2_* env incomplete; skipping upload")
            return
        fetched_path = args.out / "fetched.jsonl"
        derivatives = build_derivatives(kept, fetched_path, args.out / "derivatives")
        print(f"[publish] built {len(derivatives)} derivatives from {fetched_path.name}")
        media_urls = upload_media(derivatives)
        urls = publish_manifest(manifest, media_urls)
        print(f"[publish] published: {urls}")


if __name__ == "__main__":
    main()
