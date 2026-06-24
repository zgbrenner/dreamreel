// app/src/render/flashGuard.ts
// A photosensitivity flash-rate governor for the cosmetic brightness path (NOT part of the
// deterministic dream script — the film/flicker layer is explicitly free to vary). It enforces a
// WCAG 2.3.1 "three flashes" style cap: a single dramatic luminance flash is allowed through, but
// once the rate of flash ONSETS in a rolling window would exceed the safe count, further flashes
// are suppressed (held sub-threshold) until the window clears. An absolute ceiling caps peak
// brightness. Pure + frame-rate-independent (driven by dt), so it is unit-testable without WebGL.
//
// This bounds RAPID full-frame brightness oscillation (strobing) — the photosensitivity hazard —
// while leaving the slow flicker, single splice flashes, and the underlying dream sequence intact.

export interface FlashGuardConfig {
  /** Upward excursion above the resting baseline that counts as a flash (≈ fraction of full white). */
  flashDelta: number;
  /** Rolling window for the rate cap, seconds (WCAG uses 1 s). */
  windowSec: number;
  /** Allowed flash onsets per window (WCAG general-flash threshold is 3; tighten under reduced motion). */
  maxFlashesPerWindow: number;
  /** Absolute ceiling on the output brightness multiplier. */
  ceiling: number;
  /** Time constant (s) for the resting baseline to follow sustained (non-flash) brightness changes. */
  baselineTau: number;
}

export class FlashGuard {
  private clock = 0;
  private baseline: number;
  private onsets: number[] = []; // onset timestamps within the rolling window
  private armed = true; // ready to register a new onset (true once brightness has fallen back down)

  constructor(
    private cfg: FlashGuardConfig,
    initial = 1,
  ) {
    this.baseline = initial;
  }

  /** Tighten/loosen the rate cap and ceiling (e.g. on a prefers-reduced-motion change). */
  setLimits(maxFlashesPerWindow: number, ceiling: number): void {
    this.cfg.maxFlashesPerWindow = Math.max(0, maxFlashesPerWindow);
    this.cfg.ceiling = ceiling;
  }

  reset(initial = 1): void {
    this.clock = 0;
    this.baseline = initial;
    this.onsets = [];
    this.armed = true;
  }

  /**
   * Clamp `target` brightness for this frame given the elapsed `dt` (seconds). Returns a
   * safe brightness multiplier: a flash passes through unless it would breach the rate cap, in
   * which case it is held just below the flash threshold.
   */
  limit(target: number, dt: number): number {
    const step = Math.max(0, dt);
    this.clock += step;
    // Drop onsets that have aged out of the window.
    const cutoff = this.clock - this.cfg.windowSec;
    while (this.onsets.length > 0 && this.onsets[0] <= cutoff) this.onsets.shift();

    const desired = Math.min(target, this.cfg.ceiling);
    const hi = this.baseline + this.cfg.flashDelta;
    const lo = this.baseline + this.cfg.flashDelta * 0.4; // hysteresis: re-arm only below this

    if (desired >= hi) {
      if (this.armed) {
        // A fresh flash onset.
        if (this.onsets.length >= this.cfg.maxFlashesPerWindow) {
          // Rate would be exceeded — suppress this flash (hold sub-threshold). Stay armed so the
          // suppression persists until a window slot frees up.
          return lo;
        }
        this.onsets.push(this.clock);
        this.armed = false; // counted once; the rest of this flash + its decay pass through
      }
      // Either a newly-allowed onset or the continuation of an allowed flash.
      return desired;
    }

    // Below the flash threshold: pass through, re-arm once it drops past the lower hysteresis line,
    // and let the resting baseline follow sustained (non-flash) brightness so we never fight a
    // legitimately brighter scene.
    if (desired < lo) this.armed = true;
    const a = this.cfg.baselineTau > 0 ? Math.min(1, step / this.cfg.baselineTau) : 1;
    this.baseline += (desired - this.baseline) * a;
    return desired;
  }
}

/** General (no prefers-reduced-motion) brightness governor: ≤3 flashes/sec, modest ceiling. */
export function generalBrightnessGuard(initial = 1): FlashGuard {
  return new FlashGuard(
    { flashDelta: 0.18, windowSec: 1.0, maxFlashesPerWindow: 3, ceiling: 1.8, baselineTau: 0.4 },
    initial,
  );
}

/** General exposure governor (blowouts swell exposure): same rate cap, higher ceiling. */
export function generalExposureGuard(initial = 1): FlashGuard {
  return new FlashGuard(
    { flashDelta: 0.18, windowSec: 1.0, maxFlashesPerWindow: 3, ceiling: 2.0, baselineTau: 0.4 },
    initial,
  );
}

/** Reduced-motion limits: at most one flash per second and a tight ceiling. */
export const REDUCED_MOTION_FLASHES = 1;
export const REDUCED_MOTION_BRIGHT_CEIL = 1.25;
export const REDUCED_MOTION_EXPO_CEIL = 1.3;
