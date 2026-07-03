// app/src/audio/params.ts
// Pure mood -> ambient-bed parameter mapping. No Tone.js, no DOM — this is the unit-testable
// core of how the Dreamwalker's mood reshapes the sound, so the audible behaviour can be
// asserted without a Web Audio context. engine.ts ramps its Tone nodes toward these targets.
//
// Two concerns live here, kept orthogonal:
//   - bedParamsFor / bellShotFor : how a mood is PLAYED (frequencies, brightness, levels, cadence).
//   - deriveSynthCharacter       : the per-seed INSTRUMENT — a distinct timbral room each dream is
//                                  built in (oscillator types, harmonic interval, filter/LFO shape,
//                                  reverb size, noise colour). The mood mapping above rides on top.

import type { MoodAxis } from '../manifest/types';
import { makeRng, type Rng } from '../dream/prng';

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

// ---------------------------------------------------------------------------
// Per-seed synth character — the INSTRUMENT (mood is how it's played).
// ---------------------------------------------------------------------------
//
// Two different seeds should sound architecturally different, not merely parametrically
// different: a different oscillator blend, a different harmonic interval stacked in the drone,
// a different filter/LFO motion, a different room size. The palette is deliberately BOUNDED so
// every dream still reads as DREAMREEL — warm, ambient, faintly uncanny — just a different room
// of it. All choices are deterministic from the seed via makeRng; an empty/whitespace seed
// returns DEFAULT_SYNTH_CHARACTER, which reproduces the original hand-tuned bed bit-for-bit.

export type OscType = 'sine' | 'triangle' | 'sawtooth' | 'square';
export type FilterKind = 'lowpass' | 'bandpass' | 'highpass';
export type LfoShape = 'sine' | 'triangle' | 'sawtooth' | 'square';
export type NoiseColor = 'white' | 'pink' | 'brown';

/**
 * A seed's timbral identity. Plain numbers/enums only — engine.ts builds (or re-tunes) its Tone
 * graph from these, while bedParamsFor's mood reshaping still rides on top.
 */
export interface SynthCharacter {
  oscAType: OscType; // drone oscillator A timbre
  oscBType: OscType; // drone oscillator B timbre (the partner voice)
  bellType: OscType; // bell-synth timbre (kept soft)
  intervalRatio: number; // harmonic interval oscB stacks above oscA (e.g. 1.5 = perfect fifth)
  detuneSpread: number; // extra base detune on oscB, in cents — timbral "width" atop mood beating
  droneGain: number; // body level of the drone
  filterType: FilterKind; // drone filter character
  filterQ: number; // drone filter resonance
  cutoffScale: number; // multiplies the mood-driven cutoff — the room's brightness bias
  lfoType: LfoShape; // shape of the slow filter-sweep LFO (its motion character)
  lfoRateHz: number; // LFO rate
  lfoMin: number; // LFO sweep floor (Hz on the drone filter)
  lfoMax: number; // LFO sweep ceiling (Hz on the drone filter)
  noiseColor: NoiseColor; // tape-air colour
  reverbDecay: number; // room size (seconds); mood still controls wetness
}

/** The neutral instrument: identical to engine.ts's original hand-tuned build values. */
export const DEFAULT_SYNTH_CHARACTER: SynthCharacter = {
  oscAType: 'sine',
  oscBType: 'triangle',
  bellType: 'sine',
  intervalRatio: 1.5,
  detuneSpread: 0,
  droneGain: 0.22,
  filterType: 'lowpass',
  filterQ: 1,
  cutoffScale: 1,
  lfoType: 'sine',
  lfoRateHz: 0.05,
  lfoMin: 320,
  lfoMax: 900,
  noiseColor: 'pink',
  reverbDecay: 7,
};

// Bounded palettes — repeats bias the weighting toward the warm/ambient end.
const OSC_A: readonly OscType[] = ['sine', 'sine', 'triangle', 'triangle', 'sawtooth'];
const OSC_B: readonly OscType[] = ['triangle', 'triangle', 'sine', 'sawtooth', 'square'];
const BELL: readonly OscType[] = ['sine', 'sine', 'sine', 'triangle'];
// Consonant + one uncanny (tritone) interval so the drone's harmony varies per dream.
const INTERVALS: readonly number[] = [1.2, 1.25, 1.3333, 1.4142, 1.5, 1.6, 2.0];
const FILTERS: readonly FilterKind[] = ['lowpass', 'lowpass', 'lowpass', 'bandpass'];
const LFO_SHAPES: readonly LfoShape[] = ['sine', 'sine', 'triangle'];
const NOISES: readonly NoiseColor[] = ['pink', 'pink', 'brown', 'white'];

const LFO_CENTER = 610; // matches DEFAULT (min 320 / max 900 -> centre 610, span 290)

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[rng.int(arr.length)];
}

function span(rng: Rng, lo: number, hi: number): number {
  return lo + rng.next() * (hi - lo);
}

/**
 * Map a seed to a distinct, bounded synth character. Deterministic: the same seed always yields an
 * identical character (deep-equal, stable across calls); an empty/whitespace seed yields the default
 * bed. Every field stays inside the palettes/ranges above, so the bed always sounds like DREAMREEL.
 */
export function deriveSynthCharacter(seed: string): SynthCharacter {
  if (!seed.trim()) return { ...DEFAULT_SYNTH_CHARACTER };

  // A dedicated child stream so the character never disturbs the walk/text/audio seed streams.
  const rng = makeRng(`${seed}:synth`);

  // Draw in a FIXED order — the sequence is part of the determinism contract.
  const oscAType = pick(rng, OSC_A);
  const oscBType = pick(rng, OSC_B);
  const bellType = pick(rng, BELL);
  const intervalRatio = pick(rng, INTERVALS);
  const detuneSpread = span(rng, 0, 14);
  const droneGain = span(rng, 0.16, 0.26);
  const filterType = pick(rng, FILTERS);
  const filterQ = span(rng, 0.7, 2);
  const cutoffScale = span(rng, 0.8, 1.3);
  const lfoType = pick(rng, LFO_SHAPES);
  const lfoRateHz = span(rng, 0.03, 0.09);
  const lfoHalfSpan = span(rng, 200, 380);
  const noiseColor = pick(rng, NOISES);
  const reverbDecay = span(rng, 5, 10);

  return {
    oscAType,
    oscBType,
    bellType,
    intervalRatio,
    detuneSpread,
    droneGain,
    filterType,
    filterQ,
    cutoffScale,
    lfoType,
    lfoRateHz,
    lfoMin: Math.max(180, LFO_CENTER - lfoHalfSpan),
    lfoMax: LFO_CENTER + lfoHalfSpan,
    noiseColor,
    reverbDecay,
  };
}
