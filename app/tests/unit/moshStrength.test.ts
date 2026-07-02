// moshStrength: the datamosh smear is a nightmare-surge-only treatment (part of the look brain).
import { describe, it, expect } from 'vitest';
import { moshStrength } from '../../src/dream/filterDirector';

describe('moshStrength', () => {
  it('is zero at the coherent baseline and in troughs regardless of intensity', () => {
    expect(moshStrength(0.16, 'baseline', false)).toBe(0);
    expect(moshStrength(0.9, 'baseline', false)).toBe(0);
    expect(moshStrength(0.06, 'trough', false)).toBe(0);
  });

  it('is zero under reduced motion even at a frenzy peak', () => {
    expect(moshStrength(0.95, 'frenzy', true)).toBe(0);
  });

  it('ramps in quadratically above ~0.7 inside a frenzy, capped below 1', () => {
    expect(moshStrength(0.65, 'frenzy', false)).toBe(0);
    const mid = moshStrength(0.8, 'frenzy', false);
    const peak = moshStrength(0.95, 'frenzy', false);
    expect(mid).toBeGreaterThan(0);
    expect(peak).toBeGreaterThan(mid);
    expect(peak).toBeLessThanOrEqual(0.8);
  });
});
