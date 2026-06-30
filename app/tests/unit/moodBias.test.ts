import { describe, it, expect } from 'vitest';
import { deriveMoodIdentity, moodBiasAt, type MoodIdentity } from '../../src/dream/moodBias';
import { createDreamwalker, type DreamwalkerPools } from '../../src/dream/dreamwalker';
import { MOOD_AXES, type Asset, type MoodAxis } from '../../src/manifest/types';

function moodVec(overrides: Partial<Record<MoodAxis, number>>): Record<MoodAxis, number> {
  const v = {} as Record<MoodAxis, number>;
  for (const a of MOOD_AXES) v[a] = overrides[a] ?? 0.5;
  return v;
}

describe('deriveMoodIdentity — gentle-leaning distribution', () => {
  it('is deterministic per seed', () => {
    expect(deriveMoodIdentity('alpha')).toEqual(deriveMoodIdentity('alpha'));
    expect(deriveMoodIdentity('alpha')).not.toEqual(deriveMoodIdentity('beta'));
  });

  it('draws mostly gentle dreams, with fear a present-but-minority class', () => {
    const counts = { gentle: 0, neutral: 0, nightmare: 0 };
    const N = 600;
    for (let i = 0; i < N; i++) counts[deriveMoodIdentity(`seed-${i}`).kind]++;
    // Gentle is the baseline texture; nightmare a deliberate minority (but never zero).
    expect(counts.gentle / N).toBeGreaterThan(0.5);
    expect(counts.nightmare / N).toBeLessThan(0.25);
    expect(counts.nightmare).toBeGreaterThan(0);
    expect(counts.gentle).toBeGreaterThan(counts.nightmare);
  });

  it('gentle baselines suppress fear; nightmare baselines raise it and cool the warmth', () => {
    let gentle: MoodIdentity | undefined;
    let nightmare: MoodIdentity | undefined;
    for (let i = 0; i < 600 && (!gentle || !nightmare); i++) {
      const id = deriveMoodIdentity(`s-${i}`);
      if (id.kind === 'gentle' && !gentle) gentle = id;
      if (id.kind === 'nightmare' && !nightmare) nightmare = id;
    }
    expect(gentle).toBeDefined();
    expect(nightmare).toBeDefined();
    expect(gentle!.baseline.fear).toBeLessThan(0.4);
    expect(gentle!.baseline.ominous).toBeLessThan(0.4);
    expect(nightmare!.baseline.fear).toBeGreaterThan(0.6);
    expect(nightmare!.baseline.joy).toBeLessThan(0.4);
  });

  it('every baseline axis stays within 0..1', () => {
    for (let i = 0; i < 200; i++) {
      const id = deriveMoodIdentity(`r-${i}`);
      for (const a of MOOD_AXES) {
        expect(id.baseline[a]).toBeGreaterThanOrEqual(0);
        expect(id.baseline[a]).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('moodBiasAt — the mid-dream turn', () => {
  const arcIdentity: MoodIdentity = {
    kind: 'gentle',
    baseline: moodVec({ tender: 0.9, fear: 0.2 }),
    arc: { target: moodVec({ fear: 0.9, tender: 0.28 }), center: 0.5, width: 0.15 },
  };

  it('returns the baseline when the dream has no arc', () => {
    const flat: MoodIdentity = { kind: 'gentle', baseline: moodVec({ tender: 0.9 }), arc: null };
    expect(moodBiasAt(flat, 0.0)).toEqual(flat.baseline);
    expect(moodBiasAt(flat, 0.5)).toEqual(flat.baseline);
  });

  it('drifts toward the arc target at the turn peak and back to baseline away from it', () => {
    const atPeak = moodBiasAt(arcIdentity, 0.5);
    const offPeak = moodBiasAt(arcIdentity, 0.0); // outside the pulse width → baseline
    // The turn raises fear and cools tenderness at its peak...
    expect(atPeak.fear).toBeGreaterThan(arcIdentity.baseline.fear);
    expect(atPeak.tender).toBeLessThan(arcIdentity.baseline.tender);
    // ...and fully relaxes back to the baseline away from the turn.
    expect(offPeak).toEqual(arcIdentity.baseline);
  });
});

describe('mood identity biases the Dreamwalker selection', () => {
  // Two candidates with the SAME embedding (so cosine is equal) but opposite moods — the only
  // selection difference left is the identity's mood bias.
  function asset(id: string, mood: Record<MoodAxis, number>): Asset {
    return {
      id,
      type: 'video',
      src: 'x',
      embedding: [1, 0, 0, 0],
      mood,
      tags: [],
      dwellBase: 6,
      source: 's',
      license: 'PD',
    };
  }

  function tenderFraction(identity: MoodIdentity): number {
    const visual: Asset[] = [
      asset('tender', moodVec({ tender: 1, fear: 0 })),
      asset('fearful', moodVec({ tender: 0, fear: 1 })),
    ];
    const texts: Asset[] = [asset('txt', moodVec({}))]; // non-card → no intertitle interjection
    const pools: DreamwalkerPools = {
      visual,
      texts,
      moodAxes: Object.fromEntries(MOOD_AXES.map((a) => [a, [0, 0, 0, 0]])) as Record<MoodAxis, number[]>,
      embeddingDim: 4,
    };
    const w = createDreamwalker(pools, { seed: 'mood-bias', surreality: 0.8, moodIdentity: identity });
    let tender = 0;
    const N = 3000;
    for (let i = 0; i < N; i++) if (w.next('image', 1).asset.id === 'tender') tender++;
    return tender / N;
  }

  const gentle: MoodIdentity = { kind: 'gentle', baseline: moodVec({ tender: 0.95, fear: 0.2 }), arc: null };
  const nightmare: MoodIdentity = { kind: 'nightmare', baseline: moodVec({ fear: 0.95, tender: 0.2 }), arc: null };

  it('leans toward tender candidates under a gentle identity and away under a nightmare one', () => {
    const g = tenderFraction(gentle);
    const n = tenderFraction(nightmare);
    expect(g).toBeGreaterThan(0.5);
    expect(n).toBeLessThan(0.5);
    expect(g).toBeGreaterThan(n);
  });

  it('is deterministic across fresh instances', () => {
    expect(tenderFraction(gentle)).toBe(tenderFraction(gentle));
  });
});
