import { describe, it, expect } from 'vitest';
import { bedParamsFor, bellShotFor, type Mood } from '../../src/audio/params';
import { MOOD_AXES } from '../../src/manifest/types';
import { blankMood } from '../../src/dream/mood';

const NEUTRAL: Mood = blankMood();

/** A neutral mood with one axis pushed to `v`. */
function only(axis: keyof Mood, v: number): Mood {
  return { ...zero(), [axis]: v };
}
function zero(): Mood {
  return MOOD_AXES.reduce((m, a) => ({ ...m, [a]: 0 }), {} as Mood);
}

describe('bedParamsFor — mood reshapes the bed', () => {
  it('ominous lowers the drone pitch and raises the hiss', () => {
    const calm = bedParamsFor(zero(), 1);
    const dark = bedParamsFor(only('ominous', 1), 1);
    expect(dark.droneRootHz).toBeLessThan(calm.droneRootHz);
    expect(dark.hissGain).toBeGreaterThan(calm.hissGain);
    expect(dark.droneCutoffHz).toBeLessThanOrEqual(calm.droneCutoffHz); // darker, never brighter
  });

  it('tender brightens the drone and raises the bell layer', () => {
    const calm = bedParamsFor(zero(), 1);
    const warm = bedParamsFor(only('tender', 1), 1);
    expect(warm.droneRootHz).toBeGreaterThan(calm.droneRootHz);
    expect(warm.droneCutoffHz).toBeGreaterThan(calm.droneCutoffHz);
    expect(warm.bellGain).toBeGreaterThan(calm.bellGain);
    expect(warm.reverbWet).toBeGreaterThan(calm.reverbWet);
  });

  it('mechanical brightens the static and speeds + lifts the ticks', () => {
    const calm = bedParamsFor(zero(), 1);
    const mech = bedParamsFor(only('mechanical', 1), 1);
    expect(mech.hissCutoffHz).toBeGreaterThan(calm.hissCutoffHz); // brighter static
    expect(mech.tickGain).toBeGreaterThan(calm.tickGain); // louder ticks
    expect(mech.tickIntervalSec).toBeLessThan(calm.tickIntervalSec); // faster ticks
  });

  it('uncanny widens the detune beating and adds reverb', () => {
    const calm = bedParamsFor(zero(), 1);
    const eerie = bedParamsFor(only('uncanny', 1), 1);
    expect(eerie.beatDetune).toBeGreaterThan(calm.beatDetune);
    expect(eerie.reverbWet).toBeGreaterThan(calm.reverbWet);
  });

  it('faster tempo shortens the tick interval', () => {
    const slow = bedParamsFor(NEUTRAL, 0.5);
    const fast = bedParamsFor(NEUTRAL, 2);
    expect(fast.tickIntervalSec).toBeLessThan(slow.tickIntervalSec);
  });

  it('fear lowers pitch and raises hiss like ominous', () => {
    const calm = bedParamsFor(zero(), 1);
    const scared = bedParamsFor(only('fear', 1), 1);
    expect(scared.droneRootHz).toBeLessThan(calm.droneRootHz);
    expect(scared.hissGain).toBeGreaterThan(calm.hissGain);
  });

  it('loss adds reverb wetness', () => {
    const calm = bedParamsFor(zero(), 1);
    const grieving = bedParamsFor(only('loss', 1), 1);
    expect(grieving.reverbWet).toBeGreaterThan(calm.reverbWet);
    expect(grieving.droneRootHz).toBeLessThan(calm.droneRootHz);
  });

  it('joy brightens the drone like tender', () => {
    const calm = bedParamsFor(zero(), 1);
    const joyful = bedParamsFor(only('joy', 1), 1);
    expect(joyful.droneRootHz).toBeGreaterThan(calm.droneRootHz);
    expect(joyful.bellGain).toBeGreaterThan(calm.bellGain);
  });

  it('strange and absurdity widen detune beating', () => {
    const calm = bedParamsFor(zero(), 1);
    const weird = bedParamsFor(only('strange', 1), 1);
    const absurd = bedParamsFor(only('absurdity', 1), 1);
    expect(weird.beatDetune).toBeGreaterThan(calm.beatDetune);
    expect(absurd.beatDetune).toBeGreaterThan(calm.beatDetune);
  });

  it('the fifth tracks the root', () => {
    const p = bedParamsFor(only('tender', 0.7), 1);
    expect(p.droneFifthHz).toBeCloseTo(p.droneRootHz * 1.5, 6);
  });
});

describe('bedParamsFor — stays in safe ranges', () => {
  it('keeps every target finite and within sane bounds across the mood cube', () => {
    for (const ominous of [0, 1]) {
      for (const tender of [0, 1]) {
        for (const mechanical of [0, 1]) {
          for (const tempo of [0.25, 1, 2]) {
            const p = bedParamsFor(
              { ...NEUTRAL, ominous, tender, mechanical },
              tempo,
            );
            for (const v of Object.values(p)) expect(Number.isFinite(v)).toBe(true);
            expect(p.droneRootHz).toBeGreaterThan(0);
            expect(p.droneCutoffHz).toBeGreaterThanOrEqual(200); // lowpass floor
            expect(p.reverbWet).toBeGreaterThanOrEqual(0);
            expect(p.reverbWet).toBeLessThanOrEqual(1);
            expect(p.tickIntervalSec).toBeGreaterThanOrEqual(0.08); // never machine-guns
            expect(p.hissGain).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });

  it('clamps out-of-range mood values instead of producing extremes', () => {
    const wild = bedParamsFor({ ...NEUTRAL, ominous: 5, tender: -3, mechanical: 9 }, 1);
    const clamped = bedParamsFor({ ...NEUTRAL, ominous: 1, tender: 0, mechanical: 1 }, 1);
    for (const k of Object.keys(wild) as (keyof typeof wild)[]) {
      expect(wild[k]).toBeCloseTo(clamped[k], 6);
    }
  });
});

describe('bellShotFor', () => {
  it('tender/love/joy raise both the trigger probability and the register', () => {
    const low = bellShotFor(zero());
    const high = bellShotFor({ ...zero(), tender: 1, love: 1, joy: 1 });
    expect(high.prob).toBeGreaterThan(low.prob);
    expect(high.octave).toBeGreaterThan(low.octave);
  });

  it('stays within musical bounds and clamps wild input', () => {
    const wild = { ...NEUTRAL, tender: 5, love: -2, joy: 9 };
    const clamped = { ...NEUTRAL, tender: 1, love: 1, joy: 1 };
    const w = bellShotFor(wild);
    const c = bellShotFor(clamped);
    expect(w.prob).toBeCloseTo(c.prob, 6);
    expect(w.octave).toBe(c.octave);
    for (const t of [-2, 0, 0.5, 1, 4] as const) {
      const m = { ...zero(), tender: t, love: t, joy: t };
      const s = bellShotFor(m);
      expect(s.prob).toBeGreaterThanOrEqual(0.18);
      expect(s.prob).toBeLessThanOrEqual(0.58 + 1e-9);
      expect(s.octave).toBeGreaterThanOrEqual(3);
      expect(s.octave).toBeLessThanOrEqual(5);
      expect(Number.isInteger(s.octave)).toBe(true);
    }
  });
});
