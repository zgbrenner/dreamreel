"""Tests for embed.aesthetic — the pure scoring math runs without torch/open_clip."""

from __future__ import annotations

import numpy as np
import pytest

from embed.aesthetic import score_embeddings


def test_score_applies_linear_head_after_l2_normalize():
    w = np.array([1.0, 0.0, 0.0])
    b = 2.0
    # Unnormalized input along x → normalizes to [1,0,0] → 1*1 + 2 = 3.0
    assert score_embeddings(np.array([3.0, 0.0, 0.0]), w, b)[0] == pytest.approx(3.0)
    # Orthogonal direction → 0*1 + 2 = 2.0
    assert score_embeddings(np.array([0.0, 5.0, 0.0]), w, b)[0] == pytest.approx(2.0)


def test_score_is_batched():
    w = np.array([0.0, 1.0])
    b = 0.0
    emb = np.array([[1.0, 0.0], [0.0, 1.0], [0.0, -2.0]])
    out = score_embeddings(emb, w, b)
    assert out.shape == (3,)
    assert out[0] == pytest.approx(0.0)
    assert out[1] == pytest.approx(1.0)
    assert out[2] == pytest.approx(-1.0)  # normalized to [0,-1] → -1


def test_normalization_is_scale_invariant():
    w = np.array([0.3, -0.7, 0.5])
    b = 1.1
    e = np.array([2.0, -1.0, 0.5])
    a = score_embeddings(e, w, b)[0]
    b2 = score_embeddings(e * 100.0, w, b)[0]
    assert abs(a - b2) < 1e-9
