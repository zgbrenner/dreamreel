import { describe, it, expect } from 'vitest';
import { coherenceForTrough, type CoherenceKind } from '../../src/dream/coherence';

describe('coherenceForTrough', () => {
  it('is deterministic for a given seed + troughId', () => {
    expect(coherenceForTrough('s', 3)).toBe(coherenceForTrough('s', 3));
  });

  it('approximates 50/35/15 over many troughs', () => {
    const counts: Record<CoherenceKind, number> = { rhyme: 0, lucid: 0, phrase: 0 };
    const N = 6000;
    for (let i = 0; i < N; i++) counts[coherenceForTrough('dist', i)]++;
    expect(counts.rhyme / N).toBeGreaterThan(0.45);
    expect(counts.rhyme / N).toBeLessThan(0.55);
    expect(counts.lucid / N).toBeGreaterThan(0.30);
    expect(counts.lucid / N).toBeLessThan(0.40);
    expect(counts.phrase / N).toBeGreaterThan(0.11);
    expect(counts.phrase / N).toBeLessThan(0.19);
  });
});
