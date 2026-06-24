// app/src/dream/filterDirector.ts
// Pure brain for the dream's look: the SINGLE source of truth mapping emotion (the blended 12-axis
// mood vector) + intensity to every deterministic look choice — post-FX filter strengths, the
// crossfade TRANSITION, PROCEDURAL-source parameters, and whether the psychedelic Butterchurn layer
// engages. Keeping it all here (no DOM, no three.js, no randomness of its own — callers pass a
// seeded `roll`) keeps the look coherent and unit-testable.
//
// Two axis groupings live here:
//  • FILTER_AXES — the original six CLIP axes the post-FX filter catalog reacts to (1:1 mapping).
//  • The full 12-axis taxonomy now also drives transition CHOICE and procedural variation, so the
//    new emotional axes (love/loss/joy/fear/absurdity/strange) are no longer inert in the renderer.

import { MOOD_AXES, type MoodAxis } from '../manifest/types';
import type { IntensityRegime } from './intensity';

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

// ============================================================================
// Transition selection (gl-transitions catalog in render/transitions.ts).
// Each axis nominates a family of transition names; the live mood weights those
// families (sharpened, so a dominant emotion leads) and the BLEND of all axes is
// reflected — two strong emotions draw from both families. Selection is made
// deterministically from a caller-supplied seeded `roll` (this module stays
// random-free). Neutral mood → a gentle identity default; reduced-motion → a
// gentle, no-flicker set; coherence troughs → a calm dissolve so the lucid image
// reads (preserving the trough-easing contract).
// ============================================================================

/** Per-axis transition families. Names MUST exist in render/transitions.ts TRANSITIONS. */
export const TRANSITION_BY_AXIS: Record<MoodAxis, readonly string[]> = {
  melancholy: ['crossLuma', 'fade', 'fadeBlack'],
  uncanny: ['solarizeWipe', 'swirl', 'glitch'],
  nostalgic: ['liquidWave', 'ripple', 'crossLuma'],
  ominous: ['cut', 'slideHarsh', 'barWipe'],
  tender: ['bloomDissolve', 'lightFlash', 'crossLuma'],
  mechanical: ['glitch', 'pixelize', 'posterizeWipe'],
  love: ['bloomDissolve', 'lightFlash', 'irisOpen'],
  loss: ['fadeBlack', 'fade', 'crossLuma'],
  joy: ['irisOpen', 'radialReveal', 'bloomDissolve'],
  fear: ['cut', 'glitch', 'slideHarsh'],
  absurdity: ['dreamWarp', 'melt', 'swirl'],
  strange: ['swirl', 'ripple', 'dreamWarp'],
};

/** Gentle, luminous defaults used when no emotion dominates (the identity path). */
export const NEUTRAL_TRANSITIONS = ['fade', 'crossLuma', 'bloomDissolve', 'lightFlash'] as const;
/** prefers-reduced-motion: soft dissolves only — no hard cuts, glitch, or push. */
export const GENTLE_TRANSITIONS = ['fade', 'crossLuma', 'bloomDissolve', 'liquidWave'] as const;
/** Inside a coherence trough: the calmest dissolves, so the lucid image resolves cleanly. */
export const TROUGH_TRANSITIONS = ['fade', 'crossLuma'] as const;

const FLAT_EPS = 1e-6; // mood spread below this is treated as neutral

