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

/**
 * Mean Shannon entropy (bits) of the softmax selection distribution over `n` image picks,
 * alongside the mean *maximum* entropy log2(candidateCount). The ratio meanH/meanMaxH is the
 * "how close to uniform" measure: ~1 is near-uniform, lower is more peaked toward the argmax.
 */
function meanSelectionStats(
  seedStr: string,
  surreality: number,
  n: number,
): { meanH: number; meanMaxH: number; uniformity: number } {
  let total = 0;
  let totalMax = 0;
  let count = 0;
  const w = createDreamwalker(pools, { seed: seedStr, surreality }, {
    onSelect: (layer: DreamLayer, h: number, candidateCount: number) => {
      if (layer === 'image') {
        total += h;
        totalMax += Math.log2(candidateCount);
        count++;
      }
    },
  });
  for (let i = 0; i < n; i++) w.next('image', 1);
  return { meanH: total / count, meanMaxH: totalMax / count, uniformity: total / totalMax };
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
  it('surreality 0 is measurably more peaked than surreality 1, which is near-uniform', () => {
    const calm = meanSelectionStats('mood', 0, 400);
    const mid = meanSelectionStats('mood', 0.5, 400);
    const wild = meanSelectionStats('mood', 1, 400);

    // The softmax temperature IS the surreality control: low surreality => peaked picks,
    // high surreality => the distribution flattens out toward uniform.
    expect(wild.meanH).toBeGreaterThan(calm.meanH + 0.5); // clearly higher entropy when wild
    expect(mid.meanH).toBeGreaterThan(calm.meanH); // monotone-ish across the range
    expect(wild.meanH).toBeGreaterThan(mid.meanH - 1e-9);

    // surreality 1 sits right up against the maximum possible entropy (near-uniform picks).
    expect(wild.uniformity).toBeGreaterThan(0.9);
    // surreality 0 is concentrated well below uniform (argmax-leaning).
    expect(calm.uniformity).toBeLessThan(0.8);
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

  it('interjects title cards sourced from the titlecard texts, never repeating in-window', () => {
    const cardTags = new Set(['card', 'intertitle', 'titlecard']);
    const cardIds = new Set(
      manifest.texts.filter((t) => t.tags.some((x) => cardTags.has(x))).map((t) => t.id),
    );
    expect(cardIds.size).toBeGreaterThan(0); // seed manifest carries intertitle cards

    // High surreality maximises the card-interjection probability.
    const w = createDreamwalker(pools, { seed: 'cards', surreality: 1 });
    const ids: string[] = [];
    let cardBeats = 0;
    for (let i = 0; i < 600; i++) {
      const beat = w.next('image', 1);
      ids.push(beat.asset.id);
      if (beat.titleCard) {
        cardBeats++;
        // a title-card beat must be one of the card texts and carry its text
        expect(cardIds.has(beat.asset.id)).toBe(true);
        expect(typeof beat.asset.text).toBe('string');
        expect((beat.asset.text ?? '').length).toBeGreaterThan(0);
      } else {
        // non-card image beats never draw from the card pool
        expect(cardIds.has(beat.asset.id)).toBe(false);
      }
    }
    expect(cardBeats).toBeGreaterThan(0); // cards do get interjected over a long run

    // Cards participate in the same anti-repeat window as picks.
    for (let i = 0; i < ids.length; i++) {
      const window = ids.slice(Math.max(0, i - 5), i);
      expect(window).not.toContain(ids[i]);
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
