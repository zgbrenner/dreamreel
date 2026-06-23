import { describe, it, expect } from 'vitest';
import { filterStrengths, MOOD_FILTER, capDistortion, type FilterStrengths } from '../../src/dream/filterDirector';
import { MOOD_AXES, type MoodAxis } from '../../src/manifest/types';

function moodPeaking(axis: MoodAxis, peak = 0.9, base = 0.4): Record<MoodAxis, number> {
  const m = {} as Record<MoodAxis, number>;
  for (const a of MOOD_AXES) m[a] = a === axis ? peak : base;
  return m;
}
const FILTERS: (keyof FilterStrengths)[] = ['kaleidoscope', 'liquid', 'solarize', 'melt', 'posterize', 'feedback'];
const argmaxFilter = (s: FilterStrengths) =>
  FILTERS.reduce((best, f) => (s[f] > s[best] ? f : best), FILTERS[0]);

describe('FilterDirector mapping', () => {
  it('every mood axis, when dominant, makes its mapped filter the strongest', () => {
    for (const axis of MOOD_AXES) {
      const s = filterStrengths(moodPeaking(axis), 1, false);
      expect(argmaxFilter(s)).toBe(MOOD_FILTER[axis]);
    }
  });

  it('all six filters are reachable across the mood space', () => {
    const reached = new Set(MOOD_AXES.map((a) => argmaxFilter(filterStrengths(moodPeaking(a), 1, false))));
    expect(reached.size).toBe(6);
  });
});

describe('FilterDirector intensity + trough', () => {
  it('intensity scales strength up', () => {
    const lo = filterStrengths(moodPeaking('ominous'), 0.15, false);
    const hi = filterStrengths(moodPeaking('ominous'), 0.95, false);
    expect(hi.kaleidoscope).toBeGreaterThan(lo.kaleidoscope);
  });

  it('troughs ease all strengths toward ~0 (clean coherent image)', () => {
    const open = filterStrengths(moodPeaking('uncanny'), 0.9, false);
    const trough = filterStrengths(moodPeaking('uncanny'), 0.9, true);
    expect(trough.solarize).toBeLessThan(open.solarize * 0.4);
    for (const f of FILTERS) expect(trough[f]).toBeLessThan(0.25);
  });
});

describe('FilterDirector bounds + determinism', () => {
  it('all strengths stay within [0,1]', () => {
    for (const axis of MOOD_AXES) {
      const s = filterStrengths(moodPeaking(axis, 1, 0.8), 1, false);
      for (const f of FILTERS) {
        expect(s[f]).toBeGreaterThanOrEqual(0);
        expect(s[f]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is a pure deterministic function of its inputs', () => {
    const m = moodPeaking('tender');
    expect(filterStrengths(m, 0.6, false)).toEqual(filterStrengths(m, 0.6, false));
  });
});

describe('FilterDirector restraint', () => {
  it('peak strength is held back (no full-strength obliteration at intensity 1)', () => {
    // ominous -> kaleidoscope; a fully-dominant axis at intensity 1 used to reach ~1.0.
    const s = filterStrengths(moodPeaking('ominous', 1, 0.1), 1, false);
    expect(s.kaleidoscope).toBeLessThan(0.5);
  });

  it('capDistortion clamps the two geometry-manglers, leaving others untouched', () => {
    const capped = capDistortion({
      kaleidoscope: 0.9, liquid: 0.95, solarize: 0.6, melt: 0.4, posterize: 0.3, feedback: 0.8,
    });
    expect(capped.kaleidoscope).toBe(0.3);
    expect(capped.liquid).toBe(0.45);
    expect(capped.solarize).toBe(0.6);
    expect(capped.feedback).toBe(0.8);
  });
});
