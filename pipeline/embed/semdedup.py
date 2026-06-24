"""SemDeDup-style semantic deduplication of the visual corpus, over the embeddings already in the
manifest (no media download, no model load). Removes near-duplicate image/video assets — the kind
that crowd one region of CLIP space and make the embedding walk loop on near-identical neighbours —
so the corpus is more varied and the manifest/R2 reference set is slimmer.

SemDeDup (arXiv:2303.09540) uses k-means + intra-cluster cosine pruning for WEB-SCALE data where a
full pairwise comparison is infeasible. DREAMREEL's corpus is a few hundred assets, so we compute
the EXACT pairwise cosine matrix and greedily prune — strictly more accurate than the clustered
approximation at this scale. Deterministic: a fixed keep-order (optionally by a quality score) and a
fixed threshold, so the same manifest always prunes to the same result.

Conservative by design: a high default threshold (only genuine near-duplicates) and a hard cap on
the fraction removed, since this is a hand-curated public-domain corpus, not noisy web crawl.

Usage (from pipeline/):
    python -m embed.semdedup --out out --dry-run
    python -m embed.semdedup --manifest out/manifest.json --out out --upload
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

DEFAULT_MANIFEST_URL = (
    "https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json"
)

# Only real media is deduped — procedural/titlecard assets are distinct by kind, not by embedding.
DEDUP_TYPES = ("image", "video")

DEFAULT_THRESHOLD = 0.92  # cosine >= this counts as a near-duplicate
DEFAULT_MAX_REMOVE_FRAC = 0.30  # never prune more than this fraction of the deduped pool


def _normalize(emb: np.ndarray) -> np.ndarray:
    return emb / (np.linalg.norm(emb, axis=1, keepdims=True) + 1e-9)


def find_near_duplicates(
    emb: np.ndarray,
    threshold: float = DEFAULT_THRESHOLD,
    scores: np.ndarray | None = None,
    max_remove_frac: float = DEFAULT_MAX_REMOVE_FRAC,
) -> list[int]:
    """Return the row indices to REMOVE. Keeps the first of each near-duplicate group; group order
    is by `scores` descending (keep the highest-quality member) when provided, else by index.

    Caps total removals at `max_remove_frac` of the pool, dropping the most-redundant (highest
    cosine-to-keeper) first when the cap binds.
    """
    n = emb.shape[0]
    if n <= 1:
        return []
    X = _normalize(emb.astype(np.float64))
    sim = X @ X.T

    order = list(range(n)) if scores is None else list(np.argsort(-scores, kind="stable"))
    pos = {idx: p for p, idx in enumerate(order)}

    removed: dict[int, float] = {}  # removed index -> cosine to the keeper that removed it
    for i in order:
        if i in removed:
            continue
        # i is kept; remove later-in-order members that are near-duplicates of it
        for j in order[pos[i] + 1 :]:
            if j in removed:
                continue
            s = float(sim[i, j])
            if s >= threshold:
                removed[j] = s

    cap = int(np.floor(max_remove_frac * n))
    if len(removed) > cap:
        # keep only the most-redundant `cap` removals
        ranked = sorted(removed.items(), key=lambda kv: kv[1], reverse=True)
        removed = dict(ranked[:cap])
    return sorted(removed.keys())


def dedup_manifest(
    manifest: dict[str, Any],
    threshold: float = DEFAULT_THRESHOLD,
    max_remove_frac: float = DEFAULT_MAX_REMOVE_FRAC,
) -> tuple[dict[str, Any], list[str]]:
    """Return (pruned_manifest, removed_ids). Prunes only DEDUP_TYPES assets; bumps the version."""
    out = json.loads(json.dumps(manifest))  # deep copy
    assets = out.get("assets", [])
    candidates = [(idx, a) for idx, a in enumerate(assets) if a.get("type") in DEDUP_TYPES]
    if len(candidates) <= 1:
        return out, []

    emb = np.array([a["embedding"] for _, a in candidates], dtype=np.float64)
    # Prefer keeping higher-aesthetic assets when the score is present (semdedup runs after scoring).
    have_scores = all("aesthetic" in a for _, a in candidates)
    scores = np.array([a.get("aesthetic", 0.0) for _, a in candidates]) if have_scores else None

    remove_local = find_near_duplicates(emb, threshold, scores, max_remove_frac)
    remove_global = {candidates[i][0] for i in remove_local}
    removed_ids = [assets[gi]["id"] for gi in sorted(remove_global)]

    out["assets"] = [a for idx, a in enumerate(assets) if idx not in remove_global]
    out["version"] = datetime.now(timezone.utc).strftime("%Y.%m.%d-%H%M")
    out["createdAt"] = datetime.now(timezone.utc).isoformat()
    return out, removed_ids


def load_manifest(path: Path | None, url: str | None) -> dict[str, Any]:
    if path and path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    fetch_url = url or DEFAULT_MANIFEST_URL
    print(f"[semdedup] fetching {fetch_url}")
    resp = requests.get(fetch_url, timeout=120)
    resp.raise_for_status()
    return resp.json()


def main() -> None:
    ap = argparse.ArgumentParser(description="DREAMREEL semantic dedup of the visual corpus")
    ap.add_argument("--manifest", type=Path, default=None, help="local manifest.json (else fetch --url)")
    ap.add_argument("--url", type=str, default=None, help=f"manifest URL (default: {DEFAULT_MANIFEST_URL})")
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    ap.add_argument("--max-remove-frac", type=float, default=DEFAULT_MAX_REMOVE_FRAC)
    ap.add_argument("--dry-run", action="store_true", help="report removals; do not write/upload")
    ap.add_argument("--upload", action="store_true", help="upload pruned manifest-only to R2 (needs R2_* env)")
    args = ap.parse_args()

    manifest = load_manifest(args.manifest, args.url)
    before = len(manifest.get("assets", []))
    pruned, removed_ids = dedup_manifest(manifest, args.threshold, args.max_remove_frac)
    after = len(pruned.get("assets", []))
    print(
        f"[semdedup] threshold {args.threshold}: {before} -> {after} assets "
        f"({len(removed_ids)} near-duplicates removed)"
    )
    for rid in removed_ids:
        print(f"  - removed {rid}")

    if args.dry_run:
        print("[semdedup] dry-run: nothing written")
        return

    args.out.mkdir(parents=True, exist_ok=True)
    out_path = args.out / "manifest.json"
    out_path.write_text(json.dumps(pruned, indent=2) + "\n", encoding="utf-8")
    print(f"[semdedup] wrote {out_path}: v{pruned['version']}")

    if args.upload:
        required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE")
        missing = [k for k in required if not os.environ.get(k)]
        if missing:
            raise SystemExit(f"[semdedup] --upload requires R2 env: {missing}")
        from publish.upload_r2 import publish_manifest, write_local_copy

        urls = publish_manifest(pruned, {})  # manifest-only; pruned media stays on R2 (unreferenced)
        write_local_copy(pruned, args.out)
        print(f"[semdedup] published: {urls}")


if __name__ == "__main__":
    main()
