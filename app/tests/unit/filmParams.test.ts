import { describe, it, expect } from 'vitest';
import { defaultFilmParams } from '../../src/render/filmParams';

describe('filmParams new fields', () => {
  it('exposes warp and filmGrade with sane defaults', () => {
    const p = defaultFilmParams();
    expect(p.warp).toBe(0);
    expect(p.filmGrade).toBeGreaterThan(0);
    expect(p.filmGrade).toBeLessThanOrEqual(1);
  });
});
