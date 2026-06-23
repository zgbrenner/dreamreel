"""Assemble the static Manifest the app consumes (CLAUDE.md / app schema).

Carries license/source/attribution from candidates through unchanged, computes L2-normalized
CLIP embeddings + projected mood, injects the procedural placeholder assets the runtime needs
(so the archive-off, procedural-only path works), and writes pipeline/out/manifest.json.

Usage:
    python -m embed.build_manifest --out out/ [--fetched out/fetched.jsonl]
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from audio.build_audio import build_audio_assets, claptext_for
from audio.clap_backend import get_audio_embedder

from .clip_backend import get_embedder, l2_normalize
from .curate import DEFAULT_CUTOFF, VIDEO_CUTOFF, curate
from .embed_images import embed_image_paths
from .embed_texts import build_texts, procedural_seed_embeddings
from .mood_axes import MOOD_AXES, build_axes, project_mood

PROCEDURAL_KINDS = [
    "leader",
    "fog",
    "stars",
    "iris",
    "ripple",
    "static",
    "horizon",
    "orbs",
    "filmrun",
]


def _emb_list(v: np.ndarray) -> list[float]:
    return [round(float(x), 6) for x in v.tolist()]


def _dwell_for(type_: str, tags: list[str]) -> float:
    t = set(tags)
    if type_ == "video":
        return 7.5
    if t & {"portrait", "faces", "figure"}:
        return 6.5
    if t & {"map", "maps", "diagram"}:
        return 5.0
    return 6.0


def curate_image_assets(image_assets: list[dict]) -> list[dict]:
    """Drop off-target image assets by mood score (anchors exempt); log the counts."""
    kept, dropped = curate(image_assets, cutoff=DEFAULT_CUTOFF)
    print(
        f"[build_manifest] curation: kept {len(kept)}/{len(image_assets)} image assets "
        f"(dropped {len(dropped)} below cutoff {DEFAULT_CUTOFF}; anchors exempt)"
    )
    return kept


def build_video_assets(embedder, axes, videos_path: Path | None, audio_embedder=None) -> list[dict]:
    """Read fetched_videos.jsonl, embed each poster frame, emit curated video assets.

    Each asset carries an internal _local source path (consumed by publish/transcode, stripped
    before R2 upload) and src = the remote film URL (rewritten to the R2 mp4 URL on upload).
    Curated with the gentler VIDEO_CUTOFF so the scarce film pool is not over-pruned.
    """
    if not (videos_path and videos_path.exists()):
        return []
    with videos_path.open(encoding="utf-8") as f:
        rows = [json.loads(line) for line in f if line.strip()]
    if not rows:
        return []
    poster_paths = [r["poster_path"] for r in rows]
    embs = embed_image_paths(embedder, poster_paths)
    built: list[dict] = []
    for i, (r, emb) in enumerate(zip(rows, embs)):
        c = r["candidate"]
        emb = l2_normalize(emb.reshape(1, -1))[0]
        built.append(
            {
                "id": f"vid-{i:04d}",
                "type": "video",
                "src": c["source_url"],  # rewritten to the R2 mp4 URL in publish/upload_r2
                "_local": r["video_path"],  # internal; stripped before upload
                "_clipStart": r.get("clip_start_seconds", 0.0),  # internal; stripped before upload
                "embedding": _emb_list(emb),
                "mood": project_mood(emb, axes),
                "tags": c.get("tags", []),
                "dwellBase": _dwell_for("video", c.get("tags", [])),
                "claptext": claptext_for(audio_embedder, c.get("tags", [])) if audio_embedder is not None else [],
                "source": c["source"],
                "license": c["license"],
                **({"attribution": c["attribution"]} if c.get("attribution") else {}),
                **({"attributionUrl": c["attribution_url"]} if c.get("attribution_url") else {}),
            }
        )
    kept, dropped = curate(built, cutoff=VIDEO_CUTOFF)
    print(
        f"[build_manifest] curation: kept {len(kept)}/{len(built)} video assets "
        f"(dropped {len(dropped)} below cutoff {VIDEO_CUTOFF}; anchors exempt)"
    )
    return kept


def build(out_dir: Path, fetched_path: Path | None, videos_path: Path | None = None) -> Path:
    embedder = get_embedder()
    print(f"[build_manifest] embedder backend: {embedder.backend}, dim={embedder.dim}")
    axes = build_axes(embedder)

    audio_embedder = get_audio_embedder()
    print(f"[build_manifest] audio embedder backend: {audio_embedder.backend}, dim={audio_embedder.dim}")
    audio_axes = build_axes(audio_embedder)

    assets: list[dict] = []
    image_assets: list[dict] = []

    # --- image assets from the download step ---
    rows: list[dict] = []
    if fetched_path and fetched_path.exists():
        with fetched_path.open(encoding="utf-8") as f:
            rows = [json.loads(line) for line in f if line.strip()]
    if rows:
        paths = [r["local_path"] for r in rows]
        embs = embed_image_paths(embedder, paths)
        for i, (r, emb) in enumerate(zip(rows, embs)):
            c = r["candidate"]
            emb = l2_normalize(emb.reshape(1, -1))[0]
            image_assets.append(
                {
                    "id": f"img-{i:04d}",
                    "type": "image",
                    "src": c["source_url"],  # rewritten to R2 URL in publish/upload_r2
                    "embedding": _emb_list(emb),
                    "mood": project_mood(emb, axes),
                    "tags": c.get("tags", []),
                    "dwellBase": _dwell_for("image", c.get("tags", [])),
                    "claptext": claptext_for(audio_embedder, c.get("tags", [])),
                    "source": c["source"],
                    "license": c["license"],
                    **({"attribution": c["attribution"]} if c.get("attribution") else {}),
                    **({"attributionUrl": c["attribution_url"]} if c.get("attribution_url") else {}),
                }
            )

    assets.extend(curate_image_assets(image_assets))

    # --- video assets from the video download step ---
    assets.extend(build_video_assets(embedder, axes, videos_path, audio_embedder=audio_embedder))

    # --- procedural placeholder assets (runtime needs these for archive-off) ---
    proc_emb = procedural_seed_embeddings(embedder)
    for kind in PROCEDURAL_KINDS:
        emb = l2_normalize(proc_emb[kind].reshape(1, -1))[0]
        assets.append(
            {
                "id": f"proc-{kind}",
                "type": "procedural",
                "kind": kind,
                "embedding": _emb_list(emb),
                "mood": project_mood(emb, axes),
                "tags": [kind, "procedural"],
                "dwellBase": 6.0 if kind != "leader" else 4.0,
                "claptext": claptext_for(audio_embedder, [kind, "procedural"]),
                "source": "DREAMREEL / procedural",
                "license": "CC0",
            }
        )

    # --- audio pool from the audio download/transcode step ---
    audio_assets: list[dict] = []
    audio_path = out_dir / "fetched_audio.jsonl"
    if audio_path.exists():
        from audio.ingest import normalize_audio
        with audio_path.open(encoding="utf-8") as f:
            raw_audio = [json.loads(line) for line in f if line.strip()]
        cands = normalize_audio(raw_audio)
        # Thread _local onto candidates via by-id lookup (normalize_audio does not carry _local)
        local_by_id = {r["id"]: r.get("_local", "") for r in raw_audio}
        for cand in cands:
            cand["_local"] = local_by_id.get(cand["id"], "")
        audio_assets = build_audio_assets(audio_embedder, audio_axes, cands)

    # --- text pool ---
    texts: list[dict] = []
    for row in build_texts(embedder):
        emb = l2_normalize(row["embedding"].reshape(1, -1))[0]
        texts.append(
            {
                "id": row["id"],
                "type": row["type"],
                "text": row["text"],
                "embedding": _emb_list(emb),
                "mood": project_mood(emb, axes),
                "tags": row["tags"],
                "dwellBase": row["dwellBase"],
                "source": row["source"],
                "license": row["license"],
            }
        )

    manifest = {
        "version": datetime.now(timezone.utc).strftime("%Y.%m.%d-%H%M"),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "embeddingDim": int(embedder.dim),
        "audioEmbeddingDim": int(audio_embedder.dim),
        "moodAxes": {axis: _emb_list(axes[axis]) for axis in MOOD_AXES},
        "assets": assets,
        "audio": audio_assets,
        "texts": texts,
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "manifest.json"
    out_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(
        f"[build_manifest] wrote {out_path}: {len(assets)} assets, {len(texts)} texts, "
        f"dim {embedder.dim}"
    )
    return out_path


def main() -> None:
    ap = argparse.ArgumentParser(description="DREAMREEL build_manifest")
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--fetched", type=Path, default=None, help="fetched.jsonl from download step")
    args = ap.parse_args()
    fetched = args.fetched or (args.out / "fetched.jsonl")
    videos = args.out / "fetched_videos.jsonl"
    build(args.out, fetched, videos)


if __name__ == "__main__":
    main()
