import { describe, it, expect } from 'vitest';
import { createAudioWalker, type AudioWalkerPools } from './audioWalker';
import type { AudioAsset } from '../manifest/types';

const mood = {
  melancholy: 0.5, uncanny: 0.5, nostalgic: 0.5,
  ominous: 0.5, tender: 0.5, mechanical: 0.5,
};

function asset(id: string, kind: AudioAsset['kind'], e: number[]): AudioAsset {
  return {
    id, kind, src: `https://r/${id}.m4a`,
    embedding: e, mood, tags: [], durationSec: 10, loopable: false,
    dwellBase: 6, source: 'X', license: 'PD',
  };
}

// A small CLAP-ish pool spread around a 4-d space.
function pool(): AudioWalkerPools {
  return {
    audioEmbeddingDim: 4,
    audio: [
      asset('train', 'foley', [1, 0, 0, 0]),
      asset('rain', 'foley', [0, 1, 0, 0]),
      asset('song', 'music', [0, 0, 1, 0]),
      asset('speech', 'voice', [0, 0, 0, 1]),
      asset('song2', 'music', [0.2, 0, 0.9, 0]),
      asset('speech2', 'voice', [0, 0.2, 0, 0.9]),
    ],
  };
}

function sequence(seed: string, n: number, claptext?: number[], coupling = 0.6): string[] {
  const w = createAudioWalker(pool(), { seed, surreality: 0.5, coupling });
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const pick = w.next(claptext, 1);
    if (pick) out.push(pick.asset.id);
  }
  return out;
}

describe('AudioWalker', () => {
  it('same seed -> identical sequence (determinism)', () => {
    expect(sequence('abc', 30)).toEqual(sequence('abc', 30));
  });

  it('different seeds -> different sequences', () => {
    expect(sequence('abc', 30)).not.toEqual(sequence('xyz', 30));
  });

  it('returns null on an empty pool', () => {
    const w = createAudioWalker({ audio: [], audioEmbeddingDim: 4 }, { seed: 's', surreality: 0.5 });
    expect(w.next(undefined, 1)).toBeNull();
  });

  it('text-bridge bias pulls selection toward the concept; coupling=0 reproduces unbiased', () => {
    // Concept vector aligned with the music axis -> more music when coupling is on.
    const concept = [0, 0, 1, 0];
    const musicCount = (ids: string[]) => ids.filter((id) => id.startsWith('song')).length;

    const biased = sequence('seed-1', 200, concept, 1.5);
    const unbiasedA = sequence('seed-1', 200, concept, 0);
    const unbiasedB = sequence('seed-1', 200, undefined, 0.6);

    expect(musicCount(biased)).toBeGreaterThan(musicCount(unbiasedA));
    // coupling=0 with a concept == no concept at all (bias term vanishes)
    expect(unbiasedA).toEqual(unbiasedB);
  });

  it('per-kind weights lift music over equally-similar voice at the same point', () => {
    // With weights music:1.0 > voice:0.5, a neutral walk should select music at least as often.
    const ids = sequence('weight-seed', 300);
    const music = ids.filter((id) => id.startsWith('song')).length;
    const voice = ids.filter((id) => id.startsWith('speech')).length;
    expect(music).toBeGreaterThan(voice);
  });
});
