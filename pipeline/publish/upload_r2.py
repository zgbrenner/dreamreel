"""Publish derivatives + a versioned manifest to Cloudflare R2 (S3-compatible).

Credentials come from the env, never from code:
    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE
We rewrite each asset.src to its public CDN URL, then emit manifest.<version>.json plus a
`latest` pointer. The bucket must NOT be publicly writable; we set immutable cache headers on
hashed media and a short cache on the `latest` pointer.
"""

from __future__ import annotations

import json
import os
from pathlib import Path


def _client():
    import boto3  # lazy

    account = os.environ["R2_ACCOUNT_ID"]
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def upload_media(derivatives: dict[str, Path]) -> dict[str, str]:
    """Upload {asset_id: local_path}; return {asset_id: public_url}."""
    bucket = os.environ["R2_BUCKET"]
    public_base = os.environ["R2_PUBLIC_BASE"].rstrip("/")
    client = _client()
    urls: dict[str, str] = {}
    for asset_id, path in derivatives.items():
        key = f"media/{path.name}"
        content_type = "image/webp" if path.suffix == ".webp" else "video/mp4"
        client.upload_file(
            str(path),
            bucket,
            key,
            ExtraArgs={"ContentType": content_type, "CacheControl": "public, max-age=31536000, immutable"},
        )
        urls[asset_id] = f"{public_base}/{key}"
    return urls


def publish_manifest(manifest: dict, media_urls: dict[str, str]) -> dict:
    """Rewrite asset.src to R2 URLs and upload manifest.<version>.json + latest pointer."""
    for a in manifest.get("assets", []):
        if a["id"] in media_urls:
            a["src"] = media_urls[a["id"]]
        a.pop("_local", None)  # internal pipeline key — never ship local paths

    version = manifest["version"]
    bucket = os.environ["R2_BUCKET"]
    public_base = os.environ["R2_PUBLIC_BASE"].rstrip("/")
    client = _client()
    body = (json.dumps(manifest) + "\n").encode("utf-8")

    versioned_key = f"manifest/manifest.{version}.json"
    client.put_object(
        Bucket=bucket,
        Key=versioned_key,
        Body=body,
        ContentType="application/json",
        CacheControl="public, max-age=31536000, immutable",
    )
    # latest pointer — short cache so new corpora roll out quickly
    client.put_object(
        Bucket=bucket,
        Key="manifest/latest.json",
        Body=body,
        ContentType="application/json",
        CacheControl="public, max-age=60",
    )
    return {
        "versioned": f"{public_base}/{versioned_key}",
        "latest": f"{public_base}/manifest/latest.json",
    }


def write_local_copy(manifest: dict, out_dir: Path) -> Path:
    """Always keep a local copy of the shipped manifest (we mirror; never hotlink at runtime)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"manifest.{manifest['version']}.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return path
