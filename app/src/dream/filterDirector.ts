// app/src/dream/filterDirector.ts
// Pure brain for the dream-filter catalog. Maps the current mood to a strength for each of the
// 6 filters: the dominant axis's filter dominates (sharpened weighting → a smooth crossfade as
// mood drifts), intensity scales the strengths, and coherence troughs ease them toward 0 so the
// lucid image reads clean. No DOM, no three.js, no randomness of its own.
//
// NOTE: mood is now a 12-axis vector, but the filter catalog deliberately maps only the original
// six CLIP axes (FILTER_AXES). The new emotional axes (love/loss/joy/fear/absurdity/strange) are
// carried in the data but NOT yet wired to a visual treatment — that lands in a later prompt.

import type { MoodAxis } from '../manifest/types';

export interface FilterStrengths {
  kaleidoscope: number;
  liquid: number;
  solarize: number;
  melt: number;
  posterize: number;
  feedback: number;
}

// The mood axes the filter catalog currently reacts to (the original six). New axes are inert here.
export const FILTER_AXES = [
  'melancholy',
  'uncanny',
  'nostalgic',
  'ominous',
  'tender',
  'mechanical',
] as const satisfies readonly MoodAxis[];

/** 1:1 mood-axis → filter mapping (confirmed in the spec) for the original six axes. */
export const MOOD_FILTER: Record<(typeof FILTER_AXES)[number], keyof FilterStrengths> = {
  melancholy: 'feedback',
  uncanny: 'solarize',
  nostalgic: 'liquid',
  ominous: 'kaleidoscope',
  tender: 'melt',
  mechanical: 'posterize',
};

const SHARPEN = 4; // higher => the dominant axis's filter stands out more
const TROUGH_EASE = 0.08; // strengths scale by this inside a coherence trough (lucid = near-clean)

function zero(): FilterStrengths {
  return { kaleidoscope: 0, liquid: 0, solarize: 0, melt: 0, posterize: 0, feedback: 0 };
}
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function filterStrengths(
  mood: Record<MoodAxis, number>,
  intensity: number,
  inTrough: boolean,
): FilterStrengths {
  const pow = FILTER_AXES.map((a) => Math.pow(Math.max(0, mood[a]), SHARPEN));
  const sum = pow.reduce((s, x) => s + x, 0) || 1;
  const scale = (0.10 + 0.32 * clamp01(intensity)) * (inTrough ? TROUGH_EASE : 1);

  const out = zero();
  FILTER_AXES.forEach((axis, i) => {
    const w = pow[i] / sum;
    const filter = MOOD_FILTER[axis];
    out[filter] = clamp01(out[filter] + w * scale);
  });
  return out;
}

/** Cap the two geometry-mangling filters so the underlying image is never fully obliterated —
 *  some clarity keeps a dream feeling real. Other filters pass through unchanged. */
export function capDistortion(fs: FilterStrengths): FilterStrengths {
  return { ...fs, kaleidoscope: Math.min(fs.kaleidoscope, 0.3), liquid: Math.min(fs.liquid, 0.45) };
}
