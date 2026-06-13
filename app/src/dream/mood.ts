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
