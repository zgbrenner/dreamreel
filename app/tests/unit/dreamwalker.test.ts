import { describe, it, expect } from 'vitest';
import {
  createDreamwalker,
  type DreamwalkerPools,
  type DreamLayer,
} from '../../src/dream/dreamwalker';
import { parseManifest } from '../../src/manifest/loader';
import seed from '../../public/manifest.seed.json';

const manifest = parseManifest(seed);
const pools: DreamwalkerPools = {
  visual: manifest.assets,
  texts: manifest.texts,
  moodAxes: manifest.moodAxes,
  embeddingDim: manifest.embeddingDim,
};

function imageSequence(seedStr: string, surreality: number, n: number): string[] {
  const w = createDreamwalker(pools, { seed: seedStr, surreality });
  return Array.from({ length: n }, () => w.next('image', 1).asset.id);
}

/** Mean Shannon entropy (bits) of the softmax selection distribution over `n` image picks. */
function meanSelectionEntropy(seedStr: string, surreality: number, n: number): number {
  let total = 0;
  let count = 0;
  const w = createDreamwalker(pools, { seed: seedStr, surreality }, {
    onSelect: (layer: DreamLayer, h: number) => {
      if (layer === 'image') {
        total += h;
        count++;
      }
    },
  });
  for (let i = 0; i < n; i++) w.next('image', 1);
  return total / count;
}

describe('Dreamwalker determinism', () => {
  it('same seed + surreality yields an identical asset-id sequence across fresh instances', () => {
    const a = imageSequence('reel-7', 0.5, 50);
    const b = imageSequence('reel-7', 0.5, 50);
    expect(a).toEqual(b);
  });

  it('different seeds diverge', () => {
    const a = imageSequence('reel-7', 0.5, 50);
    const b = imageSequence('reel-8', 0.5, 50);
    expect(a).not.toEqual(b);
  });

  it('reseed resets the walk deterministically', () => {
    const w = createDreamwalker(pools, { seed: 'x', surreality: 0.4 });
    const first = Array.from({ length: 20 }, () => w.next('image', 1).asset.id);
    w.reseed('y');
    w.reseed('x');
    const again = Array.from({ length: 20 }, () => w.next('image', 1).asset.id);
    expect(again).toEqual(first);
  });
});

describe('Dreamwalker surreality controls entropy', () => {
  it('surreality 0 is near-argmax (low selection entropy); surreality 1 is near-uniform', () => {
    const calm = meanSelectionEntropy('mood', 0, 400);
    const wild = meanSelectionEntropy('mood', 1, 400);
    // The softmax temperature IS the surreality control: low surreality => peaked picks.
    expect(wild).toBeGreaterThan(calm + 0.5);
  });
});

describe('Dreamwalker anti-repeat', () => {
  it('no id repeats within any window of 6 (across surreality range)', () => {
    for (const s of [0, 0.5, 1]) {
      const ids = imageSequence(`win-${s}`, s, 200);
      for (let i = 0; i < ids.length; i++) {
        const window = ids.slice(Math.max(0, i - 5), i);
        expect(window).not.toContain(ids[i]);
      }
    }
  });
});

describe('Dreamwalker layers', () => {
  it('text layer draws from the text pool and ghost from the visual pool', () => {
    const w = createDreamwalker(pools, { seed: 'layers', surreality: 0.5 });
    const textIds = new Set(manifest.texts.map((t) => t.id));
    const visualIds = new Set(manifest.assets.map((a) => a.id));
    for (let i = 0; i < 20; i++) {
      expect(textIds.has(w.next('text', 1).asset.id)).toBe(true);
      expect(visualIds.has(w.next('ghost', 1).asset.id)).toBe(true);
    }
  });

  it('currentMood returns all six axes in 0..1', () => {
    const w = createDreamwalker(pools, { seed: 'm', surreality: 0.5 });
    w.next('image', 1);
    const mood = w.currentMood();
    const keys = Object.keys(mood);
    expect(keys).toHaveLength(6);
    for (const v of Object.values(mood)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
