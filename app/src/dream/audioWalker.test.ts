import { describe, it, expect } from 'vitest';
import {
  createAudioWalker,
  musicalDwellMs,
  audioArousal,
  type AudioWalkerPools,
} from './audioWalker';
import { blankMood } from './mood';
import type { AudioAsset } from '../manifest/types';

const mood = blankMood();

function asset(
  id: string,
  kind: AudioAsset['kind'],
  e: number[],
  extra: Partial<AudioAsset> = {},
): AudioAsset {
  return {
    id, kind, src: `https://r/${id}.m4a`,
    embedding: e, mood, tags: [], durationSec: 10, loopable: false,
    dwellBase: 6, source: 'X', license: 'PD',
    ...extra,
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

  it('moodCoupling=0 ignores the mood argument', () => {
    const query = blankMood();
    query.joy = 1;

    const withMood = createAudioWalker(pool(), { seed: 'mood-z', surreality: 0.5, moodCoupling: 0 });
    const without = createAudioWalker(pool(), { seed: 'mood-z', surreality: 0.5, moodCoupling: 0 });
    const a: string[] = [];
    const b: string[] = [];
    for (let i = 0; i < 30; i++) {
      a.push(withMood.next(undefined, 1, query)!.asset.id);
      b.push(without.next(undefined, 1)!.asset.id);
    }
    expect(a).toEqual(b);
  });

  it('per-kind weights lift music over equally-similar voice at the same point', () => {
    const ids = sequence('weight-seed', 300);
    const music = ids.filter((id) => id.startsWith('song')).length;
    const voice = ids.filter((id) => id.startsWith('speech')).length;
    expect(music).toBeGreaterThan(voice);
  });

  it('bar-quantizes dwell when a clip carries bpm; passes through when absent', () => {
    // 120 bpm => one bar = 4 * 500ms = 2000ms. dwellBase 6s => 6000ms => exactly 3 bars.
    const withBpm = createAudioWalker(
      { audioEmbeddingDim: 4, audio: [asset('m', 'music', [0, 0, 1, 0], { bpm: 120 })] },
      { seed: 'q', surreality: 0 },
    );
    expect(withBpm.next(undefined, 1)!.dwellMs).toBe(6000);

    // No bpm => the raw base dwell is preserved unchanged (legacy behaviour).
    const noBpm = createAudioWalker(
      { audioEmbeddingDim: 4, audio: [asset('m', 'music', [0, 0, 1, 0])] },
      { seed: 'q', surreality: 0 },
    );
    expect(noBpm.next(undefined, 1)!.dwellMs).toBe(6000);
  });

  it('energy×arousal bias surfaces louder clips in excited moods; vanishes at coupling 0', () => {
    const energyPool = (): AudioWalkerPools => ({
      audioEmbeddingDim: 4,
      audio: [
        asset('loud-a', 'music', [1, 0, 0, 0], { energy: 0.95 }),
        asset('loud-b', 'music', [0, 1, 0, 0], { energy: 0.9 }),
        asset('soft-a', 'foley', [0, 0, 1, 0], { energy: 0.1 }),
        asset('soft-b', 'foley', [0, 0, 0, 1], { energy: 0.15 }),
      ],
    });
    const excited = blankMood();
    excited.joy = 1;
    excited.fear = 0.9;
    excited.absurdity = 0.9;

    const loudCount = (w: ReturnType<typeof createAudioWalker>) => {
      let n = 0;
      for (let i = 0; i < 240; i++) if (w.next(undefined, 1, excited)!.asset.id.startsWith('loud')) n++;
      return n;
    };

    const biased = createAudioWalker(energyPool(), { seed: 'e', surreality: 0.5 });
    const neutral = createAudioWalker(energyPool(), { seed: 'e', surreality: 0.5, energyCoupling: 0 });
    expect(loudCount(biased)).toBeGreaterThan(loudCount(neutral));
  });

  it('musicalDwellMs: whole bars, >=1 bar, identity without bpm', () => {
    expect(musicalDwellMs(6000, 120)).toBe(6000); // 3 bars
    expect(musicalDwellMs(500, 120)).toBe(2000); // rounds up to 1 bar minimum
    expect(musicalDwellMs(6000, undefined)).toBe(6000); // identity
    expect(musicalDwellMs(6000, 0)).toBe(6000); // invalid bpm => identity
    const q = musicalDwellMs(7777, 96);
    const bar = (4 * 60000) / 96;
    expect(q / bar).toBe(Math.round(q / bar)); // exact whole number of bars
  });

  it('audioArousal: excited moods positive, calm moods negative, neutral ~0', () => {
    const calm = blankMood();
    calm.tender = 1;
    calm.melancholy = 0.9;
    const manic = blankMood();
    manic.joy = 1;
    manic.fear = 0.9;
    expect(audioArousal(manic)).toBeGreaterThan(0);
    expect(audioArousal(calm)).toBeLessThan(0);
    expect(Math.abs(audioArousal(blankMood()))).toBeLessThan(1e-9);
  });
});
