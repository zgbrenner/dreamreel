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
 * ominous => lower/darker drone + more hiss; tender => brighter drone + louder bells;
 * mechanical => brighter static + faster, louder ticks; uncanny => more detune beating + wetter.
 */
export function bedParamsFor(mood: Mood, tempoMul: number): BedParams {
  const ominous = clamp01(mood.ominous);
  const tender = clamp01(mood.tender);
  const mechanical = clamp01(mood.mechanical);
  const melancholy = clamp01(mood.melancholy);
  const uncanny = clamp01(mood.uncanny);
  const tempo = Math.max(0.25, tempoMul);

  const droneRootHz = 46 + tender * 18 - ominous * 8 - melancholy * 4;

  return {
    droneRootHz,
    droneFifthHz: droneRootHz * 1.5,
    beatDetune: 6 + uncanny * 22,
    droneCutoffHz: Math.max(200, 380 + tender * 1400 + mechanical * 600 - ominous * 150),
    hissGain: 0.03 + ominous * 0.1 + mechanical * 0.06,
    hissCutoffHz: 1400 + mechanical * 5000,
    bellGain: 0.08 + tender * 0.22,
    reverbWet: 0.4 + tender * 0.25 + uncanny * 0.15,
    tickGain: mechanical * 0.12,
    // base every quarter; mechanical + tempo shorten the interval, floored so it never machine-guns.
    tickIntervalSec: Math.max(0.08, 0.6 / (tempo * (0.6 + mechanical * 1.4))),
  };
}

/** A scheduled bell shot: how likely per slot, and which octave (tender lifts both). */
export interface BellShot {
  prob: number;
  octave: number;
}

export function bellShotFor(tender: number): BellShot {
  const t = clamp01(tender);
  return {
    prob: 0.18 + t * 0.4,
    octave: 3 + Math.round(t * 2), // tender => higher register
  };
}
