// swapFadeRate + preferSlow: mood-shaped swap dynamics and the slow-variant pick (look brain).
import { describe, it, expect } from 'vitest';
import { swapFadeRate, preferSlow } from '../../src/dream/filterDirector';
import { MOOD_AXES, type MoodAxis } from '../../src/manifest/types';

function moodWith(overrides: Partial<Record<MoodAxis, number>>): Record<MoodAxis, number> {
  const m = {} as Record<MoodAxis, number>;
  for (const a of MOOD_AXES) m[a] = 0.5;
  return { ...m, ...overrides };
}

describe('swapFadeRate', () => {
  it('keeps the 3.0 default for a flat/absent mood', () => {
    expect(swapFadeRate(null, 0.16, false, false)).toBe(3.0);
    expect(swapFadeRate(moodWith({}), 0.16, false, false)).toBeCloseTo(3.0, 1);
  });

  it('tender/nostalgic dreams dissolve slower; fearful escalations cut faster', () => {
    const tender = swapFadeRate(moodWith({ tender: 0.95 }), 0.2, false, false);
    const fear = swapFadeRate(moodWith({ fear: 0.95 }), 0.9, false, false);
    const neutral = swapFadeRate(moodWith({}), 0.2, false, false);
    expect(tender).toBeLessThan(neutral);
    expect(fear).toBeGreaterThan(neutral);
  });

  it('fear only sharpens WITH intensity (a calm fearful mood stays soft)', () => {
    const calm = swapFadeRate(moodWith({ fear: 0.95 }), 0.1, false, false);
    const hot = swapFadeRate(moodWith({ fear: 0.95 }), 0.95, false, false);
    expect(hot).toBeGreaterThan(calm);
  });

  it('troughs and reduced-motion always dissolve slowly regardless of mood', () => {
    expect(swapFadeRate(moodWith({ fear: 1 }), 1, true, false)).toBe(2.0);
    expect(swapFadeRate(moodWith({ fear: 1 }), 1, false, true)).toBe(2.2);
  });
});

describe('preferSlow', () => {
  it('prefers the slow variant only on distinctly gentle, low-intensity beats', () => {
    expect(preferSlow(moodWith({ tender: 0.75 }), 0.2)).toBe(true);
    expect(preferSlow(moodWith({ nostalgic: 0.7 }), 0.1)).toBe(true);
  });

  it('never at high intensity, on non-gentle moods, or without a mood', () => {
    expect(preferSlow(moodWith({ tender: 0.75 }), 0.6)).toBe(false);
    expect(preferSlow(moodWith({ fear: 0.9 }), 0.1)).toBe(false);
    expect(preferSlow(moodWith({}), 0.1)).toBe(false);
    expect(preferSlow(null, 0.1)).toBe(false);
  });
});
