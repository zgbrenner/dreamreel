"""Ship the Round 5 audio corpus: upload ONLY the new audio derivatives + the augmented manifest.

The augmented manifest (from audio.build_corpus) keeps the existing visual assets' R2 srcs, so we
must NOT re-upload images/videos. We upload each audio asset's `_local` .m4a to R2, then
publish_manifest rewrites the audio srcs (popping `_local`) and pushes manifest.<version>.json +
the latest pointer. Visual media on R2 is untouched.

Run from pipeline/ with the R2_* env vars set:
    python -m audio.ship_corpus --manifest out/manifest.json --out out
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from publish.upload_r2 import publish_manifest, upload_media, write_local_copy


def main() -> None:
    ap = argparse.ArgumentParser(description="DREAMREEL Round 5 audio ship")
    ap.add_argument("--manifest", type=Path, default=Path("out/manifest.json"))
    ap.add_argument("--out", type=Path, default=Path("out"))
    args = ap.parse_args()

    required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE")
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        raise SystemExit(f"[ship] missing R2 env: {missing}")

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    audio = manifest.get("audio", [])
    derivs: dict[str, Path] = {}
    for a in audio:
        local = a.get("_local")
        if local and Path(local).exists():
            derivs[a["id"]] = Path(local)
    print(f"[ship] uploading {len(derivs)}/{len(audio)} audio derivatives to R2…")
    media_urls = upload_media(derivs)
    urls = publish_manifest(manifest, media_urls)  # rewrites audio src, pops _local, ships manifest
    write_local_copy(manifest, args.out)

    # sanity: no internal field leaked into the shipped audio entries
    leaked = [a["id"] for a in manifest.get("audio", []) if "_local" in a]
    print(f"[ship] _local leaks: {leaked or 'none'}")
    print(f"[ship] version {manifest['version']}: {len(audio)} audio, {len(manifest['assets'])} visual")
    print(f"[ship] published: {urls}")


if __name__ == "__main__":
    main()
