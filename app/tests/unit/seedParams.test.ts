import { describe, it, expect } from 'vitest';
import { deriveSeedParams } from '../../src/dream/seedParams';

describe('deriveSeedParams', () => {
  it('is deterministic: same seed → same params', () => {
    const a = deriveSeedParams('hello-7');
    const b = deriveSeedParams('hello-7');
    expect(a).toEqual(b);
  });

  it('keeps params within their valid ranges', () => {
    for (const seed of ['a', 'b', 'frenzied', 'calm', 'xyz123', '0', 'a-very-long-seed-string']) {
      const { surreality, tempo } = deriveSeedParams(seed);
      expect(surreality).toBeGreaterThanOrEqual(0);
      expect(surreality).toBeLessThan(1);
      expect(tempo).toBeGreaterThanOrEqual(0.5);
      expect(tempo).toBeLessThan(2);
    }
  });

  it('gives different seeds different character (variety lives across dreams)', () => {
    const seeds = Array.from({ length: 24 }, (_, i) => `seed-${i}`);
    const surrealities = new Set(seeds.map((s) => deriveSeedParams(s).surreality.toFixed(4)));
    const tempos = new Set(seeds.map((s) => deriveSeedParams(s).tempo.toFixed(4)));
    // Distinct seeds should produce a spread of values, not a single constant.
    expect(surrealities.size).toBeGreaterThan(20);
    expect(tempos.size).toBeGreaterThan(20);
  });
});
