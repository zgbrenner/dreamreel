// app/src/dream/audioCadence.ts
// Pure cadence accumulator for the audio walk.
//
// Audio picks are driven by LOGICAL visual beats, not by wall-clock dt.  Each
// primary visual beat (image or wake-swap) carries a deterministic dwellMs
// (derived from asset.dwellBase and tempoMul, both fixed at pick time).  By
// accumulating those logical dwells — rather than real-time dt — the pick
// sequence becomes a pure function of the seed, independent of frame timing.

export interface AudioCadence {
  elapsedMs: number;
  dwellMs: number;
}

/** Create a fresh cadence accumulator (initial dwellMs of 0 means the very
 *  first beat always fires a pick). */
export function makeAudioCadence(): AudioCadence {
  return { elapsedMs: 0, dwellMs: 0 };
}

/**
 * Call once per PRIMARY visual beat with that beat's logical dwell (ms).
 * Returns true if an audio pick is due now.
 *
 * Pick timing is a function of the beat-dwell SEQUENCE only — never of frame
 * dt — so the audio pick sequence is deterministic per seed.
 */
export function onVisualBeat(c: AudioCadence, beatDwellMs: number): boolean {
  c.elapsedMs += beatDwellMs;
  return c.elapsedMs >= c.dwellMs;
}

/**
 * Commit a pick: set the next dwell threshold and reset the accumulator.
 * Call this immediately after `onVisualBeat` returns true and a pick has been
 * obtained, passing `pick.dwellMs` as `nextDwellMs`.
 */
export function commitPick(c: AudioCadence, nextDwellMs: number): void {
  c.dwellMs = nextDwellMs;
  c.elapsedMs = 0;
}
