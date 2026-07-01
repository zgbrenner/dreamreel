import { describe, it, expect } from 'vitest';
import { planLayers } from '../../src/dream/layerPlan';
import { makeRng } from '../../src/dream/prng';

const rng = () => makeRng('plan');

describe('planLayers density bands', () => {
  it('trough intensity keeps one clear media hero', () => {
    const p = planLayers(0.08, rng());
    expect(p.layerCount).toBe(1);
  });
  it('baseline intensity keeps one clear media hero', () => {
    const p = planLayers(0.5, rng());
    expect(p.layerCount).toBe(1);
  });
  it('frenzy intensity uses restrained double/triple exposure', () => {
    const p = planLayers(0.95, rng());
    expect(p.layerCount).toBeGreaterThanOrEqual(2);
    expect(p.layerCount).toBeLessThanOrEqual(3);
  });
  it('layer count is monotonic across the range', () => {
    const lo = planLayers(0.05, rng()).layerCount;
    const mid = planLayers(0.5, rng()).layerCount;
    const hi = planLayers(0.95, rng()).layerCount;
    expect(mid).toBeGreaterThanOrEqual(lo);
    expect(hi).toBeGreaterThanOrEqual(mid);
  });
  it('feedback stays off until high intensity and warp stays restrained', () => {
    const lo = planLayers(0.05, rng());
    const mid = planLayers(0.5, rng());
    const hi = planLayers(0.95, rng());
    expect(lo.feedback).toBe(0);
    expect(mid.feedback).toBe(0);
    expect(hi.feedback).toBeGreaterThan(lo.feedback);
    expect(hi.warp).toBeGreaterThan(lo.warp);
    for (const p of [lo, hi]) {
      expect(p.feedback).toBeGreaterThanOrEqual(0);
      expect(p.feedback).toBeLessThanOrEqual(1);
      expect(p.warp).toBeGreaterThanOrEqual(0);
      expect(p.warp).toBeLessThanOrEqual(0.35);
    }
  });
  it('emits one blend per active layer', () => {
    const p = planLayers(0.95, rng());
    expect(p.blends).toHaveLength(p.layerCount);
  });
});
