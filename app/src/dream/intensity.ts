// app/src/dream/intensity.ts
// The seeded heartbeat. A pure function of a logical clock (tempo-scaled seconds, supplied by the
// caller) producing an intensity in [0,1] plus coherence-trough state. No DOM, no three.js.
//
// 2026 direction (CLAUDE.md "Content & aesthetic direction"): coherence-realism is the BASELINE and
// dissolution the departure. So the resting state is a LOW, gently-varying intensity (the lucid,
// near-realistic look — light filters, slow layer swaps, no Butterchurn), and the rare events are
// ESCALATION SURGES: occasional sustained peaks (wake-intensity peaks / nightmare arcs) that rise
// out of the calm baseline and relax back. Troughs are kept as even-deeper coherence moments (the
// baseline is already coherent, so a trough is a maximally-lucid "the dream makes sense" beat). This
// inverts the old high-baseline-with-rare-troughs heartbeat; same mechanism, the defaults flip.

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

interface Span {
  id: number;
  start: number;
  end: number;
}

// All *_GAP / *_DUR / *_RAMP constants are in logicalTime (tempo-scaled) seconds.

// Troughs: rare, brief DEEP-coherence convergence moments. Scheduling is UNCHANGED from the prior
// heartbeat (same `:intensity` rng draw order) so the trough schedule stays seed-stable.
const TROUGH_MIN_GAP = 14;
const TROUGH_MAX_GAP = 30;
const TROUGH_DUR = 4.0;
const TROUGH_RAMP = 1.0;

// Surges: occasional sustained ESCALATION peaks rising out of the coherent baseline and relaxing
// back — rarer and longer than troughs, so chaos reads as a deliberate departure, not the default.
const SURGE_MIN_GAP = 20;
const SURGE_MAX_GAP = 46;
const SURGE_DUR = 7.0;
const SURGE_RAMP = 2.5;
const SURGE_PEAK = 0.96; // intensity at a surge's plateau

// Coherent resting baseline: low and gently varying (the lucid, near-realistic default).
const BASE_CENTER = 0.16;
const TROUGH_FLOOR = 0.06; // intensity at the core of a deep-coherence trough

const NOISE_CACHE_MAX = 256;
const NOISE_CACHE_LOOKBACK = 64;

class IntensityEngineImpl implements IntensityEngine {
  private rng: Rng;
  // Dedicated stream for surge scheduling so it's independent of (and never perturbs) the trough
  // schedule — the trough sequence stays bit-identical to the pre-surge heartbeat.
  private surgeRng: Rng;
  // Kept for reseed parity — cellNoise() derives per-cell rngs for positional determinism instead.
  private noiseRng: Rng;
  private maxIntensity = 1;
  private troughs: Span[] = [];
  private scheduledTo = 0;
  private nextTroughId = 0;
  private surges: Span[] = [];
  private surgeScheduledTo = 0;
  private nextSurgeId = 0;
  // Issue 1: memoize per-cell noise to avoid allocating a fresh makeRng on every call.
  private noiseCache = new Map<number, number>();
  // Issue 2: track the id of the most recently passed trough without a full scan.
  private lastTroughId = -1;

  constructor(private seed: string) {
    this.rng = makeRng(`${seed}:intensity`);
    this.surgeRng = makeRng(`${seed}:intensity-surge`);
    this.noiseRng = makeRng(`${seed}:intensity-noise`);
  }

  reseed(seed: string): void {
    this.seed = seed;
    this.rng = makeRng(`${seed}:intensity`);
    this.surgeRng = makeRng(`${seed}:intensity-surge`);
    this.noiseRng = makeRng(`${seed}:intensity-noise`);
    this.troughs = [];
    this.scheduledTo = 0;
    this.nextTroughId = 0;
    this.surges = [];
    this.surgeScheduledTo = 0;
    this.nextSurgeId = 0;
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

  private ensureSurgesScheduled(until: number): void {
    while (this.surgeScheduledTo < until + SURGE_MAX_GAP) {
      const gap = SURGE_MIN_GAP + this.surgeRng.next() * (SURGE_MAX_GAP - SURGE_MIN_GAP);
      const start = this.surgeScheduledTo + gap;
      const id = this.nextSurgeId++;
      this.surges.push({ id, start, end: start + SURGE_DUR });
      this.surgeScheduledTo = start + SURGE_DUR;
    }
  }

  /** Prune fully-past surges and return the active one (or null). Surges carry no exposed id, so
   *  unlike troughs there is no lastId to track. */
  private activeSurge(logicalTime: number): Span | null {
    while (this.surges.length > 0 && this.surges[0].end + SURGE_RAMP < logicalTime) this.surges.shift();
    for (const sg of this.surges) {
      if (logicalTime >= sg.start - SURGE_RAMP && logicalTime <= sg.end + SURGE_RAMP) return sg;
    }
    return null;
  }

  sample(logicalTime: number): IntensitySample {
    this.ensureScheduled(logicalTime);
    this.ensureSurgesScheduled(logicalTime);

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
    let active: Span | null = null;
    for (const tr of this.troughs) {
      if (tr.start - TROUGH_RAMP <= logicalTime) {
        this.lastTroughId = Math.max(this.lastTroughId, tr.id);
      }
      if (logicalTime >= tr.start - TROUGH_RAMP && logicalTime <= tr.end + TROUGH_RAMP) {
        active = tr;
        break;
      }
    }

    // Coherent resting baseline: low, gently varying — no big random swings, so the default look is
    // lucid and near-realistic. (Two slow noise octaves; sporadicity now comes from surges, not churn.)
    const slow = this.noise(logicalTime * 0.35 + 11.3);
    const fast = this.noise(logicalTime * 0.9 + 4.2);
    const base = Math.max(0, Math.min(1, BASE_CENTER + 0.1 * (slow - 0.5) + 0.06 * (fast - 0.5)));

    let intensity = base;
    let regime: IntensityRegime = 'baseline';
    let inTrough = false;

    // Escalation surge: rise out of the calm baseline toward the peak, then relax back.
    const surge = this.activeSurge(logicalTime);
    if (surge) {
      const d = spanDepth(logicalTime, surge, SURGE_RAMP);
      intensity = base * (1 - d) + SURGE_PEAK * d;
      if (d > 0.5) regime = 'frenzy';
    }

    // Deep-coherence trough WINS (pulls toward lucid even mid-surge — coherence beats chaos).
    if (active) {
      const d = spanDepth(logicalTime, active, TROUGH_RAMP);
      intensity = intensity * (1 - d) + TROUGH_FLOOR * d;
      if (d > 0.5) { inTrough = true; regime = 'trough'; }
    }

    intensity = Math.min(intensity, this.maxIntensity);
    return { intensity, regime, inTrough, troughId: active ? active.id : this.lastTroughId };
  }
}

/** Depth (0..1) of a span at time t, with a raised-cosine `ramp` ease on each side; 1 on the plateau. */
function spanDepth(t: number, span: Span, ramp: number): number {
  if (t < span.start - ramp || t > span.end + ramp) return 0;
  if (t < span.start) return ease((t - (span.start - ramp)) / ramp);
  if (t > span.end) return ease((span.end + ramp - t) / ramp);
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
