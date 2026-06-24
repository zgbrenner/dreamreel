// app/src/dream/filterCatalog.test.ts
//
// filterDirector is the SINGLE source of truth mapping emotion + intensity to the look. These
// tests pin the NEW selection surfaces it owns: the crossfade transition, procedural-source
// params, and the Butterchurn engagement decision. They assert determinism, that mood BLENDS are
// reflected, that the neutral/identity default is preserved, and that reduced-motion + coherence
// troughs ease the look down.

import { describe, it, expect } from 'vitest';
import {
  pickTransition,
  proceduralParams,
  butterchurnEngaged,
  butterchurnPresetIndex,
  TRANSITION_BY_AXIS,
  NEUTRAL_TRANSITIONS,
  GENTLE_TRANSITIONS,
  TROUGH_TRANSITIONS,
  NEUTRAL_PROC_PARAMS,
} from './filterDirector';
import { TRANSITIONS } from '../render/transitions';
import { blankMood } from './mood';
import { MOOD_AXES, type MoodAxis } from '../manifest/types';

function moodPeaking(axes: MoodAxis[], peak = 0.95, base = 0.1): Record<MoodAxis, number> {
  const m = {} as Record<MoodAxis, number>;
  for (const a of MOOD_AXES) m[a] = axes.includes(a) ? peak : base;
  return m;
}

// Sweep a range of seeded rolls and collect the distinct transitions chosen.
function transitionSet(
  mood: Record<MoodAxis, number>,
  intensity: number,
  inTrough: boolean,
  reduceMotion: boolean,
): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < 50; i++) {
    out.add(pickTransition(mood, intensity, inTrough, (i + 0.5) / 50, reduceMotion));
  }
  return out;
}

const HARSH = ['cut', 'glitch', 'slideHarsh'];

describe('catalog integrity', () => {
  it('every transition the director can name actually exists in the GLSL catalog', () => {
    const referenced = new Set<string>([
      ...NEUTRAL_TRANSITIONS,
      ...GENTLE_TRANSITIONS,
      ...TROUGH_TRANSITIONS,
      ...Object.values(TRANSITION_BY_AXIS).flat(),
    ]);
    for (const name of referenced) {
      expect(TRANSITIONS[name], `transition "${name}" must be defined`).toBeTruthy();
    }
  });

  it('the catalog grew to a curated ~20+ set', () => {
    expect(Object.keys(TRANSITIONS).length).toBeGreaterThanOrEqual(20);
  });

  it('every catalog shader defines a transition() entry point', () => {
    for (const [name, def] of Object.entries(TRANSITIONS)) {
      expect(def.glsl, `${name} has glsl`).toBeTruthy();
      expect(def.glsl.includes('vec4 transition(vec2 uv)'), `${name} defines transition()`).toBe(true);
    }
  });

  it('the 2026-06-24 expansion shaders are defined and each is wired into a mood family', () => {
    const added = [
      'windowBlinds', 'crossZoom', 'inkBleed', 'chromaDrift',
      'waterDrop', 'diagonalWipe', 'mirrorFold', 'staticDissolve',
    ];
    const familyNames = new Set(Object.values(TRANSITION_BY_AXIS).flat());
    for (const name of added) {
      expect(TRANSITIONS[name], `${name} defined`).toBeTruthy();
      expect(familyNames.has(name), `${name} wired into a mood family`).toBe(true);
    }
    expect(Object.keys(TRANSITIONS).length).toBeGreaterThanOrEqual(29);
  });
});

