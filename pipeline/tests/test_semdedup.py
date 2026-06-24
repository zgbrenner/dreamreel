"""Tests for embed.semdedup — exact pairwise semantic dedup over manifest embeddings."""

from __future__ import annotations

import numpy as np

from embed.semdedup import dedup_manifest, find_near_duplicates


def _unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v)


def test_removes_near_duplicates_keeps_distinct():
    # Two near-identical vectors + two clearly distinct ones.
    emb = np.array([
        _unit([1.0, 0.01, 0.0]),
        _unit([1.0, 0.0, 0.0]),  # ~duplicate of row 0
        _unit([0.0, 1.0, 0.0]),
        _unit([0.0, 0.0, 1.0]),
    ])
    removed = find_near_duplicates(emb, threshold=0.99)
    assert removed == [1]  # the second of the near-identical pair is dropped


def test_distinct_corpus_keeps_everything():
    emb = np.array([_unit([1, 0, 0]), _unit([0, 1, 0]), _unit([0, 0, 1])])
    assert find_near_duplicates(emb, threshold=0.92) == []


def test_score_order_keeps_highest():
    # Three mutually near-identical vectors; the highest-scored survives.
    emb = np.array([_unit([1, 0.02, 0]), _unit([1, 0.0, 0]), _unit([1, 0.01, 0])])
    removed = find_near_duplicates(
        emb, threshold=0.99, scores=np.array([0.1, 0.9, 0.5]), max_remove_frac=1.0
    )
    assert removed == [0, 2]  # index 1 (score 0.9) kept


def test_max_remove_frac_cap():
    # Five identical vectors; without a cap, 4 would be removed. Cap at 0.4 => only 2 removed.
    emb = np.array([_unit([1, 0, 0])] * 5)
    removed = find_near_duplicates(emb, threshold=0.99, max_remove_frac=0.4)
    assert len(removed) == 2


def test_dedup_manifest_only_prunes_media():
    def asset(aid, atype, e):
        return {"id": aid, "type": atype, "embedding": list(_unit(e))}

    manifest = {
        "version": "x",
        "assets": [
            asset("img-a", "image", [1, 0, 0]),
            asset("img-b", "image", [1, 0.001, 0]),  # ~dup of img-a
            asset("vid-a", "video", [0, 1, 0]),
            asset("proc-1", "procedural", [1, 0, 0]),  # identical embedding but NOT deduped (kind)
            asset("proc-2", "procedural", [1, 0, 0]),
        ],
    }
    pruned, removed = dedup_manifest(manifest, threshold=0.99, max_remove_frac=1.0)
    assert removed == ["img-b"]
    ids = [a["id"] for a in pruned["assets"]]
    assert "img-a" in ids and "vid-a" in ids
    assert "proc-1" in ids and "proc-2" in ids  # procedural untouched
    assert pruned["version"] != "x"  # version bumped
