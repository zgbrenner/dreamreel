// app/src/audio/params.ts
// Pure mood -> ambient-bed parameter mapping. No Tone.js, no DOM — this is the unit-testable
// core of how the Dreamwalker's mood reshapes the sound, so the audible behaviour can be
// asserted without a Web Audio context. engine.ts ramps its Tone nodes toward these targets.

import type { MoodAxis } from '../manifest/types';

export type Mood = Record<MoodAxis, number>;

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Target levels for the whole bed at a given mood + tempo. All values are absolute targets. */
export interface BedParams {
  droneRootHz: number; // fundamental of oscillator A
  droneFifthHz: number; // oscillator B, a fifth above
  beatDetune: number; // oscB detune in cents (uncanny => more beating)
  droneCutoffHz: number; // lowpass brightness on the drone
  hissGain: number; // tape-hiss level
  hissCutoffHz: number; // tape-hiss brightness
  bellGain: number; // bell layer level
  reverbWet: number; // reverb wetness 0..1
  tickGain: number; // projector-tick level
  tickIntervalSec: number; // projector-tick spacing (smaller = faster)
}

/**
 * Map a mood (and the current tempo multiplier) to bed targets.
 * All twelve axes reshape the bed: ominous/fear darken, tender/love/joy brighten, loss adds
 * reverb and pulls pitch down, absurdity/strange widen detune, mechanical/absurdity speed ticks.
 */
export function bedParamsFor(mood: Mood, tempoMul: number): BedParams {
  const ominous = clamp01(mood.ominous);
  const tender = clamp01(mood.tender);
  const mechanical = clamp01(mood.mechanical);
  const melancholy = clamp01(mood.melancholy);
  const uncanny = clamp01(mood.uncanny);
  const love = clamp01(mood.love);
  const loss = clamp01(mood.loss);
  const joy = clamp01(mood.joy);
  const fear = clamp01(mood.fear);
  const absurdity = clamp01(mood.absurdity);
  const strange = clamp01(mood.strange);
  const tempo = Math.max(0.25, tempoMul);

  const droneRootHz =
    46 + tender * 18 + love * 12 + joy * 8 - ominous * 8 - melancholy * 4 - loss * 6 - fear * 5;

  return {
    droneRootHz,
    droneFifthHz: droneRootHz * 1.5,
    beatDetune: 6 + uncanny * 22 + strange * 14 + absurdity * 10,
    droneCutoffHz: Math.max(
      200,
      380 + tender * 1400 + love * 600 + joy * 500 + mechanical * 600 - ominous * 150 - fear * 120,
    ),
    hissGain: 0.03 + ominous * 0.1 + fear * 0.12 + mechanical * 0.06,
    hissCutoffHz: 1400 + mechanical * 5000 + absurdity * 1200,
    bellGain: 0.08 + tender * 0.22 + love * 0.14 + joy * 0.1,
    reverbWet: 0.4 + tender * 0.25 + love * 0.12 + uncanny * 0.15 + loss * 0.2,
    tickGain: mechanical * 0.12 + absurdity * 0.06,
    tickIntervalSec: Math.max(0.08, 0.6 / (tempo * (0.6 + mechanical * 1.4 + absurdity * 0.5))),
  };
}

/** A scheduled bell shot: how likely per slot, and which octave (tender lifts both). */
export interface BellShot {
  prob: number;
  octave: number;
}

/** Bell shots lean on the luminous axes (tender, love, joy). */
export function bellShotFor(mood: Mood): BellShot {
  const glow = clamp01((mood.tender + mood.love + mood.joy) / 3);
  return {
    prob: 0.18 + glow * 0.4,
    octave: 3 + Math.round(glow * 2),
  };
}