describe('pickTransition — determinism + blends + defaults', () => {
  it('is a pure deterministic function of (mood, intensity, trough, roll, reduceMotion)', () => {
    const m = moodPeaking(['ominous', 'tender']);
    for (let i = 0; i < 20; i++) {
      const roll = i / 20;
      expect(pickTransition(m, 0.7, false, roll, false)).toBe(pickTransition(m, 0.7, false, roll, false));
    }
  });

  it('reflects BLENDS: a two-emotion mood draws from BOTH families', () => {
    // ominous (harsh: cut/slideHarsh/barWipe) + tender (luminous: bloomDissolve/lightFlash/crossLuma)
    const blended = transitionSet(moodPeaking(['ominous', 'tender']), 1, false, false);
    const ominous = new Set(TRANSITION_BY_AXIS.ominous);
    const tender = new Set(TRANSITION_BY_AXIS.tender);
    const fromOminous = [...blended].some((t) => ominous.has(t));
    const fromTender = [...blended].some((t) => tender.has(t));
    expect(fromOminous).toBe(true);
    expect(fromTender).toBe(true);
  });

  it('a single dominant emotion leads to its own family', () => {
    const chosen = transitionSet(moodPeaking(['mechanical']), 1, false, false);
    // mechanical → glitch/pixelize/posterizeWipe should dominate the spread
    const mech = new Set(TRANSITION_BY_AXIS.mechanical);
    const overlap = [...chosen].filter((t) => mech.has(t));
    expect(overlap.length).toBeGreaterThan(0);
  });

  it('neutral (flat) mood falls back to the gentle identity default set', () => {
    const flat = blankMood(); // all axes 0.5 → zero spread
    for (let i = 0; i < 20; i++) {
      const t = pickTransition(flat, 0.5, false, i / 20, false);
      expect(NEUTRAL_TRANSITIONS).toContain(t);
    }
  });

  it('prefers-reduced-motion restricts to the gentle set — never a harsh cut/glitch/push', () => {
    // Even a fear/ominous-peaked mood (which would otherwise pick hard cuts) stays gentle.
    const harshMood = moodPeaking(['fear', 'ominous']);
    const set = transitionSet(harshMood, 1, false, true);
    for (const t of set) {
      expect(GENTLE_TRANSITIONS).toContain(t);
      expect(HARSH).not.toContain(t);
    }
  });

  it('coherence troughs ease to the calmest dissolves so the lucid image reads', () => {
    const set = transitionSet(moodPeaking(['fear', 'mechanical']), 1, true, false);
    for (const t of set) expect(TROUGH_TRANSITIONS).toContain(t);
  });
});

describe('proceduralParams — emotion + intensity variation', () => {
  it('neutral mood at zero intensity reproduces the identity params exactly', () => {
    expect(proceduralParams(blankMood(), 0)).toEqual(NEUTRAL_PROC_PARAMS);
  });

  it('ominous / fear thicken density; loss thins it (stars sparser on loss)', () => {
    const base = proceduralParams(blankMood(), 0).density;
    expect(proceduralParams(moodPeaking(['ominous']), 0).density).toBeGreaterThan(base);
    expect(proceduralParams(moodPeaking(['fear']), 0).density).toBeGreaterThan(base);
    expect(proceduralParams(moodPeaking(['loss']), 0).density).toBeLessThan(base);
  });

  it('joy and intensity speed up and brighten the sources', () => {
    const neutral = proceduralParams(blankMood(), 0);
    const joyful = proceduralParams(moodPeaking(['joy']), 0);
    expect(joyful.speed).toBeGreaterThan(neutral.speed);
    expect(joyful.brightness).toBeGreaterThan(neutral.brightness);
    // intensity alone also lifts speed
    expect(proceduralParams(blankMood(), 1).speed).toBeGreaterThan(neutral.speed);
  });

  it('all params stay within bounds for any mood/intensity', () => {
    for (const axis of MOOD_AXES) {
      for (const i of [0, 0.5, 1]) {
        const p = proceduralParams(moodPeaking([axis]), i);
        expect(p.speed).toBeGreaterThanOrEqual(0);
        for (const k of ['density', 'brightness', 'warmth', 'jitter'] as const) {
          expect(p[k]).toBeGreaterThanOrEqual(0);
          expect(p[k]).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('is deterministic', () => {
    const m = moodPeaking(['nostalgic', 'joy']);
    expect(proceduralParams(m, 0.6)).toEqual(proceduralParams(m, 0.6));
  });
});

describe('butterchurn engagement', () => {
  it('engages only in a frenzy regime at high intensity', () => {
    expect(butterchurnEngaged(0.9, 'frenzy', false)).toBe(true);
    expect(butterchurnEngaged(0.5, 'frenzy', false)).toBe(false); // too calm
    expect(butterchurnEngaged(0.9, 'baseline', false)).toBe(false);
    expect(butterchurnEngaged(0.9, 'trough', false)).toBe(false);
  });

  it('never engages under prefers-reduced-motion', () => {
    expect(butterchurnEngaged(1, 'frenzy', true)).toBe(false);
  });

  it('preset index is deterministic and bounded; -1 when there are no presets', () => {
    expect(butterchurnPresetIndex(0.0, 10)).toBe(0);
    expect(butterchurnPresetIndex(0.999, 10)).toBe(9);
    expect(butterchurnPresetIndex(0.5, 10)).toBe(butterchurnPresetIndex(0.5, 10));
    expect(butterchurnPresetIndex(0.5, 0)).toBe(-1);
  });
});
