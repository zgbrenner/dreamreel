// app/src/dream/textDirector.ts
// Pure mood → on-screen text styling. No DOM — Captions and the conductor's title-card canvas
// consume these targets so drifting whispers and intertitles tint with the emotional blend.

import { MOOD_AXES, type MoodAxis } from '../manifest/types';

const PALETTE = {
  bone: [216, 210, 196],
  lamp: [232, 200, 135],
  amber: [200, 163, 94],
  sepia: [107, 86, 64],
  verdigris: [74, 107, 102],
} as const;

function lerpRgb(a: readonly number[], b: readonly number[], t: number): string {
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function warmthSignal(mood: Record<MoodAxis, number>): number {
  const d = (a: MoodAxis) => mood[a] - 0.5;
  const warm =
    d('love') + d('joy') + d('tender') + d('nostalgic') - d('fear') - d('loss') - d('ominous');
  return clamp01(0.5 + warm * 0.35);
}

export interface WhisperStyle {
  color: string;
  opacity: number;
}

export interface TitleCardPalette {
  ink: string;
  text: string;
  frame: string;
}

/** Drifting-caption colour + opacity from the live mood blend. */
export function whisperStyle(mood: Record<MoodAxis, number>): WhisperStyle {
  const d = (a: MoodAxis) => mood[a] - 0.5;
  const warmthT = warmthSignal(mood);
  const color = lerpRgb(PALETTE.verdigris, PALETTE.lamp, warmthT);
  const opacity = clamp01(0.78 + d('strange') * 0.14 + d('absurdity') * 0.1 - d('loss') * 0.12);
  return { color, opacity: Math.max(0.55, opacity) };
}

/** Bodoni intertitle ink/text/frame colours from the live mood blend. */
export function titleCardPalette(mood: Record<MoodAxis, number>): TitleCardPalette {
  const warmthT = warmthSignal(mood);
  return {
    ink: '#0E0B08',
    text: lerpRgb(PALETTE.bone, PALETTE.lamp, warmthT),
    frame: lerpRgb(PALETTE.sepia, PALETTE.amber, warmthT),
  };
}

/** Deterministic sanity: every axis produces finite style output. */
export function stylesForAllAxes(
  moodPeaking: (axis: MoodAxis) => Record<MoodAxis, number>,
): { whisper: WhisperStyle; card: TitleCardPalette }[] {
  return MOOD_AXES.map((axis) => ({
    whisper: whisperStyle(moodPeaking(axis)),
    card: titleCardPalette(moodPeaking(axis)),
  }));
}
