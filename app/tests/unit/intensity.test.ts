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

describe('IntensityEngine range', () => {
  it('intensity always stays within [0,1]', () => {
    for (const s of series('range', 1000, 0.1)) {
      expect(s.intensity).toBeGreaterThanOrEqual(0);
      expect(s.intensity).toBeLessThanOrEqual(1);
    }
  });
});

describe('IntensityEngine coherent baseline (2026 inversion)', () => {
  // Resting state is LOW/coherent; high-intensity escalation is the occasional departure.
  it('spends most of the time calm, with high intensity a minority and frenzy rare', () => {
    const xs = series('balance', 6000, 0.1); // 600 logical seconds
    const intens = xs.map((s) => s.intensity);
    const mean = intens.reduce((a, b) => a + b, 0) / intens.length;
    const calm = intens.filter((v) => v < 0.4).length / intens.length;
    const hot = intens.filter((v) => v > 0.6).length / intens.length;
    const frenzy = xs.filter((s) => s.regime === 'frenzy').length / xs.length;

    expect(mean).toBeLessThan(0.45); // the dream rests low, not in constant churn
    expect(calm).toBeGreaterThan(0.5); // coherent baseline dominates wall-clock time
    expect(hot).toBeLessThan(0.35); // escalation is a departure, not the default
    expect(frenzy).toBeGreaterThan(0); // ...but it does happen
    expect(frenzy).toBeLessThan(0.3);
  });

  it('still escalates: surges push intensity to a high peak somewhere in a long run', () => {
    const peak = Math.max(...series('peaks', 6000, 0.1).map((s) => s.intensity));
    expect(peak).toBeGreaterThan(0.85);
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

  it('intensity is low inside a trough; surges still reach high outside', () => {
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
