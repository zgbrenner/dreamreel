// app/src/dream/intensity.ts
// The seeded heartbeat. A pure function of a logical clock (tempo-scaled seconds, supplied by
// the caller) producing an intensity in [0,1] plus coherence-trough state. Sporadic by design:
// value-noise + random spikes/holds between rare, brief troughs. No DOM, no three.js.

import { makeRng, type Rng } from './prng';

export type IntensityRegime = 'frenzy' | 'baseline' | 'trough';

export interface IntensitySample {
  intensity: number;
  regime: IntensityRegime;
  inTrough: boolean;
  troughId: number;
}

export interface IntensityEngine {
  sample(logicalTime: number): IntensitySample;
  setMaxIntensity(v: number): void;
  reseed(seed: string): void;
}

interface Trough {
  id: number;
  start: number;
  end: number;
}

// All TROUGH_* constants are in logicalTime (tempo-scaled) seconds.
const TROUGH_MIN_GAP = 22;
const TROUGH_MAX_GAP = 46;
const TROUGH_DUR = 2.0;
const TROUGH_RAMP = 0.8;

const NOISE_CACHE_MAX = 256;
const NOISE_CACHE_LOOKBACK = 64;

class IntensityEngineImpl implements IntensityEngine {
  private rng: Rng;
  // Kept for reseed parity — cellNoise() derives per-cell rngs for positional determinism instead.
  private noiseRng: Rng;
  private maxIntensity = 1;
  private troughs: Trough[] = [];
  private scheduledTo = 0;
  private nextTroughId = 0;
  // Issue 1: memoize per-cell noise to avoid allocating a fresh makeRng on every call.
  private noiseCache = new Map<number, number>();
  // Issue 2: track the id of the most recently passed trough without a full scan.
  private lastTroughId = -1;

  constructor(private seed: string) {
    this.rng = makeRng(`${seed}:intensity`);
    this.noiseRng = makeRng(`${seed}:intensity-noise`);
  }

  reseed(seed: string): void {
    this.seed = seed;
    this.rng = makeRng(`${seed}:intensity`);
    this.noiseRng = makeRng(`${seed}:intensity-noise`);
    this.troughs = [];
    this.scheduledTo = 0;
    this.nextTroughId = 0;
    this.noiseCache.clear();
    this.lastTroughId = -1;
  }

  setMaxIntensity(v: number): void {
    this.maxIntensity = Math.max(0, Math.min(1, v));
  }

  private cellNoise(cell: number): number {
    const cached = this.noiseCache.get(cell);
    if (cached !== undefined) return cached;
    const val = makeRng(`${this.seed}:n:${cell}`).next();
    this.noiseCache.set(cell, val);
    // Bound the cache: prune entries more than NOISE_CACHE_LOOKBACK behind the current cell.
    if (this.noiseCache.size > NOISE_CACHE_MAX) {
      const cutoff = cell - NOISE_CACHE_LOOKBACK;
      for (const k of this.noiseCache.keys()) {
        if (k < cutoff) this.noiseCache.delete(k);
      }
    }
    return val;
  }

  private noise(t: number): number {
    // noiseRng is held for reseed parity; cellNoise() provides positional determinism.
    void this.noiseRng;
    const cell = Math.floor(t);
    const frac = t - cell;
    const a = this.cellNoise(cell);
    const b = this.cellNoise(cell + 1);
    const s = frac * frac * (3 - 2 * frac);
    return a + (b - a) * s;
  }

  private ensureScheduled(until: number): void {
    while (this.scheduledTo < until + TROUGH_MAX_GAP) {
      const gap = TROUGH_MIN_GAP + this.rng.next() * (TROUGH_MAX_GAP - TROUGH_MIN_GAP);
      const start = this.scheduledTo + gap;
      const id = this.nextTroughId++;
      this.troughs.push({ id, start, end: start + TROUGH_DUR });
      this.scheduledTo = start + TROUGH_DUR;
    }
  }

  sample(logicalTime: number): IntensitySample {
    this.ensureScheduled(logicalTime);

    // Issue 2: prune fully-past troughs from the front and update lastTroughId.
    while (this.troughs.length > 0) {
      const tr = this.troughs[0];
      if (tr.end + TROUGH_RAMP < logicalTime) {
        // This trough is entirely in the past; record it and remove it.
        this.lastTroughId = Math.max(this.lastTroughId, tr.id);
        this.troughs.shift();
      } else {
        break;
      }
    }

    // Scan the (now-pruned) array for an active trough.
    let active: Trough | null = null;
    for (const tr of this.troughs) {
      if (tr.start - TROUGH_RAMP <= logicalTime) {
        this.lastTroughId = Math.max(this.lastTroughId, tr.id);
      }
      if (logicalTime >= tr.start - TROUGH_RAMP && logicalTime <= tr.end + TROUGH_RAMP) {
        active = tr;
        break;
      }
    }

    const fast = this.noise(logicalTime * 1.7);
    const slow = this.noise(logicalTime * 0.35 + 11.3);
    let churn = 0.45 + 0.4 * fast + 0.2 * (slow - 0.5);
    const spike = this.noise(logicalTime * 5.0 + 53.1);
    if (spike > 0.78) churn = Math.min(1, churn + (spike - 0.78) * 3.2);
    churn = Math.max(0, Math.min(1, churn));

    let intensity = churn;
    let regime: IntensityRegime = churn > 0.66 ? 'frenzy' : 'baseline';
    let inTrough = false;

    if (active) {
      const d = troughDepth(logicalTime, active);
      intensity = churn * (1 - d) + 0.08 * d;
      if (d > 0.5) { inTrough = true; regime = 'trough'; }
    }

    intensity = Math.min(intensity, this.maxIntensity);
    return { intensity, regime, inTrough, troughId: active ? active.id : this.lastTroughId };
  }
}

function troughDepth(t: number, tr: Trough): number {
  if (t < tr.start - TROUGH_RAMP || t > tr.end + TROUGH_RAMP) return 0;
  if (t < tr.start) return ease((t - (tr.start - TROUGH_RAMP)) / TROUGH_RAMP);
  if (t > tr.end) return ease((tr.end + TROUGH_RAMP - t) / TROUGH_RAMP);
  return 1;
}
function ease(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
}

export function createIntensityEngine(seed: string, opts?: { maxIntensity?: number }): IntensityEngine {
  const eng = new IntensityEngineImpl(seed);
  if (opts?.maxIntensity != null) eng.setMaxIntensity(opts.maxIntensity);
  return eng;
}
