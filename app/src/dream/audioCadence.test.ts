import { describe, it, expect } from 'vitest';
import { makeAudioCadence, onVisualBeat, commitPick, type AudioCadence } from './audioCadence';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simulate driving the cadence with a fixed array of beat dwells and pick
 * dwells.  Returns the indices (0-based) of the beats at which
 * `onVisualBeat` returned true.
 *
 * `pickDwells` is consumed in order each time a pick is committed.  If it
 * runs out before the beats end, the last value is reused (so tests with a
 * single constant dwell are easy to write).
 */
function runCadence(beatDwells: number[], pickDwells: number[]): number[] {
  const c = makeAudioCadence();
  const fired: number[] = [];
  let pickIdx = 0;

  for (let i = 0; i < beatDwells.length; i++) {
    if (onVisualBeat(c, beatDwells[i])) {
      fired.push(i);
      const next = pickDwells[Math.min(pickIdx, pickDwells.length - 1)];
      commitPick(c, next);
      pickIdx++;
    }
  }
  return fired;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('audioCadence', () => {
  // (a) Given a fixed beat-dwell sequence and fixed pick-dwell responses, the
  //     set of beat-indices where onVisualBeat returns true is a fixed,
  //     expected list.
  it('(a) fires at expected beat indices given fixed dwells', () => {
    // Beats each 2 000 ms; each pick dwell = 5 000 ms.
    // Starting with dwellMs=0 the very first beat always fires.
    // After beat 0 fires, elapsed resets to 0 and dwellMs=5000.
    // beats 1,2 each add 2000 → elapsed 2000, 4000 — not yet ≥ 5000.
    // beat 3 adds 2000 → elapsed 6000 ≥ 5000 → fires.
    // After beat 3 fires, elapsed resets to 0 and dwellMs=5000.
    // beats 4,5 → elapsed 2000, 4000 — not yet.
    // beat 6 → elapsed 6000 → fires.  etc.
    const beats = new Array(10).fill(2000) as number[];
    const fired = runCadence(beats, [5000]);
    expect(fired).toEqual([0, 3, 6, 9]);
  });

  // (b) Pick fire-points depend only on cumulative dwell, not on how the dwell
  //     is chunked into beats. Differently-shaped beat sequences that share the same
  //     cumulative-millisecond thresholds must produce picks at those same cumulative ms.
  it('(b) pick fire-points depend only on cumulative dwell, not beat chunking', () => {
    /**
     * Helper: drive the cadence with a beat-dwell array and a fixed pick dwell.
     * Returns the cumulative milliseconds (not beat indices) at which picks fired.
     */
    function firePointsMs(beats: number[], pickDwellMs: number): number[] {
      const c = makeAudioCadence();
      const points: number[] = [];
      let cum = 0;
      for (const b of beats) {
        cum += b;
        if (onVisualBeat(c, b)) {
          points.push(cum);
          commitPick(c, pickDwellMs);
        }
      }
      return points;
    }

    // Coarse chunking: [5000, 5000, 5000] → cumulative [5000, 10000, 15000]
    //   With pickDwell=5000, fires at each beat (5000≥0, 5000≥5000, 5000≥5000).
    //   Fires at cumulative ms: [5000, 10000, 15000]
    const coarse = [5000, 5000, 5000];

    // Fine chunking: [5000, 2500, 2500, 2500, 2500] → cumulative [5000, 7500, 10000, 12500, 15000]
    // Trace with pickDwell=5000:
    //   beat 0 (5000): elapsed=5000 ≥ 0 → fire at cum=5000, reset dwellMs=5000, elapsedMs=0
    //   beat 1 (2500): elapsed=2500 ≥ 5000? No.
    //   beat 2 (2500): elapsed=5000 ≥ 5000? Yes → fire at cum=10000, reset dwellMs=5000, elapsedMs=0
    //   beat 3 (2500): elapsed=2500 ≥ 5000? No.
    //   beat 4 (2500): elapsed=5000 ≥ 5000? Yes → fire at cum=15000
    // Fires at cumulative ms: [5000, 10000, 15000] ← matches coarse!
    const fine = [5000, 2500, 2500, 2500, 2500];

    const pickDwell = 5000;

    // Both sequences must produce picks at the same cumulative-millisecond thresholds,
    // despite having different beat shapes. This proves that pick timing depends only
    // on cumulative dwell accumulation, not on the beat chunking.
    expect(firePointsMs(coarse, pickDwell)).toEqual(firePointsMs(fine, pickDwell));
  });

  // (c) commitPick resets elapsed to 0 and sets the new dwell.
  it('(c) commitPick resets elapsed and sets nextDwell', () => {
    const c: AudioCadence = makeAudioCadence();

    // Drive one beat so elapsed > 0 and a pick is due (dwellMs=0 initially).
    onVisualBeat(c, 1500);
    expect(c.elapsedMs).toBe(1500);

    // Commit with 8000 ms dwell.
    commitPick(c, 8000);
    expect(c.elapsedMs).toBe(0);
    expect(c.dwellMs).toBe(8000);
  });

  // Extra: initial state has dwellMs=0, so the very first beat always fires.
  it('fires on the very first beat (initial dwellMs=0)', () => {
    const c = makeAudioCadence();
    const fired = onVisualBeat(c, 1);
    expect(fired).toBe(true);
  });

  // Extra: large beat dwell that overshoots the pick dwell fires in one step.
  it('fires when a single large beat overshoots the dwell threshold', () => {
    const c = makeAudioCadence();
    // first beat fires (dwellMs=0); commit with 5000 ms dwell.
    onVisualBeat(c, 1000);
    commitPick(c, 5000);

    // Next single beat is 10 000 ms — far past the 5 000 ms threshold.
    const fired = onVisualBeat(c, 10_000);
    expect(fired).toBe(true);
  });

  // Extra: beat dwell shorter than pick dwell does NOT fire.
  it('does not fire when cumulative elapsed is below dwellMs', () => {
    const c = makeAudioCadence();
    // fire beat 0 so we get a real dwellMs.
    onVisualBeat(c, 1);
    commitPick(c, 10_000);

    // two small beats that don't add up to 10 000.
    expect(onVisualBeat(c, 3000)).toBe(false);
    expect(onVisualBeat(c, 4000)).toBe(false); // total 7000 < 10000
  });
});