function moodSpread(mood: Record<MoodAxis, number>): number {
  let min = Infinity;
  let max = -Infinity;
  for (const a of MOOD_AXES) {
    const v = mood[a];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min;
}

function pickFrom(list: readonly string[], roll: number): string {
  if (list.length === 0) return 'fade';
  const i = Math.min(list.length - 1, Math.floor(clamp01(roll) * list.length));
  return list[i];
}

/** Deterministic weighted pick over a name→weight map; sorted by name for stable selection. */
function pickWeighted(weights: Map<string, number>, roll: number): string {
  const entries = [...weights.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) return pickFrom(NEUTRAL_TRANSITIONS, roll);
  let r = clamp01(roll) * total;
  for (const [name, w] of entries) {
    r -= w;
    if (r <= 0) return name;
  }
  return entries[entries.length - 1][0];
}

/**
 * Choose the crossfade transition for a beat. `roll` is a seeded uniform in [0,1) supplied by the
 * caller (so this function is pure). Reflects the mood BLEND, scales emotional weight by intensity
 * (calm moments lean gentle), and honours reduced-motion + trough easing.
 */
export function pickTransition(
  mood: Record<MoodAxis, number>,
  intensity: number,
  inTrough: boolean,
  roll: number,
  reduceMotion = false,
): string {
  if (inTrough) return pickFrom(TROUGH_TRANSITIONS, roll);
  if (reduceMotion) return pickFrom(GENTLE_TRANSITIONS, roll);
  if (moodSpread(mood) < FLAT_EPS) return pickFrom(NEUTRAL_TRANSITIONS, roll);

  const i = clamp01(intensity);
  const weights = new Map<string, number>();
  // Calm-moment bias: low intensity adds weight to the gentle defaults so quiet beats stay soft.
  const calm = (1 - i) * 1.5;
  for (const name of NEUTRAL_TRANSITIONS) weights.set(name, (weights.get(name) ?? 0) + calm);
  // Emotional families, sharpened so a dominant axis leads but blends still contribute.
  for (const axis of MOOD_AXES) {
    const w = Math.pow(Math.max(0, mood[axis]), SHARPEN) * (0.4 + i);
    if (w <= 0) continue;
    for (const name of TRANSITION_BY_AXIS[axis]) weights.set(name, (weights.get(name) ?? 0) + w);
  }
  if (weights.size === 0) return pickFrom(NEUTRAL_TRANSITIONS, roll);
  return pickWeighted(weights, roll);
}

// ============================================================================
// Procedural-source variation. The existing procedural kinds (fog/stars/ripple/…)
// read these params so they vary with emotion + intensity without adding new
// "kinds". Centred on 0.5: a NEUTRAL mood (all axes 0.5) at intensity 0 returns
// NEUTRAL_PROC_PARAMS exactly, so the identity look is preserved bit-for-bit.
// ============================================================================

export interface ProceduralParams {
  speed: number; // animation rate multiplier (1 = baseline)
  density: number; // element density / fill 0..1 (fog darkness, star count, …)
  brightness: number; // luminance of emitted elements 0..1
  warmth: number; // palette warmth 0..1 (toward amber) vs cool (toward verdigris)
  jitter: number; // chaotic instability 0..1 (uncanny/mechanical/fear/intensity)
}

export const NEUTRAL_PROC_PARAMS: ProceduralParams = {
  speed: 1,
  density: 0.5,
  brightness: 0.6,
  warmth: 0.5,
  jitter: 0,
};

const clampPos = (v: number) => Math.max(0, v);

/** Map emotion + intensity to procedural-source params (see NEUTRAL_PROC_PARAMS for the identity). */
export function proceduralParams(
  mood: Record<MoodAxis, number>,
  intensity: number,
): ProceduralParams {
  const i = clamp01(intensity);
  const d = (a: MoodAxis) => mood[a] - 0.5; // signed deviation from neutral, -0.5..0.5
  return {
    speed: clampPos(1 + i * 1.2 + d('joy') * 1.6 - d('loss') * 0.8),
    density: clamp01(0.5 + d('ominous') * 0.8 + d('fear') * 0.8 - d('loss') * 0.9),
    brightness: clamp01(
      0.6 + d('joy') * 0.8 + d('tender') * 0.5 + d('love') * 0.4 - d('melancholy') * 0.4 - d('loss') * 0.4,
    ),
    warmth: clamp01(0.5 + d('nostalgic') * 0.6 + d('tender') * 0.4 - d('ominous') * 0.4 - d('fear') * 0.3),
    jitter: clamp01(d('uncanny') * 1.0 + d('mechanical') * 0.8 + d('fear') * 0.6 + i * 0.5),
  };
}

// ============================================================================
// Butterchurn (psychedelic Milkdrop) layer engagement. Reactive eye-candy only
// for high-intensity "frenzy" regimes; off under reduced-motion and at calm.
// ============================================================================

/** Whether the Butterchurn layer should be engaged this frame. Pure decision. */
export function butterchurnEngaged(
  intensity: number,
  regime: IntensityRegime,
  reduceMotion: boolean,
): boolean {
  if (reduceMotion) return false;
  return regime === 'frenzy' && clamp01(intensity) > 0.72;
}

/** Deterministic preset index from a seeded `roll`; -1 when no presets are available. */
export function butterchurnPresetIndex(roll: number, count: number): number {
  if (count <= 0) return -1;
  return Math.min(count - 1, Math.floor(clamp01(roll) * count));
}
