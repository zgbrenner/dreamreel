"""Tests for embed.sprite_clips pure helpers (grid layout, union box, sheet assembly)."""

from __future__ import annotations

import numpy as np
from PIL import Image

from embed.sprite_clips import assemble_sheet, grid_dims, union_box


def test_grid_dims():
    assert grid_dims(12) == (4, 3)
    assert grid_dims(2) == (2, 1)
    assert grid_dims(1) == (1, 1)
    assert grid_dims(5) == (4, 2)  # 4 cols → 2 rows


def test_union_box_covers_all_frames():
    m1 = np.zeros((10, 10), bool)
    m1[2:4, 3:5] = True
    m2 = np.zeros((10, 10), bool)
    m2[6:8, 1:2] = True
    # union over x: 1..5, over y: 2..8
    assert union_box([m1, m2]) == (1, 2, 5, 8)


def test_union_box_empty():
    assert union_box([np.zeros((5, 5), bool)]) is None


def test_assemble_sheet_grid_layout():
    cells = [Image.new("RGBA", (8, 6), (i * 20, 0, 0, 255)) for i in range(5)]
    sheet, cw, ch = assemble_sheet(cells, cols=4)
    assert (cw, ch) == (8, 6)
    # 5 cells, 4 cols → 2 rows → sheet 32x12
    assert sheet.size == (32, 12)
    # cell 4 lands at row 1, col 0 (origin 0, ch)
    assert sheet.getpixel((1, 7))[0] == 80  # i=4 → red 80
