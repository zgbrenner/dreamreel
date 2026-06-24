// app/src/dream/mood.ts
// Pure vector math for the dream path: cosine similarity, L2 normalization, and projection
// of an embedding onto the mood axes. No DOM, no three.js.

import { MOOD_AXES, type MoodAxis } from '../manifest/types';

export function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function l2norm(v: number[]): number[] {
  const m = Math.sqrt(dot(v, v)) || 1;
  return v.map((x) => x / m);
}

/** Cosine similarity. Assumes inputs may not be unit-length; normalizes defensively. */
export function cosine(a: number[], b: number[]): number {
  const ma = Math.sqrt(dot(a, a)) || 1;
  const mb = Math.sqrt(dot(b, b)) || 1;
  return dot(a, b) / (ma * mb);
}

const SQUASH = 2.2; // matches the pipeline's projection squash so live mood == asset.mood scale

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Project an embedding onto each mood axis vector and squash to 0..1. */
export function projectMood(
  embedding: number[],
  moodAxes: Record<MoodAxis, number[]>,
): Record<MoodAxis, number> {
  const out = {} as Record<MoodAxis, number>;
  for (const axis of MOOD_AXES) {
    out[axis] = sigmoid(SQUASH * dot(embedding, moodAxes[axis]));
  }
  return out;
}

export function blankMood(): Record<MoodAxis, number> {
  const out = {} as Record<MoodAxis, number>;
  for (const axis of MOOD_AXES) out[axis] = 0.5;
  return out;
}

// --- mood-vector blend/query helpers (consumed by later visual/audio/text prompts) ---
// Mood is a blendable vector, never a single label; these read it without collapsing it.

export interface MoodWeight {
  axis: MoodAxis;
  value: number;
}

/**
 * The top-k axes by strength, descending — for asking "what is this dream MOSTLY about"
 * without throwing away the blend. Ties break by MOOD_AXES order (stable, deterministic).
 * k is clamped to [0, MOOD_AXES.length].
 */
export function dominantAxes(mood: Record<MoodAxis, number>, k = 2): MoodWeight[] {
  const ranked = MOOD_AXES.map((axis) => ({ axis, value: mood[axis] }));
  // Stable sort: Array.prototype.sort is stable in modern engines, so equal values keep
  // their MOOD_AXES order. Sort by value descending only.
  ranked.sort((a, b) => b.value - a.value);
  return ranked.slice(0, Math.max(0, Math.min(k, MOOD_AXES.length)));
}

/**
 * Weighted blend of several mood vectors into one (per-axis weighted average), e.g. to mix the
 * current visual's mood with an audio clip's. Weights default to equal; non-positive total
 * weight falls back to a blank (neutral) mood rather than dividing by zero. Result stays 0..1
 * when inputs are 0..1.
 */
/**
 * Signed alignment of two mood vectors (0 when both are neutral at 0.5). Roughly in [-0.25, 0.25]
 * when inputs are 0..1 — used to bias text/audio picks toward emotionally matching assets.
 */
export function moodAffinity(a: Record<MoodAxis, number>, b: Record<MoodAxis, number>): number {
  let acc = 0;
  for (const axis of MOOD_AXES) acc += (a[axis] - 0.5) * (b[axis] - 0.5);
  return acc / MOOD_AXES.length;
}

export function blendMoods(
  moods: Record<MoodAxis, number>[],
  weights?: number[],
): Record<MoodAxis, number> {
  if (moods.length === 0) return blankMood();
  const w = weights ?? moods.map(() => 1);
  const total = w.reduce((s, x) => s + Math.max(0, x), 0);
  if (total <= 0) return blankMood();
  const out = {} as Record<MoodAxis, number>;
  for (const axis of MOOD_AXES) {
    let acc = 0;
    for (let i = 0; i < moods.length; i++) acc += moods[i][axis] * Math.max(0, w[i] ?? 0);
    out[axis] = acc / total;
  }
  return out;
}
