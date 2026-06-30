// app/src/dream/moodBias.ts
//
// Seed-level EMOTIONAL IDENTITY for a dream (2026 direction — see CLAUDE.md "Content & aesthetic
// direction"). `seedParams` gives a dream its surreality/tempo; this gives it its emotional *pull*.
// Real dreams lean warm/strange — tender, nostalgic, love, joy, absurdity, the uncanny-but-benign —
// with fear a MINORITY, plus the classic mid-dream turn where a coherent dream drifts INTO a
// nightmare and (sometimes) back out. So most seeds draw a gentle identity, a minority a nightmare
// one, and either may carry an arc.
//
// The identity is a bias over the 12 mood axes that the Dreamwalker leans its START point and its
// per-beat picks toward (a bounded nudge — it colours the dream without collapsing its variety, the
// same spine-that-bends philosophy as steering/recurrence). Pure + deterministic per seed via a
// dedicated `:mood` prng stream, so the dream script stays reproducible.

import { MOOD_AXES, type MoodAxis } from '../manifest/types';
import { makeRng, type Rng } from './prng';

// A bias is expressed in the SAME 0..1 space as a mood vector, where 0.5 is neutral: >0.5 pulls the
// walk TOWARD that axis, <0.5 pushes away. This matches mood.moodAffinity's centered dot product, so
// the walker can apply it with no conversion.
export type MoodBiasVector = Record<MoodAxis, number>;

export interface MoodArc {
  /** The bias the dream drifts toward mid-dream — the "turn" (into a nightmare, or out of one). */
  target: MoodBiasVector;
  /** Phase (0..1) where the turn peaks. */
  center: number;
  /** Half-width of the turn in phase units; wider = the dream stays turned longer. */
  width: number;
}

export interface MoodIdentity {
  /** Emotional class — for tests/telemetry only, never shown to the viewer. */
  kind: 'gentle' | 'neutral' | 'nightmare';
  /** The dream's resting emotional pull. */
  baseline: MoodBiasVector;
  /** Optional mid-dream turn; null when the dream holds its baseline throughout. */
  arc: MoodArc | null;
}

// The warm/strange region real dreams mostly inhabit, and the fear region they only sometimes do.
const GENTLE_AXES: MoodAxis[] = ['tender', 'nostalgic', 'love', 'joy', 'absurdity', 'strange'];
const FEAR_AXES: MoodAxis[] = ['fear', 'ominous'];
const COOL_AXES: MoodAxis[] = ['joy', 'love', 'tender'];

const NEUTRAL = 0.5;
const ARC_DEPTH = 0.7; // max blend toward the arc target at the turn's peak

function neutralVector(): MoodBiasVector {
  const v = {} as MoodBiasVector;
  for (const a of MOOD_AXES) v[a] = NEUTRAL;
  return v;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Deterministic subset of `arr` of size in [min, max], drawn with `rng` (no mutation of `arr`). */
function pickSome<T>(rng: Rng, arr: readonly T[], min: number, max: number): T[] {
  const n = Math.min(arr.length, min + rng.int(max - min + 1));
  const pool = arr.slice();
  const out: T[] = [];
  for (let i = 0; i < n && pool.length > 0; i++) out.push(pool.splice(rng.int(pool.length), 1)[0]);
  return out;
}

/** A coherent dream turning INTO a nightmare: a pull toward fear, cooling joy/tenderness. */
function nightmareArc(rng: Rng): MoodArc {
  const target = neutralVector();
  for (const a of FEAR_AXES) target[a] = 0.85 + rng.next() * 0.1;
  target.joy = 0.28;
  target.tender = 0.3;
  return { target, center: 0.3 + rng.next() * 0.45, width: 0.1 + rng.next() * 0.12 };
}

/** Waking OUT of a nightmare: a pull toward tenderness/nostalgia, easing the fear. */
function gentleArc(rng: Rng): MoodArc {
  const target = neutralVector();
  target.tender = 0.85;
  target.nostalgic = 0.82;
  for (const a of FEAR_AXES) target[a] = 0.32;
  return { target, center: 0.35 + rng.next() * 0.45, width: 0.1 + rng.next() * 0.12 };
}

function gentleIdentity(rng: Rng): MoodIdentity {
  const baseline = neutralVector();
  for (const a of pickSome(rng, GENTLE_AXES, 2, 3)) baseline[a] = 0.82 + rng.next() * 0.13;
  for (const a of FEAR_AXES) baseline[a] = 0.2 + rng.next() * 0.12; // suppress fear
  // A coherent dream sometimes turns into a nightmare and (usually) back out.
  const arc = rng.next() < 0.35 ? nightmareArc(rng) : null;
  return { kind: 'gentle', baseline, arc };
}

function neutralIdentity(rng: Rng): MoodIdentity {
  const baseline = neutralVector();
  // Shallow leanings so a "neutral" dream still has some colour, either warm or cool.
  for (const a of pickSome(rng, MOOD_AXES, 2, 3)) baseline[a] = 0.4 + rng.next() * 0.3;
  const arc = rng.next() < 0.3 ? nightmareArc(rng) : null;
  return { kind: 'neutral', baseline, arc };
}

function nightmareIdentity(rng: Rng): MoodIdentity {
  const baseline = neutralVector();
  for (const a of FEAR_AXES) baseline[a] = 0.82 + rng.next() * 0.13;
  if (rng.next() < 0.5) baseline.loss = 0.7 + rng.next() * 0.2; // sometimes grief-tinged
  for (const a of COOL_AXES) baseline[a] = 0.2 + rng.next() * 0.12; // suppress warmth
  // Sometimes the dreamer wakes OUT of the nightmare toward tenderness.
  const arc = rng.next() < 0.4 ? gentleArc(rng) : null;
  return { kind: 'nightmare', baseline, arc };
}

/**
 * The dream's emotional identity, drawn from a gentle-leaning distribution: most seeds gentle, a
 * minority nightmare, with neutral in between. Deterministic per seed.
 */
export function deriveMoodIdentity(seed: string): MoodIdentity {
  const rng = makeRng(`${seed}:mood`);
  const cls = rng.next();
  // ≈68% gentle / 20% neutral / 12% nightmare — gentle is the baseline, fear the departure.
  if (cls < 0.68) return gentleIdentity(rng);
  if (cls < 0.88) return neutralIdentity(rng);
  return nightmareIdentity(rng);
}

/** Raised-cosine bump: 1 at `center`, 0 beyond ±`width`, on a wrapping [0,1) phase circle. */
function pulse(phase: number, center: number, width: number): number {
  if (width <= 0) return 0;
  let d = phase - center;
  d -= Math.round(d); // wrap onto (-0.5, 0.5]
  if (Math.abs(d) >= width) return 0;
  return 0.5 * (1 + Math.cos(Math.PI * (d / width)));
}

/**
 * The effective bias at a normalized dream phase (0..1, wraps). Without an arc this is just the
 * baseline; with one it blends baseline → arc.target across the turn, so the dream drifts in and
 * (the pulse being a bump) back out. Pure.
 */
export function moodBiasAt(identity: MoodIdentity, phase: number): MoodBiasVector {
  const { baseline, arc } = identity;
  if (!arc) return baseline;
  const amt = ARC_DEPTH * pulse(phase, arc.center, arc.width);
  if (amt <= 0) return baseline;
  const out = {} as MoodBiasVector;
  for (const a of MOOD_AXES) out[a] = clamp01(baseline[a] * (1 - amt) + arc.target[a] * amt);
  return out;
}
