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

from .qc import run_qc, write_report
from .upload_r2 import publish_manifest, upload_media, write_local_copy


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
        # In a full run, transcode local derivatives and map asset_id -> path here.
        media_urls = upload_media({})
        urls = publish_manifest(manifest, media_urls)
        print(f"[publish] published: {urls}")


if __name__ == "__main__":
    main()
