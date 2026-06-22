"""Download + resize candidate media.

Production path uses img2dataset for scale; here we also provide a dependency-light fallback
(requests + Pillow) so a small corpus can be fetched without the heavy toolchain. Either way
we cap the longest side at ~1600px and record only successfully-fetched assets.

CLI (the link between ingest and embed):
    python -m embed.download --candidates out/candidates.jsonl --out out/
writes out/fetched.jsonl, which build_manifest reads to produce the real image assets.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Iterable

import requests

from ingest.normalize import Candidate
from embed.poster import extract_poster

MAX_SIDE = 1600
USER_AGENT = "DREAMREEL-corpus/0.1 (+https://dreamreel.example)"


def _safe_name(url: str, ext: str = ".jpg") -> str:
    return hashlib.sha1(url.encode("utf-8")).hexdigest()[:16] + ext


def _resize_in_place(path: Path) -> bool:
    try:
        from PIL import Image
    except ImportError:
        return True  # leave as-is if Pillow missing
    try:
        with Image.open(path) as im:
            im = im.convert("RGB")
            longest = max(im.size)
            if longest > MAX_SIDE:
                scale = MAX_SIDE / longest
                im = im.resize((int(im.width * scale), int(im.height * scale)))
            im.save(path, "JPEG", quality=88)
        return True
    except Exception:  # noqa: BLE001
        return False


def download(candidates: Iterable[Candidate], out_dir: Path) -> list[dict]:
    """Fetch images, resize, and return a list of {candidate, local_path} for successes."""
    img_dir = out_dir / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    fetched: list[dict] = []
    for c in candidates:
        if c.type != "image":
            # videos are handled in publish/transcode; embeddings here cover images.
            continue
        local = img_dir / _safe_name(c.source_url)
        if not local.exists():
            try:
                r = requests.get(c.source_url, headers={"User-Agent": USER_AGENT}, timeout=45)
                r.raise_for_status()
                local.write_bytes(r.content)
            except requests.RequestException:
                continue
            if not _resize_in_place(local):
                local.unlink(missing_ok=True)
                continue
        fetched.append({"candidate": c.model_dump(), "local_path": str(local)})

    manifest_path = out_dir / "fetched.jsonl"
    with manifest_path.open("w", encoding="utf-8") as f:
        for row in fetched:
            f.write(json.dumps(row) + "\n")
    print(f"downloaded {len(fetched)} images -> {img_dir}")
    return fetched


def download_videos(candidates: Iterable[Candidate], out_dir: Path) -> list[dict]:
    """Fetch films + extract a poster frame; write fetched_videos.jsonl (videos only).

    Kept separate from download()/fetched.jsonl so the image img-{i} indexing (and the publish
    correlation that rebuilds it) is never disturbed. Each row carries the local video path
    (consumed by publish/transcode via the asset's _local field) and the poster path (embedded
    by build_manifest). Fetch or poster failures drop the candidate with no crash.
    """
    vid_dir = out_dir / "videos"
    poster_dir = out_dir / "posters"
    vid_dir.mkdir(parents=True, exist_ok=True)
    fetched: list[dict] = []
    for c in candidates:
        if c.type != "video":
            continue
        local = vid_dir / _safe_name(c.source_url, ".mp4")
        if not local.exists():
            try:
                r = requests.get(c.source_url, headers={"User-Agent": USER_AGENT}, timeout=120)
                r.raise_for_status()
                local.write_bytes(r.content)
            except requests.RequestException:
                continue
        poster = extract_poster(local, poster_dir)
        if poster is None:
            local.unlink(missing_ok=True)
            continue
        fetched.append(
            {"candidate": c.model_dump(), "video_path": str(local), "poster_path": str(poster)}
        )

    manifest_path = out_dir / "fetched_videos.jsonl"
    with manifest_path.open("w", encoding="utf-8") as f:
        for row in fetched:
            f.write(json.dumps(row) + "\n")
    print(f"downloaded {len(fetched)} videos -> {vid_dir}")
    return fetched


def load_candidates(path: Path) -> list[Candidate]:
    """Read the ingest step's candidates.jsonl into Candidate models."""
    rows: list[Candidate] = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(Candidate.model_validate_json(line))
    return rows


def main() -> None:
    ap = argparse.ArgumentParser(description="DREAMREEL media download (candidates -> fetched)")
    ap.add_argument("--candidates", type=Path, default=Path("out/candidates.jsonl"))
    ap.add_argument("--out", type=Path, default=Path("out"))
    args = ap.parse_args()
    if not args.candidates.exists():
        raise SystemExit(f"no candidates file at {args.candidates}; run `python -m ingest.run` first")
    cands = load_candidates(args.candidates)
    download(cands, args.out)
    download_videos(cands, args.out)


if __name__ == "__main__":
    main()
