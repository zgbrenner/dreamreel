import { describe, it, expect } from 'vitest';
import { createIntensityEngine } from '../../src/dream/intensity';

function series(seed: string, n: number, step: number) {
  const eng = createIntensityEngine(seed);
  return Array.from({ length: n }, (_, i) => eng.sample(i * step));
}

describe('IntensityEngine determinism', () => {
  it('same seed yields an identical intensity series', () => {
    const a = series('reel-7', 200, 0.25).map((s) => s.intensity);
    const b = series('reel-7', 200, 0.25).map((s) => s.intensity);
    expect(a).toEqual(b);
  });

  it('different seeds diverge', () => {
    const a = series('reel-7', 200, 0.25).map((s) => s.intensity);
    const b = series('reel-8', 200, 0.25).map((s) => s.intensity);
    expect(a).not.toEqual(b);
  });
});

describe('IntensityEngine range + sporadicity', () => {
  it('intensity always stays within [0,1]', () => {
    for (const s of series('range', 1000, 0.1)) {
      expect(s.intensity).toBeGreaterThanOrEqual(0);
      expect(s.intensity).toBeLessThanOrEqual(1);
    }
  });

  it('is sporadic: high frame-to-frame variance, not a smooth ramp', () => {
    const xs = series('spor', 600, 0.1).map((s) => s.intensity);
    let jumps = 0;
    for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - xs[i - 1]) > 0.15) jumps++;
    expect(jumps).toBeGreaterThan(40);
  });
});

describe('IntensityEngine troughs (coherent moments)', () => {
  it('troughs are regular and lingering over 5 minutes (more frequent + longer than before)', () => {
    const eng = createIntensityEngine('troughs');
    const ids = new Set<number>();
    let troughSamples = 0;
    const total = 3000; // 300 logical seconds at 0.1s step
    for (let i = 0; i < total; i++) {
      const s = eng.sample(i * 0.1);
      if (s.inTrough) { troughSamples++; ids.add(s.troughId); }
    }
    // gaps 14..30s + 4s duration => ~9-16 troughs over 300s (was 5-14, rarer + briefer)
    expect(ids.size).toBeGreaterThanOrEqual(8);
    expect(ids.size).toBeLessThanOrEqual(20);
    // lucid time is now a meaningful slice (was <0.15), but still not dominating
    expect(troughSamples / total).toBeGreaterThan(0.1);
    expect(troughSamples / total).toBeLessThan(0.3);
  });

  it('intensity is low inside a trough and high outside', () => {
    const eng = createIntensityEngine('lowhigh');
    let inSum = 0, inN = 0, outMax = 0;
    for (let i = 0; i < 3000; i++) {
      const s = eng.sample(i * 0.1);
      if (s.inTrough) { inSum += s.intensity; inN++; }
      else outMax = Math.max(outMax, s.intensity);
    }
    expect(inN).toBeGreaterThan(0);
    expect(inSum / inN).toBeLessThan(0.25);
    expect(outMax).toBeGreaterThan(0.75);
  });
});

describe('IntensityEngine clamp (reduced-motion / future safety)', () => {
  it('setMaxIntensity caps the envelope', () => {
    const eng = createIntensityEngine('clamp');
    eng.setMaxIntensity(0.4);
    for (let i = 0; i < 1000; i++) {
      expect(eng.sample(i * 0.1).intensity).toBeLessThanOrEqual(0.4 + 1e-9);
    }
  });
});
