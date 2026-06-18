import { describe, it, expect } from 'vitest';
import { planLayers, MAX_LAYERS } from '../../src/dream/layerPlan';
import { makeRng } from '../../src/dream/prng';

const rng = () => makeRng('plan');

describe('planLayers density bands', () => {
  it('trough intensity -> 1..3 layers (band A)', () => {
    const p = planLayers(0.08, rng());
    expect(p.layerCount).toBeGreaterThanOrEqual(1);
    expect(p.layerCount).toBeLessThanOrEqual(3);
  });
  it('baseline intensity -> 4..6 layers (band B)', () => {
    const p = planLayers(0.5, rng());
    expect(p.layerCount).toBeGreaterThanOrEqual(4);
    expect(p.layerCount).toBeLessThanOrEqual(6);
  });
  it('frenzy intensity -> 7..MAX layers (band C)', () => {
    const p = planLayers(0.95, rng());
    expect(p.layerCount).toBeGreaterThanOrEqual(7);
    expect(p.layerCount).toBeLessThanOrEqual(MAX_LAYERS);
  });
  it('layer count is monotonic across the range', () => {
    const lo = planLayers(0.05, rng()).layerCount;
    const mid = planLayers(0.5, rng()).layerCount;
    const hi = planLayers(0.95, rng()).layerCount;
    expect(mid).toBeGreaterThanOrEqual(lo);
    expect(hi).toBeGreaterThanOrEqual(mid);
  });
  it('feedback and warp rise with intensity and stay 0..1', () => {
    const lo = planLayers(0.05, rng());
    const hi = planLayers(0.95, rng());
    expect(hi.feedback).toBeGreaterThan(lo.feedback);
    expect(hi.warp).toBeGreaterThan(lo.warp);
    for (const p of [lo, hi]) {
      expect(p.feedback).toBeGreaterThanOrEqual(0);
      expect(p.feedback).toBeLessThanOrEqual(1);
      expect(p.warp).toBeGreaterThanOrEqual(0);
      expect(p.warp).toBeLessThanOrEqual(1);
    }
  });
  it('emits one blend per active layer', () => {
    const p = planLayers(0.95, rng());
    expect(p.blends).toHaveLength(p.layerCount);
  });
});
