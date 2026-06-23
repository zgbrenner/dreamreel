import { describe, it, expect } from 'vitest';
import { createDreamwalker, type DreamwalkerPools } from '../../src/dream/dreamwalker';
import { MOOD_AXES, type Asset, type MoodAxis } from '../../src/manifest/types';

// All assets share one embedding so cosine is equal for every candidate — the ONLY selection
// bias left is the type weight. Without weighting, a 50/50 video/image pool picks ~50% video.
function asset(id: string, type: Asset['type']): Asset {
  return {
    id,
    type,
    src: 'x',
    embedding: [1, 0, 0, 0],
    mood: Object.fromEntries(MOOD_AXES.map((a) => [a, 0])) as Record<MoodAxis, number>,
    tags: [],
    dwellBase: 6,
    source: 's',
    license: 'PD',
  };
}

function videoFraction(seedStr: string): number {
  const visual: Asset[] = [];
  for (let i = 0; i < 10; i++) {
    visual.push(asset(`img-${i}`, 'image'));
    visual.push(asset(`vid-${i}`, 'video'));
  }
  // The constructor guards against an empty text pool, so provide one dummy text asset.
  // The test only calls next('image', …) so the text pool does not influence the result.
  const texts: Asset[] = [asset('txt-0', 'image')];
  const pools: DreamwalkerPools = {
    visual,
    texts,
    moodAxes: Object.fromEntries(MOOD_AXES.map((a) => [a, [0, 0, 0, 0]])) as Record<MoodAxis, number[]>,
    embeddingDim: 4,
  };
  const w = createDreamwalker(pools, { seed: seedStr, surreality: 0.4 });
  let vids = 0;
  const N = 600;
  for (let i = 0; i < N; i++) if (w.next('image', 1).asset.type === 'video') vids++;
  return vids / N;
}

describe('Dreamwalker video weighting', () => {
  it('lifts scarce video well above its raw 50% share when embeddings are equal', () => {
    const f = videoFraction('vidw');
    expect(f).toBeGreaterThan(0.72); // 7.0x weight pushes to ~0.875; bound tightened from 0.6
    expect(f).toBeLessThan(0.95); // still selects images too
  });

  it('is deterministic across fresh instances', () => {
    expect(videoFraction('same')).toBe(videoFraction('same'));
  });
});
