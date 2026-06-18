import { describe, it, expect } from 'vitest';
import { defaultFilmParams } from '../../src/render/filmParams';

describe('filmParams new fields', () => {
  it('exposes warp and filmGrade with sane defaults', () => {
    const p = defaultFilmParams();
    expect(p.warp).toBe(0);
    // filmGrade MUST default to exactly 1 — that identity keeps the non-wake reel
    // byte-identical to before (mix(raw, graded, 1) === graded).
    expect(p.filmGrade).toBe(1);
  });
});
