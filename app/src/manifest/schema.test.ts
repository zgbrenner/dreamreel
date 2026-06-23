// app/src/manifest/schema.test.ts
import { describe, it, expect } from 'vitest';
import { manifestSchema } from './schema';

const base = () => ({
  version: '1', createdAt: 'now', embeddingDim: 2,
  moodAxes: {
    melancholy: [0, 0], uncanny: [0, 0], nostalgic: [0, 0],
    ominous: [0, 0], tender: [0, 0], mechanical: [0, 0],
  },
  assets: [], texts: [],
  audioEmbeddingDim: 2,
  audio: [] as unknown[],
});

const mood = {
  melancholy: 0.5, uncanny: 0.5, nostalgic: 0.5,
  ominous: 0.5, tender: 0.5, mechanical: 0.5,
};

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
