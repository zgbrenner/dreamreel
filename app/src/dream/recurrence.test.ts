// app/src/dream/recurrence.test.ts
//
// Recurrence wiring: the dreamwalker leans toward candidates whose entities ECHO the dream's current
// memory, so motifs return — but the lean is BOUNDED (the echo is clamped at RECUR_ECHO_CAP) so a
// heavily-remembered motif colours the dream without collapsing its variety, and it's OFF by default
// (a manifest with no entities / no recurrence hook walks exactly as before). These tests pin that
// integration through the public DreamWalker API (the boost lives in the private `weigh`, exercised
// via `next`), complementing the pure DreamMemory tests in memory.test.ts.

import { describe, it, expect } from 'vitest';
import {
  createDreamwalker,
  RECUR_ECHO_CAP,
  type DreamwalkerPools,
} from './dreamwalker';
import type { Asset } from '../manifest/types';
import { parseManifest } from '../manifest/loader';
import seed from '../../public/manifest.seed.json';

const manifest = parseManifest(seed);

// The seed manifest carries no baked entities, so tag a deterministic half of the visual pool with a
// single motif ('clock'). Cloning keeps the shared manifest assets untouched; only `entities` is added,
// which affects nothing but the recurrence boost — so baseline vs biased runs differ ONLY by recurrence.
const MOTIF = 'clock';
const taggedVisual: Asset[] = manifest.assets.map((a, i) =>
  i % 2 === 0 ? { ...a, entities: [MOTIF] } : { ...a },
);
const pools: DreamwalkerPools = {
  visual: taggedVisual,
  texts: manifest.texts,
  moodAxes: manifest.moodAxes,
  embeddingDim: manifest.embeddingDim,
};

const SEED = 'recur-seed';
const BEATS = 200;

/** Walk `n` image beats and return the chosen asset ids, with an optional recurrence echo installed. */
function imageIds(echo: ((entities: string[] | undefined) => number) | null): string[] {
  const w = createDreamwalker(pools, { seed: SEED, surreality: 0.6 });
  w.setRecurrence(echo);
  const ids: string[] = [];
  for (let i = 0; i < BEATS; i++) ids.push(w.next('image', 1).asset.id);
  return ids;
}

const motifCount = (ids: string[]): number =>
  ids.filter((id) => taggedVisual.find((a) => a.id === id)?.entities?.includes(MOTIF)).length;

describe('recurrence — off by default', () => {
  it('no recurrence hook walks identically to an explicit null hook (graceful no-op)', () => {
    const notSet = (() => {
      const w = createDreamwalker(pools, { seed: SEED, surreality: 0.6 });
      const ids: string[] = [];
      for (let i = 0; i < BEATS; i++) ids.push(w.next('image', 1).asset.id);
      return ids;
    })();
    expect(imageIds(null)).toEqual(notSet);
  });
});

describe('recurrence — biases selection toward remembered motifs', () => {
  it('an echo that favours the motif makes it recur more than baseline', () => {
    const baseline = motifCount(imageIds(null));
    const biased = motifCount(imageIds((e) => (e?.includes(MOTIF) ? RECUR_ECHO_CAP : 0)));
    expect(biased).toBeGreaterThan(baseline);
  });

  it('a stronger echo recurs the motif at least as often as a weaker one (monotonic lean)', () => {
    const weak = motifCount(imageIds((e) => (e?.includes(MOTIF) ? 0.5 : 0)));
    const strong = motifCount(imageIds((e) => (e?.includes(MOTIF) ? RECUR_ECHO_CAP : 0)));
    expect(strong).toBeGreaterThanOrEqual(weak);
  });
});

describe('recurrence — bounded (the echo is clamped at RECUR_ECHO_CAP)', () => {
  it('an enormous echo behaves identically to one capped at RECUR_ECHO_CAP — no runaway fixation', () => {
    const capped = imageIds((e) => (e?.includes(MOTIF) ? RECUR_ECHO_CAP : 0));
    const enormous = imageIds((e) => (e?.includes(MOTIF) ? 1e6 : 0));
    expect(enormous).toEqual(capped); // clamp makes them bit-for-bit identical
    // ...and the clamp is actually engaging (the capped run diverges from the unbiased spine).
    expect(capped).not.toEqual(imageIds(null));
  });
});

describe('recurrence — deterministic', () => {
  it('same seed + same echo fn reproduces the exact pick sequence', () => {
    const echo = (e: string[] | undefined): number => (e?.includes(MOTIF) ? 2.0 : 0);
    expect(imageIds(echo)).toEqual(imageIds(echo));
  });
});
