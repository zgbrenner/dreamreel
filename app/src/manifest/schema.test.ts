// app/src/manifest/schema.test.ts
import { describe, it, expect } from 'vitest';
import { manifestSchema } from './schema';
import { MOOD_AXES } from './types';

// Build axis records covering the FULL axis set so the fixtures track the contract automatically.
const moodAxesFixture = () =>
  Object.fromEntries(MOOD_AXES.map((a) => [a, [0, 0]])) as Record<(typeof MOOD_AXES)[number], number[]>;

const base = () => ({
  version: '1', createdAt: 'now', embeddingDim: 2,
  moodAxes: moodAxesFixture(),
  assets: [], texts: [],
  audioEmbeddingDim: 2,
  audio: [] as unknown[],
});

const mood = Object.fromEntries(MOOD_AXES.map((a) => [a, 0.5])) as Record<
  (typeof MOOD_AXES)[number],
  number
>;

describe('manifest audio schema', () => {
  it('accepts a valid audio asset', () => {
    const m = base();
    m.audio = [{
      id: 'm1', kind: 'music', src: 'https://r/x.m4a',
      embedding: [0.1, 0.2], mood, tags: ['piano'],
      durationSec: 80, loopable: false, dwellBase: 60,
      source: 'Musopen', license: 'PD',
    }];
    expect(manifestSchema.safeParse(m).success).toBe(true);
  });

  it('rejects an audio embedding whose length != audioEmbeddingDim', () => {
    const m = base();
    m.audio = [{
      id: 'm1', kind: 'music', src: 'https://r/x.m4a',
      embedding: [0.1, 0.2, 0.3], mood, tags: [],
      durationSec: 80, loopable: false, dwellBase: 60,
      source: 'Musopen', license: 'PD',
    }];
    expect(manifestSchema.safeParse(m).success).toBe(false);
  });

  it('rejects a CC-BY audio asset with no attribution', () => {
    const m = base();
    m.audio = [{
      id: 'm1', kind: 'music', src: 'https://r/x.m4a',
      embedding: [0.1, 0.2], mood, tags: [],
      durationSec: 80, loopable: false, dwellBase: 60,
      source: 'Freesound', license: 'CC-BY-4.0',
    }];
    expect(manifestSchema.safeParse(m).success).toBe(false);
  });

  it('accepts visual claptext when present', () => {
    const m = base();
    m.assets = [{
      id: 'i1', type: 'image', src: 'https://r/x.webp',
      embedding: [0.1, 0.2], mood, tags: ['train'],
      dwellBase: 6, source: 'X', license: 'PD',
      claptext: [0.3, 0.4],
    }] as unknown as typeof m.assets;
    expect(manifestSchema.safeParse(m).success).toBe(true);
  });
});
