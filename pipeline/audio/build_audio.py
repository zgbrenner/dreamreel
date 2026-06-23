"""Build the manifest `audio[]` pool (CLAP embeddings + mood) and the visual `claptext` bridge
vector. Mirrors embed/build_manifest.build_video_assets: keeps an internal _local path for the
transcode/upload steps and a src that publish/upload_r2 rewrites to the R2 URL."""

from __future__ import annotations

import numpy as np

from embed.mood_axes import project_mood

from .clap_backend import l2_normalize

_DWELL = {"music": 60.0, "voice": 7.0, "foley": 12.0}


def _emb_list(v: np.ndarray) -> list[float]:
    return [round(float(x), 6) for x in v.tolist()]


def _dwell_for_audio(kind: str) -> float:
    return _DWELL[kind]


def claptext_for(embedder, tags: list[str]) -> list[float]:
    if not tags:
        return []
    vec = embedder.embed_texts([", ".join(tags)])
    vec = l2_normalize(vec.reshape(1, -1))[0]
    return _emb_list(vec)


def build_audio_assets(embedder, axes, candidates: list[dict]) -> list[dict]:
    if not candidates:
        return []
    embs = embedder.embed_audio([c["_local"] for c in candidates])
    built: list[dict] = []
    for c, emb in zip(candidates, embs):
        emb = l2_normalize(emb.reshape(1, -1))[0]
        asset = {
            "id": c["id"],
            "kind": c["kind"],
            "src": c["source_url"],  # rewritten to the R2 URL in publish/upload_r2
            "_local": c["_local"],  # internal; stripped before upload
            "embedding": _emb_list(emb),
            "mood": project_mood(emb, axes),
            "tags": list(c.get("tags", [])),
            "durationSec": float(c["duration_sec"]),
            "loopable": bool(c.get("loopable", False)),
            "dwellBase": _dwell_for_audio(c["kind"]),
            "source": c["source"],
            "license": c["license"],
        }
        if c.get("attribution"):
            asset["attribution"] = c["attribution"]
        if c.get("attribution_url"):
            asset["attributionUrl"] = c["attribution_url"]
        built.append(asset)
    return built
