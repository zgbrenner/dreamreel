import { describe, it, expect } from 'vitest';
import {
  FlashGuard,
  generalBrightnessGuard,
  REDUCED_MOTION_FLASHES,
} from '../../src/render/flashGuard';

const DT = 1 / 60;

// Fire `n` flash pulses (peak for a few frames, then back to baseline to re-arm). Returns the
// peak OUTPUT brightness the guard allowed for each pulse.
function firePulses(g: FlashGuard, n: number, peak: number, framesHigh = 3, framesLow = 4): number[] {
  const peaks: number[] = [];
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (let f = 0; f < framesHigh; f++) p = Math.max(p, g.limit(peak, DT));
    for (let f = 0; f < framesLow; f++) g.limit(1.0, DT);
    peaks.push(p);
  }
  return peaks;
}

describe('FlashGuard', () => {
  it('lets a single dramatic flash through at full strength', () => {
    const g = generalBrightnessGuard(1);
    const peaks = firePulses(g, 1, 1.6);
    expect(peaks[0]).toBeCloseTo(1.6, 5);
  });

  it('caps the flash rate: beyond the allowed onsets per second, flashes are suppressed', () => {
    const g = generalBrightnessGuard(1); // 3 flashes / 1 s window
    // 6 rapid pulses (~0.12 s each → all inside one 1 s window).
    const peaks = firePulses(g, 6, 1.6);
    const passed = peaks.filter((p) => p > 1.3).length;
    const suppressed = peaks.filter((p) => p < 1.2).length;
    expect(passed).toBeLessThanOrEqual(3);
    expect(suppressed).toBeGreaterThanOrEqual(2);
  });

  it('re-allows flashes once the rolling window clears', () => {
    const g = generalBrightnessGuard(1);
    firePulses(g, 4, 1.6); // exhaust the budget (4th suppressed)
    // Idle well past the 1 s window at resting brightness.
    for (let i = 0; i < 90; i++) g.limit(1.0, DT);
    const after = firePulses(g, 1, 1.6);
    expect(after[0]).toBeCloseTo(1.6, 5);
  });

  it('does not suppress a sustained (non-strobing) brightness change', () => {
    const g = generalBrightnessGuard(1);
    // Hold a brighter-but-steady level for 2 s; baseline should follow and never clamp it.
    let last = 0;
    for (let i = 0; i < 120; i++) last = g.limit(1.4, DT);
    expect(last).toBeCloseTo(1.4, 3);
  });

  it('enforces the absolute ceiling', () => {
    const g = generalBrightnessGuard(1); // ceiling 1.8
    expect(g.limit(5.0, DT)).toBeLessThanOrEqual(1.8 + 1e-9);
  });

  it('reduced-motion limits suppress the second rapid flash', () => {
    const g = generalBrightnessGuard(1);
    g.setLimits(REDUCED_MOTION_FLASHES, 1.25); // 1 flash / window, tight ceiling
    const peaks = firePulses(g, 3, 1.6);
    expect(peaks[0]).toBeLessThanOrEqual(1.25 + 1e-9); // ceiling-capped
    expect(peaks[0]).toBeGreaterThan(1.2); // but the first flash still reads
    expect(peaks[1]).toBeLessThan(1.2); // second is suppressed
    expect(peaks[2]).toBeLessThan(1.2);
  });

  it('is frame-rate independent: the rate cap holds under a different dt', () => {
    const g = generalBrightnessGuard(1);
    // Same ~0.7 s of rapid flashing, but at 30 fps using larger frames.
    const peaks: number[] = [];
    for (let i = 0; i < 6; i++) {
      let p = 0;
      for (let f = 0; f < 2; f++) p = Math.max(p, g.limit(1.6, 1 / 30));
      for (let f = 0; f < 2; f++) g.limit(1.0, 1 / 30);
      peaks.push(p);
    }
    expect(peaks.filter((p) => p > 1.3).length).toBeLessThanOrEqual(3);
  });
});
