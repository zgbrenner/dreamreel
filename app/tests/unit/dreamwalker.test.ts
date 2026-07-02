import { describe, it, expect } from 'vitest';
import {
  createDreamwalker,
  aestheticBoost,
  type DreamwalkerPools,
  type DreamLayer,
} from '../../src/dream/dreamwalker';
import { cosine } from '../../src/dream/mood';
import { MOOD_AXES, type Asset, type MoodAxis } from '../../src/manifest/types';
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

  it('title cards are sparse punctuation: never two within the minimum beat gap', () => {
    // Even at maximum surreality (the most card-prone dream), consecutive cards must be
    // separated by at least 8 image beats — an intertitle is punctuation, not a medium.
    const w = createDreamwalker(pools, { seed: 'card-gap', surreality: 1 });
    let lastCardBeat = -Infinity;
    for (let beat = 1; beat <= 800; beat++) {
      if (w.next('image', 1).titleCard) {
        expect(beat - lastCardBeat).toBeGreaterThanOrEqual(8);
        lastCardBeat = beat;
      }
    }
  });

  it('currentMood returns all axes in 0..1', () => {
    const w = createDreamwalker(pools, { seed: 'm', surreality: 0.5 });
    w.next('image', 1);
    const mood = w.currentMood();
    const keys = Object.keys(mood);
    expect(keys.sort()).toEqual([...MOOD_AXES].sort());
    for (const v of Object.values(mood)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('Dreamwalker aesthetic bias', () => {
  // A synthetic pool where every asset shares ONE embedding (so the spatial cosine term is equal
  // for all) — selection differences then come ONLY from the aesthetic bias + anti-repeat.
  function synthPools(nHigh: number, nLow: number): DreamwalkerPools {
    const moodAxes = Object.fromEntries(MOOD_AXES.map((a) => [a, [0, 0, 0, 0]])) as Record<
      MoodAxis,
      number[]
    >;
    const neutralMood = Object.fromEntries(MOOD_AXES.map((a) => [a, 0.5])) as Record<MoodAxis, number>;
    const mk = (id: string, aesthetic: number): Asset => ({
      id,
      type: 'image',
      embedding: [1, 0, 0, 0],
      mood: neutralMood,
      tags: [],
      dwellBase: 5,
      source: 'x',
      license: 'PD',
      aesthetic,
    });
    const assets: Asset[] = [];
    for (let i = 0; i < nHigh; i++) assets.push(mk(`hi-${i}`, 8.0));
    for (let i = 0; i < nLow; i++) assets.push(mk(`lo-${i}`, 3.0));
    return { visual: assets, texts: assets, moodAxes, embeddingDim: 4 };
  }

  it('aestheticBoost: 0 when absent, positive above neutral, negative below, monotonic', () => {
    expect(aestheticBoost(undefined)).toBe(0);
    expect(aestheticBoost(5.5)).toBeCloseTo(0, 6);
    expect(aestheticBoost(8)).toBeGreaterThan(0);
    expect(aestheticBoost(3)).toBeLessThan(0);
    expect(aestheticBoost(9)).toBeGreaterThan(aestheticBoost(7));
  });

  it('leans image selection toward higher-aesthetic assets without collapsing variety', () => {
    const w = createDreamwalker(synthPools(5, 5), { seed: 'aes', surreality: 0.5 });
    let hi = 0;
    let lo = 0;
    for (let i = 0; i < 600; i++) {
      const id = w.next('image', 1).asset.id;
      if (id.startsWith('hi')) hi++;
      else lo++;
    }
    expect(hi).toBeGreaterThan(lo); // pretty assets surface more
    expect(lo).toBeGreaterThan(0); // ...but the low ones still appear (variety preserved)
  });

  it('aesthetic-biased selection is deterministic per seed', () => {
    const seq = () => {
      const w = createDreamwalker(synthPools(5, 5), { seed: 'aes-det', surreality: 0.5 });
      return Array.from({ length: 40 }, () => w.next('image', 1).asset.id);
    };
    expect(seq()).toEqual(seq());
  });
});

describe('Dreamwalker recurrence bias', () => {
  // Same embedding for every asset, so selection differences come ONLY from the recurrence echo.
  function entityPools(nEcho: number, nPlain: number): DreamwalkerPools {
    const moodAxes = Object.fromEntries(MOOD_AXES.map((a) => [a, [0, 0, 0, 0]])) as Record<
      MoodAxis,
      number[]
    >;
    const neutralMood = Object.fromEntries(MOOD_AXES.map((a) => [a, 0.5])) as Record<MoodAxis, number>;
    const mk = (id: string, entities: string[]): Asset => ({
      id,
      type: 'image',
      embedding: [1, 0, 0, 0],
      mood: neutralMood,
      tags: [],
      dwellBase: 5,
      source: 'x',
      license: 'PD',
      entities,
    });
    const assets: Asset[] = [];
    for (let i = 0; i < nEcho; i++) assets.push(mk(`echo-${i}`, ['clock']));
    for (let i = 0; i < nPlain; i++) assets.push(mk(`plain-${i}`, ['void']));
    return { visual: assets, texts: assets, moodAxes, embeddingDim: 4 };
  }

  // A standing memory of the "clock" motif.
  const clockEcho = (e: string[] | undefined) => (e && e.includes('clock') ? 1.0 : 0);

  it('leans selection toward candidates that echo memory; no echo set → unbiased', () => {
    const biased = createDreamwalker(entityPools(5, 5), { seed: 'rec', surreality: 0.5 });
    biased.setRecurrence(clockEcho);
    const plain = createDreamwalker(entityPools(5, 5), { seed: 'rec', surreality: 0.5 });
    const count = (w: ReturnType<typeof createDreamwalker>) => {
      let n = 0;
      for (let i = 0; i < 600; i++) if (w.next('image', 1).asset.id.startsWith('echo')) n++;
      return n;
    };
    const withMemory = count(biased);
    const without = count(plain);
    expect(withMemory).toBeGreaterThan(without); // the remembered motif recurs
    expect(without).toBeGreaterThan(0); // ...without collapsing variety
  });

  it('clearing the echo removes the bias', () => {
    const a = createDreamwalker(entityPools(5, 5), { seed: 'rec2', surreality: 0.5 });
    a.setRecurrence(clockEcho);
    a.setRecurrence(null);
    const b = createDreamwalker(entityPools(5, 5), { seed: 'rec2', surreality: 0.5 });
    const seqA = Array.from({ length: 40 }, () => a.next('image', 1).asset.id);
    const seqB = Array.from({ length: 40 }, () => b.next('image', 1).asset.id);
    expect(seqA).toEqual(seqB);
  });

  it('recurrence-biased selection is deterministic per seed', () => {
    const seq = () => {
      const w = createDreamwalker(entityPools(5, 5), { seed: 'rec-det', surreality: 0.5 });
      w.setRecurrence(clockEcho);
      return Array.from({ length: 40 }, () => w.next('image', 1).asset.id);
    };
    expect(seq()).toEqual(seq());
  });
});

describe('Dreamwalker convergence', () => {
  function meanAdjacentSimilarity(convergence: boolean, n: number): number {
    const w = createDreamwalker(pools, { seed: 'converge', surreality: 0.8 });
    w.setConvergence(convergence);
    const embs = Array.from({ length: n }, () => w.next('image', 1).asset.embedding);
    let s = 0;
    for (let i = 1; i < embs.length; i++) s += cosine(embs[i - 1], embs[i]);
    return s / (embs.length - 1);
  }

  it('convergence makes successive image picks more similar than the chaotic walk', () => {
    const chaotic = meanAdjacentSimilarity(false, 80);
    const converged = meanAdjacentSimilarity(true, 80);
    expect(converged).toBeGreaterThan(chaotic + 0.05);
  });

  it('toggling convergence off restores the chaotic walk and stays deterministic', () => {
    const a = createDreamwalker(pools, { seed: 'z', surreality: 0.6 });
    const b = createDreamwalker(pools, { seed: 'z', surreality: 0.6 });
    a.setConvergence(true); a.setConvergence(false);
    const seqA = Array.from({ length: 30 }, () => a.next('image', 1).asset.id);
    const seqB = Array.from({ length: 30 }, () => b.next('image', 1).asset.id);
    expect(seqA).toEqual(seqB);
  });
});
