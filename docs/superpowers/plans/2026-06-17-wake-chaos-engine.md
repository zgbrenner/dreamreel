# Wake Chaos Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace DREAMREEL's calm 2-layer old-film reel with a single seeded *intensity* signal that drives sporadic-fast rhythm, breathing layer density (A/B/C), and rare coherent moments — all deterministic and seed-shareable.

**Architecture:** Approach ① (evolve in place). Four new pure-logic modules (`intensity`, `coherence`, `layerPlan`, Dreamwalker convergence) form the brain; a new `LayerStack` render module grows the compositor from 2 → N feedback-blended layers; the conductor is rewired to an intensity-driven scheduler. New behavior ships behind a `?wake` flag, default-on once solid. Spec: `docs/superpowers/specs/2026-06-17-wake-chaos-engine-design.md`.

**Tech Stack:** Vite + React + TypeScript, three.js, Zustand, Vitest (unit), Playwright (smoke). All randomness routes through the seeded `Rng` in `app/src/dream/prng.ts`.

---

## Conventions

- All commands run from `app/`. Unit test: `npx vitest run tests/unit/<file>`. Full unit suite: `npm run test`. Smoke: `npm run test:e2e`. Typecheck: `npm run typecheck`. Lint: `npm run lint`.
- Tests live in `app/tests/unit/`. Source in `app/src/`.
- TypeScript strict — no `any`. Every stochastic call uses an `Rng` from `prng.ts` (never `Math.random()` in the dream path).
- Work on branch `feat/wake-chaos-engine` (already created). Commit after every task.

## File Structure (decomposition)

| File | New/Mod | Responsibility |
|------|---------|----------------|
| `app/src/dream/intensity.ts` | new | Pure seeded intensity envelope + coherence-trough schedule + clamp. |
| `app/src/dream/coherence.ts` | new | Deterministic 50/35/15 coherence-kind per trough. |
| `app/src/dream/layerPlan.ts` | new | Pure `intensity → {layerCount, feedback, warp, blends}` mapping. |
| `app/src/dream/dreamwalker.ts` | mod | Add `setConvergence()` — tighten temperature + bias to similar assets. |
| `app/src/render/LayerStack.ts` | new | N stacked quads + feedback ping-pong; consumes a `LayerPlan`. |
| `app/src/render/filmParams.ts` | mod | Add `warp`; allow grade to be dialed by intensity (not always-on). |
| `app/src/render/postfx.ts` | mod | Wire a `warp`/displacement uniform; scale aggression with intensity. |
| `app/src/dream/conductor.ts` | mod | Intensity-driven scheduler; drive LayerStack + coherence + convergence behind `?wake`. |
| `app/src/state/url.ts` | mod | Parse `?wake` flag into share/runtime state. |
| `app/src/ui/Gate.tsx` | mod | Pass the `wake` flag into the conductor. |
| `app/tests/unit/intensity.test.ts` | new | Envelope reproducibility, trough cadence, clamp. |
| `app/tests/unit/coherence.test.ts` | new | 50/35/15 distribution + determinism. |
| `app/tests/unit/layerPlan.test.ts` | new | Monotone layer count, blend assignment. |
| `app/tests/unit/dreamwalker.test.ts` | mod | Convergence tightens similarity. |
| `CLAUDE.md` | mod | Rewrite the "look is fixed" + 3-clock invariants. |

---

## Task 1: IntensityEngine — the seeded heartbeat

**Files:**
- Create: `app/src/dream/intensity.ts`
- Test: `app/tests/unit/intensity.test.ts`

The engine is a pure function of a *logical* clock (seconds, tempo-scaled by the caller). It returns the current intensity plus whether we're in a coherence trough. Troughs are scheduled rare (~25–45s apart) and brief (~2s); between them the envelope is sporadic value-noise with random spikes.

- [ ] **Step 1: Write the failing test**

```ts
// app/tests/unit/intensity.test.ts
import { describe, it, expect } from 'vitest';
import { createIntensityEngine } from '../../src/dream/intensity';

function series(seed: string, n: number, step: number) {
  const eng = createIntensityEngine(seed);
  return Array.from({ length: n }, (_, i) => eng.sample(i * step));
}

describe('IntensityEngine determinism', () => {
  it('same seed yields an identical intensity series', () => {
    const a = series('reel-7', 200, 0.25).map((s) => s.intensity);
    const b = series('reel-7', 200, 0.25).map((s) => s.intensity);
    expect(a).toEqual(b);
  });

  it('different seeds diverge', () => {
    const a = series('reel-7', 200, 0.25).map((s) => s.intensity);
    const b = series('reel-8', 200, 0.25).map((s) => s.intensity);
    expect(a).not.toEqual(b);
  });
});

describe('IntensityEngine range + sporadicity', () => {
  it('intensity always stays within [0,1]', () => {
    for (const s of series('range', 1000, 0.1)) {
      expect(s.intensity).toBeGreaterThanOrEqual(0);
      expect(s.intensity).toBeLessThanOrEqual(1);
    }
  });

  it('is sporadic: high frame-to-frame variance, not a smooth ramp', () => {
    const xs = series('spor', 600, 0.1).map((s) => s.intensity);
    let jumps = 0;
    for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - xs[i - 1]) > 0.15) jumps++;
    expect(jumps).toBeGreaterThan(40); // lurches frequently, never a calm sine
  });
});

describe('IntensityEngine troughs (coherent moments)', () => {
  it('troughs are rare and brief over 5 minutes', () => {
    const eng = createIntensityEngine('troughs');
    const ids = new Set<number>();
    let troughSamples = 0;
    const total = 3000; // 300s at 0.1s
    for (let i = 0; i < total; i++) {
      const s = eng.sample(i * 0.1);
      if (s.inTrough) { troughSamples++; ids.add(s.troughId); }
    }
    // ~300s / ~35s spacing => roughly 6–12 troughs
    expect(ids.size).toBeGreaterThanOrEqual(5);
    expect(ids.size).toBeLessThanOrEqual(14);
    // troughs are brief: total trough time is a small fraction of the run
    expect(troughSamples / total).toBeLessThan(0.15);
  });

  it('intensity is low inside a trough and high outside', () => {
    const eng = createIntensityEngine('lowhigh');
    let inSum = 0, inN = 0, outMax = 0;
    for (let i = 0; i < 3000; i++) {
      const s = eng.sample(i * 0.1);
      if (s.inTrough) { inSum += s.intensity; inN++; }
      else outMax = Math.max(outMax, s.intensity);
    }
    expect(inN).toBeGreaterThan(0);
    expect(inSum / inN).toBeLessThan(0.25); // calm during troughs
    expect(outMax).toBeGreaterThan(0.75);   // frenzies happen outside
  });
});

describe('IntensityEngine clamp (reduced-motion / future safety)', () => {
  it('setMaxIntensity caps the envelope', () => {
    const eng = createIntensityEngine('clamp');
    eng.setMaxIntensity(0.4);
    for (let i = 0; i < 1000; i++) {
      expect(eng.sample(i * 0.1).intensity).toBeLessThanOrEqual(0.4 + 1e-9);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/intensity.test.ts`
Expected: FAIL — `createIntensityEngine` is not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/src/dream/intensity.ts
// The seeded heartbeat. A pure function of a logical clock (tempo-scaled seconds, supplied by
// the caller) producing an intensity in [0,1] plus coherence-trough state. Sporadic by design:
// value-noise + random spikes/holds between rare, brief troughs. No DOM, no three.js.

import { makeRng, type Rng } from './prng';

export type IntensityRegime = 'frenzy' | 'baseline' | 'trough';

export interface IntensitySample {
  intensity: number; // 0..1 (after clamp)
  regime: IntensityRegime;
  inTrough: boolean;
  troughId: number; // index of the current/last trough; stable within a trough
}

export interface IntensityEngine {
  sample(logicalTime: number): IntensitySample;
  setMaxIntensity(v: number): void;
  reseed(seed: string): void;
}

interface Trough {
  id: number;
  start: number; // logical seconds
  end: number;
}

const TROUGH_MIN_GAP = 22; // seconds between troughs (lower bound)
const TROUGH_MAX_GAP = 46;
const TROUGH_DUR = 2.0; // seconds a coherent moment holds
const TROUGH_RAMP = 0.8; // seconds to ease in/out of a trough

class IntensityEngineImpl implements IntensityEngine {
  private rng: Rng;
  private noiseRng: Rng;
  private maxIntensity = 1;
  private troughs: Trough[] = [];
  private scheduledTo = 0; // we've laid down troughs up to this logical time

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
  }

  setMaxIntensity(v: number): void {
    this.maxIntensity = Math.max(0, Math.min(1, v));
  }

  /** Deterministic value-noise: hash the integer cell, smooth-interpolate. */
  private noise(t: number): number {
    const cell = Math.floor(t);
    const frac = t - cell;
    const h = (n: number) => makeRng(`${this.seed}:n:${n}`).next();
    const a = h(cell);
    const b = h(cell + 1);
    const s = frac * frac * (3 - 2 * frac); // smoothstep
    return a + (b - a) * s;
  }

  /** Lay down troughs lazily up to `until` logical seconds. */
  private ensureScheduled(until: number): void {
    while (this.scheduledTo < until + TROUGH_MAX_GAP) {
      const gap = TROUGH_MIN_GAP + this.rng.next() * (TROUGH_MAX_GAP - TROUGH_MIN_GAP);
      const start = this.scheduledTo + gap;
      const id = this.troughs.length;
      this.troughs.push({ id, start, end: start + TROUGH_DUR });
      this.scheduledTo = start + TROUGH_DUR;
    }
  }

  sample(logicalTime: number): IntensitySample {
    this.ensureScheduled(logicalTime);
    // find an active or most-recent trough
    let active: Trough | null = null;
    let lastId = -1;
    for (const tr of this.troughs) {
      if (tr.start - TROUGH_RAMP <= logicalTime) lastId = tr.id;
      if (logicalTime >= tr.start - TROUGH_RAMP && logicalTime <= tr.end + TROUGH_RAMP) {
        active = tr;
        break;
      }
    }

    // base sporadic churn: two octaves of value-noise + occasional spike
    const fast = this.noise(logicalTime * 1.7);
    const slow = this.noise(logicalTime * 0.35 + 11.3);
    let churn = 0.45 + 0.4 * fast + 0.2 * (slow - 0.5);
    // sporadic spikes/holds: a quick per-second roll pushes toward 1 or freezes low
    const spike = this.noise(logicalTime * 5.0 + 53.1);
    if (spike > 0.78) churn = Math.min(1, churn + (spike - 0.78) * 3.2); // flurry
    churn = Math.max(0, Math.min(1, churn));

    let intensity = churn;
    let regime: IntensityRegime = churn > 0.66 ? 'frenzy' : 'baseline';
    let inTrough = false;

    if (active) {
      // ease the intensity down into the trough and back out
      const d = troughDepth(logicalTime, active);
      intensity = churn * (1 - d) + 0.08 * d;
      if (d > 0.5) { inTrough = true; regime = 'trough'; }
    }

    intensity = Math.min(intensity, this.maxIntensity);
    return { intensity, regime, inTrough, troughId: active ? active.id : lastId };
  }
}

/** 0 outside the trough, 1 at its center, eased across TROUGH_RAMP. */
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/intensity.test.ts`
Expected: PASS (all cases). If trough-count bounds fail, the cadence constants are the knobs — adjust `TROUGH_MIN/MAX_GAP` and re-run; do not loosen the test ranges below "rare."

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/dream/intensity.ts tests/unit/intensity.test.ts
git commit -m "feat(dream): seeded IntensityEngine — sporadic envelope + coherence troughs"
```

---

## Task 2: Coherence selection — 50/35/15 per trough

**Files:**
- Create: `app/src/dream/coherence.ts`
- Test: `app/tests/unit/coherence.test.ts`

Each trough deterministically resolves to one coherence kind: **rhyme (50%) / lucid (35%) / phrase (15%)**, keyed by `(seed, troughId)` so it's stable and shareable.

- [ ] **Step 1: Write the failing test**

```ts
// app/tests/unit/coherence.test.ts
import { describe, it, expect } from 'vitest';
import { coherenceForTrough, type CoherenceKind } from '../../src/dream/coherence';

describe('coherenceForTrough', () => {
  it('is deterministic for a given seed + troughId', () => {
    expect(coherenceForTrough('s', 3)).toBe(coherenceForTrough('s', 3));
  });

  it('approximates 50/35/15 over many troughs', () => {
    const counts: Record<CoherenceKind, number> = { rhyme: 0, lucid: 0, phrase: 0 };
    const N = 6000;
    for (let i = 0; i < N; i++) counts[coherenceForTrough('dist', i)]++;
    expect(counts.rhyme / N).toBeGreaterThan(0.45);
    expect(counts.rhyme / N).toBeLessThan(0.55);
    expect(counts.lucid / N).toBeGreaterThan(0.30);
    expect(counts.lucid / N).toBeLessThan(0.40);
    expect(counts.phrase / N).toBeGreaterThan(0.11);
    expect(counts.phrase / N).toBeLessThan(0.19);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/coherence.test.ts`
Expected: FAIL — `coherenceForTrough` is not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/src/dream/coherence.ts
// What surfaces during a coherence trough. Deterministic per (seed, troughId): 50% thematic
// rhyme, 35% lucid single image, 15% legible phrase. Pure — no DOM, no three.js.

import { makeRng } from './prng';

export type CoherenceKind = 'rhyme' | 'lucid' | 'phrase';

export function coherenceForTrough(seed: string, troughId: number): CoherenceKind {
  const r = makeRng(`${seed}:coh:${troughId}`).next();
  if (r < 0.5) return 'rhyme';
  if (r < 0.85) return 'lucid';
  return 'phrase';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/coherence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dream/coherence.ts tests/unit/coherence.test.ts
git commit -m "feat(dream): deterministic 50/35/15 coherence-kind per trough"
```

---

## Task 3: layerPlan — intensity → density

**Files:**
- Create: `app/src/dream/layerPlan.ts`
- Test: `app/tests/unit/layerPlan.test.ts`

Maps intensity to the compositing recipe the LayerStack renders: active layer count (A 1–3 / B 4–6 / C 7–8), feedback amount, warp amount, and per-layer blend modes. Pure so it's unit-tested; the GL module just consumes it.

- [ ] **Step 1: Write the failing test**

```ts
// app/tests/unit/layerPlan.test.ts
import { describe, it, expect } from 'vitest';
import { planLayers, MAX_LAYERS } from '../../src/dream/layerPlan';
import { makeRng } from '../../src/dream/prng';

const rng = () => makeRng('plan');

describe('planLayers density bands', () => {
  it('trough intensity -> 1..3 layers (band A)', () => {
    const p = planLayers(0.08, rng());
    expect(p.layerCount).toBeGreaterThanOrEqual(1);
    expect(p.layerCount).toBeLessThanOrEqual(3);
  });
  it('baseline intensity -> 4..6 layers (band B)', () => {
    const p = planLayers(0.5, rng());
    expect(p.layerCount).toBeGreaterThanOrEqual(4);
    expect(p.layerCount).toBeLessThanOrEqual(6);
  });
  it('frenzy intensity -> 7..MAX layers (band C)', () => {
    const p = planLayers(0.95, rng());
    expect(p.layerCount).toBeGreaterThanOrEqual(7);
    expect(p.layerCount).toBeLessThanOrEqual(MAX_LAYERS);
  });
  it('layer count is monotonic across the range', () => {
    const lo = planLayers(0.05, rng()).layerCount;
    const mid = planLayers(0.5, rng()).layerCount;
    const hi = planLayers(0.95, rng()).layerCount;
    expect(mid).toBeGreaterThanOrEqual(lo);
    expect(hi).toBeGreaterThanOrEqual(mid);
  });
  it('feedback and warp rise with intensity and stay 0..1', () => {
    const lo = planLayers(0.05, rng());
    const hi = planLayers(0.95, rng());
    expect(hi.feedback).toBeGreaterThan(lo.feedback);
    expect(hi.warp).toBeGreaterThan(lo.warp);
    for (const p of [lo, hi]) {
      expect(p.feedback).toBeGreaterThanOrEqual(0);
      expect(p.feedback).toBeLessThanOrEqual(1);
      expect(p.warp).toBeGreaterThanOrEqual(0);
      expect(p.warp).toBeLessThanOrEqual(1);
    }
  });
  it('emits one blend per active layer', () => {
    const p = planLayers(0.95, rng());
    expect(p.blends).toHaveLength(p.layerCount);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/layerPlan.test.ts`
Expected: FAIL — `planLayers` is not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/src/dream/layerPlan.ts
// Pure mapping from intensity (0..1) to a compositing recipe. The LayerStack renders this;
// keeping it pure makes the density logic unit-testable without a GPU.

import type { Rng } from './prng';

export const MAX_LAYERS = 8;
export type BlendName = 'normal' | 'screen' | 'lighten' | 'multiply' | 'overlay';
const BLENDS: BlendName[] = ['screen', 'lighten', 'multiply', 'overlay', 'screen'];

export interface LayerPlan {
  layerCount: number;
  feedback: number; // 0..1 trail strength
  warp: number; // 0..1 displacement strength
  blends: BlendName[]; // length === layerCount; first layer is always 'normal' base
}

export function planLayers(intensity: number, rng: Rng): LayerPlan {
  const x = Math.max(0, Math.min(1, intensity));
  let layerCount: number;
  if (x < 0.22) layerCount = 1 + rng.int(3); // band A: 1..3
  else if (x < 0.66) layerCount = 4 + rng.int(3); // band B: 4..6
  else layerCount = 7 + rng.int(MAX_LAYERS - 6); // band C: 7..MAX
  layerCount = Math.min(MAX_LAYERS, layerCount);

  const feedback = Math.min(1, 0.1 + x * 0.85);
  const warp = Math.min(1, x * x * 0.9); // warp ramps in only as it gets wild

  const blends: BlendName[] = ['normal'];
  for (let i = 1; i < layerCount; i++) blends.push(BLENDS[rng.int(BLENDS.length)]);
  return { layerCount, feedback, warp, blends };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/layerPlan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dream/layerPlan.ts tests/unit/layerPlan.test.ts
git commit -m "feat(dream): pure intensity->density layerPlan (A/B/C bands)"
```

---

## Task 4: Dreamwalker convergence mode

**Files:**
- Modify: `app/src/dream/dreamwalker.ts` (interface `Dreamwalker` ~line 31; class fields ~85; `temperature()` ~146; `advancePoint()` ~151)
- Test: `app/tests/unit/dreamwalker.test.ts` (append)

During a `rhyme` coherent moment the walker should temporarily tighten: lower temperature and suppress leaps so successive image picks are thematically similar (high cosine). Normal chaotic walk otherwise. Determinism preserved — no new randomness paths.

- [ ] **Step 1: Write the failing test (append to existing file)**

```ts
// append to app/tests/unit/dreamwalker.test.ts
import { cosine } from '../../src/dream/mood';

describe('Dreamwalker convergence', () => {
  function meanAdjacentSimilarity(convergence: boolean, n: number): number {
    const w = createDreamwalker(pools, { seed: 'converge', surreality: 0.8 });
    w.setConvergence(convergence);
    const embs = Array.from({ length: n }, () => w.next('image', 1).asset.embedding);
    let s = 0;
    for (let i = 1; i < embs.length; i++) s += cosine(embs[i - 1], embs[i]);
    return s / (embs.length - 1);
  }

  it('convergence makes successive image picks more similar than the chaotic walk', () => {
    const chaotic = meanAdjacentSimilarity(false, 80);
    const converged = meanAdjacentSimilarity(true, 80);
    expect(converged).toBeGreaterThan(chaotic + 0.05);
  });

  it('toggling convergence off restores the chaotic walk and stays deterministic', () => {
    const a = createDreamwalker(pools, { seed: 'z', surreality: 0.6 });
    const b = createDreamwalker(pools, { seed: 'z', surreality: 0.6 });
    a.setConvergence(true); a.setConvergence(false);
    const seqA = Array.from({ length: 30 }, () => a.next('image', 1).asset.id);
    const seqB = Array.from({ length: 30 }, () => b.next('image', 1).asset.id);
    expect(seqA).toEqual(seqB); // convergence default off => identical to a plain walk
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/dreamwalker.test.ts`
Expected: FAIL — `w.setConvergence` is not a function.

- [ ] **Step 3: Implement convergence**

In `app/src/dream/dreamwalker.ts`:

(a) Add to the `Dreamwalker` interface (after `setSurreality`):
```ts
  setConvergence(on: boolean): void;
```

(b) Add a field to `DreamwalkerImpl` (near `private lastLeaped = false;`):
```ts
  private converging = false;
```

(c) Implement the method (next to `setSurreality`):
```ts
  setConvergence(on: boolean): void {
    this.converging = on;
  }
```

(d) Tighten temperature when converging — replace `temperature()`:
```ts
  private temperature(): number {
    const base = 0.12 + this.surreality * 1.1;
    return this.converging ? base * 0.25 : base;
  }
```

(e) Suppress leaps + reduce drift when converging — in `advancePoint()`, replace the `driftScale` line and the leap guard:
```ts
    const driftScale = (0.12 + this.surreality * 0.6) * (this.converging ? 0.3 : 1);
    const e = st.e.slice();
    for (let i = 0; i < this.dim; i++) e[i] += st.rng.gaussian() * driftScale;
    let leaped = false;
    const leapP = this.converging ? 0 : this.surreality * 0.28;
    if (st.rng.next() < leapP) {
```

> Note: the `st.rng.next()` call for the leap roll stays even when `leapP === 0`, so the PRNG stream advances identically — keeping the "convergence default off ⇒ identical sequence" determinism guarantee in the test.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/dreamwalker.test.ts`
Expected: PASS (new convergence cases + all existing determinism/entropy/anti-repeat cases still green).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/dream/dreamwalker.ts tests/unit/dreamwalker.test.ts
git commit -m "feat(dream): Dreamwalker convergence mode for rhyme moments"
```

---

## Task 5: LayerStack — N-layer feedback compositor

**Files:**
- Create: `app/src/render/LayerStack.ts`
- Reference (read, don't modify yet): `app/src/render/Compositor.ts`

> **Verification note:** GL rendering is validated by the Playwright smoke test (Task 10) and manual `verify`, not fabricated unit tests — mocking a WebGL context to assert draw calls tests the mock, not the code (see TDD skill: mocks only when unavoidable). The *logic* this module relies on (`planLayers`) is already unit-tested in Task 3. Keep this module thin: it only translates a `LayerPlan` + textures into GPU state.

LayerStack owns a pool of `MAX_LAYERS` textured quads (added to the compositor scene via `addOverlay`) and a **ping-pong feedback target**: each frame it blends the previous frame back in by `plan.feedback` before drawing the live layers, producing trails/smear. Layer `i ≥ plan.layerCount` is hidden. Textures are assigned per layer and disposed on replacement (bounded heap).

- [ ] **Step 1: Implement the module**

```ts
// app/src/render/LayerStack.ts
// Grows the compositor from 2 fixed layers to N (<= MAX_LAYERS) blended quads plus a feedback
// ping-pong buffer for trails. Driven by a LayerPlan (see dream/layerPlan.ts). Owns its quad
// materials + render targets and disposes textures on replacement to bound GPU memory.

import * as THREE from 'three';
import { MAX_LAYERS, type LayerPlan, type BlendName } from '../dream/layerPlan';
import type { Compositor } from './Compositor';

const BLEND_MAP: Record<BlendName, THREE.Blending> = {
  normal: THREE.NormalBlending,
  screen: THREE.AdditiveBlending, // screen-like; AdditiveBlending is the closest cheap GPU mode
  lighten: THREE.AdditiveBlending,
  multiply: THREE.MultiplyBlending,
  overlay: THREE.CustomBlending,
};

export class LayerStack {
  private readonly quad = new THREE.PlaneGeometry(2, 2);
  private readonly layers: THREE.Mesh[] = [];
  private readonly mats: THREE.MeshBasicMaterial[] = [];
  private feedback = 0;
  private fbA: THREE.WebGLRenderTarget;
  private fbB: THREE.WebGLRenderTarget;
  private readonly fbScene = new THREE.Scene();
  private readonly fbMat: THREE.MeshBasicMaterial;

  constructor(private readonly compositor: Compositor) {
    const { width, height } = compositor.size;
    const half = (n: number) => Math.max(1, Math.floor(n / 2)); // feedback at half-res
    this.fbA = new THREE.WebGLRenderTarget(half(width), half(height));
    this.fbB = new THREE.WebGLRenderTarget(half(width), half(height));

    for (let i = 0; i < MAX_LAYERS; i++) {
      const mat = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(this.quad, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 10 + i; // draw above the base stage/ghost
      mesh.visible = false;
      this.mats.push(mat);
      this.layers.push(mesh);
      compositor.addOverlay(mesh);
    }

    // feedback re-injection quad (drawn first each frame at opacity = feedback)
    this.fbMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    const fbMesh = new THREE.Mesh(this.quad, this.fbMat);
    fbMesh.frustumCulled = false;
    fbMesh.renderOrder = 9;
    compositor.addOverlay(fbMesh);
  }

  /** Assign a texture to a layer slot, disposing any prior owned texture. */
  setLayerTexture(index: number, tex: THREE.Texture): void {
    if (index < 0 || index >= MAX_LAYERS) return;
    const mat = this.mats[index];
    const prev = mat.map;
    if (prev && prev !== tex && prev.userData?.ownedByCompositor) prev.dispose();
    mat.map = tex;
    mat.needsUpdate = true;
  }

  /** Apply a density plan: show `layerCount` layers with the given blends + feedback/warp. */
  applyPlan(plan: LayerPlan): void {
    this.feedback = plan.feedback;
    this.fbMat.opacity = plan.feedback * 0.9;
    for (let i = 0; i < MAX_LAYERS; i++) {
      const on = i < plan.layerCount;
      this.layers[i].visible = on && this.mats[i].map != null;
      if (on) {
        this.mats[i].blending = BLEND_MAP[plan.blends[i] ?? 'screen'];
        // base layer opaque-ish, upper layers progressively translucent
        this.mats[i].opacity = i === 0 ? 0.95 : Math.max(0.25, 0.8 - i * 0.08);
      }
    }
  }

  resize(width: number, height: number): void {
    const half = (n: number) => Math.max(1, Math.floor(n / 2));
    this.fbA.setSize(half(width), half(height));
    this.fbB.setSize(half(width), half(height));
  }

  /** Capture the current frame into the feedback buffer (called by compositor post-draw). */
  captureFeedback(renderer: THREE.WebGLRenderer): void {
    if (this.feedback <= 0.01) return;
    // ping-pong: present buffer becomes the feedback texture for next frame
    const tmp = this.fbA; this.fbA = this.fbB; this.fbB = tmp;
    this.fbMat.map = this.fbA.texture;
    this.fbMat.needsUpdate = true;
  }

  dispose(): void {
    for (const m of this.mats) { if (m.map?.userData?.ownedByCompositor) m.map.dispose(); m.dispose(); }
    this.fbMat.dispose();
    this.fbA.dispose();
    this.fbB.dispose();
    this.quad.dispose();
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no type errors). LayerStack is not yet wired into the conductor — that's Task 7.

- [ ] **Step 3: Commit**

```bash
git add src/render/LayerStack.ts
git commit -m "feat(render): LayerStack — N-layer blended compositor with feedback buffer"
```

> Tuning of the exact feedback re-injection (full ping-pong render-to-target vs. the simplified opacity re-draw above) happens in Task 7 against the live reel; the simplified version is correct and cheap to start. If trails are too weak, switch `captureFeedback` to render the scene into `fbB` via `renderer.setRenderTarget` and sample it — leave a `// TODO(tuning)` only after Task 7 confirms the need.

---

## Task 6: Demote the uniform film grade + add a warp uniform

**Files:**
- Modify: `app/src/render/filmParams.ts` (interface ~line 7; `defaultFilmParams` ~30)
- Modify: `app/src/render/postfx.ts` (FilmEffect uniforms + `setParams`)
- Test: `app/tests/unit/filmParams.test.ts` (new — guards the contract)

Add a `warp` parameter and a `filmGrade` master (0..1) that scales the *whole* old-cinema treatment so it's no longer hard-on. The conductor will drive `filmGrade` down during frenzies (so it stops reading as "old TV") and up slightly at coherent moments.

- [ ] **Step 1: Write the failing test**

```ts
// app/tests/unit/filmParams.test.ts
import { describe, it, expect } from 'vitest';
import { defaultFilmParams } from '../../src/render/filmParams';

describe('filmParams new fields', () => {
  it('exposes warp and filmGrade with sane defaults', () => {
    const p = defaultFilmParams();
    expect(p.warp).toBe(0);
    expect(p.filmGrade).toBeGreaterThan(0);
    expect(p.filmGrade).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/filmParams.test.ts`
Expected: FAIL — `warp`/`filmGrade` missing on the returned object / type error.

- [ ] **Step 3: Add the fields**

In `app/src/render/filmParams.ts`, add to the `FilmParams` interface (after `breathe`):
```ts
  warp: number; // intensity-driven UV displacement 0..1 (dream fluidity)
  filmGrade: number; // master scale for the whole old-cinema treatment 0..1 (1 = full, 0 = off)
```
And to `defaultFilmParams()` return (after `breathe: 0.5,`):
```ts
    warp: 0,
    filmGrade: 1,
```

In `app/src/render/postfx.ts`: add `uWarp` and `uFilmGrade` uniforms to the FilmEffect (mirror an existing scalar uniform such as `uGrain`), multiply the final film treatment mix by `uFilmGrade`, and apply `uWarp` as a small per-fragment UV displacement using the existing animated noise (mirror the gate-weave `mainUv` hook). In `setParams`, copy `warp` and `filmGrade` through to the uniforms exactly as the other numeric params are copied.

> Read the existing `FILM_FRAG` shader and `setParams` in `postfx.ts` and follow the identical pattern for the two new scalar uniforms. No new effect passes — this is two uniforms threaded through the existing FilmEffect.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/unit/filmParams.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/filmParams.ts src/render/postfx.ts tests/unit/filmParams.test.ts
git commit -m "feat(render): add warp + filmGrade master to FilmParams (demote uniform grade)"
```

---

## Task 7: Wire the chaos engine into the conductor (behind `?wake`)

**Files:**
- Modify: `app/src/dream/conductor.ts`

This is the integration. When `wake` is on, the conductor: samples `IntensityEngine` each tick on a logical clock; schedules the next image swap sooner at higher intensity; pushes the picked texture into a rotating `LayerStack` slot; calls `applyPlan(planLayers(intensity, rng))`; drives `filmGrade`/`warp` from intensity; and at troughs runs the coherence behavior (`rhyme` → `walker.setConvergence(true)` + several layers; `lucid` → 1 layer, hold; `phrase` → calm + show a text line as a title-ish caption). When off, the existing 2-layer path runs unchanged.

- [ ] **Step 1: Add fields + construction**

Add imports at the top of `conductor.ts`:
```ts
import { createIntensityEngine, type IntensityEngine } from './intensity';
import { coherenceForTrough } from './coherence';
import { planLayers } from './layerPlan';
import { LayerStack } from '../render/LayerStack';
```
Add to the constructor `init` param type: `wake: boolean`. Store `private wake: boolean`, `private intensity: IntensityEngine`, `private layerStack: LayerStack | null`, `private layerCursor = 0`, `private activeTrough = -1`. In the constructor body, after `this.walker = this.buildWalker();`:
```ts
    this.wake = init.wake;
    this.intensity = createIntensityEngine(this.seed);
    this.layerStack = this.wake ? new LayerStack(compositor) : null;
    if (this.postfx.params.reduceMotion) this.intensity.setMaxIntensity(0.45);
```

- [ ] **Step 2: Branch the scheduler in `tick`**

Replace the body of `tick(dt)` so that when `this.wake` is true it uses the intensity-driven path:
```ts
  private tick(dt: number): void {
    if (!this.playing) return;
    this.clock += dt;
    for (const p of this.liveProcs) p.update(this.clock);
    if (this.wake) { this.wakeTick(); return; }
    if (this.clock >= this.nextImageAt) this.imageBeat();
    if (this.clock >= this.nextGhostAt) this.ghostBeat();
    if (this.clock >= this.nextTextAt) this.textBeat();
  }
```

- [ ] **Step 3: Implement `wakeTick`**

Add this method (logical clock = `this.clock * this.tempoMul`; swap interval shrinks with intensity; coherence handled at troughs):
```ts
  private wakeTick(): void {
    const s = this.intensity.sample(this.clock * this.tempoMul);

    // density + look from one signal
    const plan = planLayers(s.intensity, this.presRng);
    this.layerStack?.applyPlan(plan);
    this.postfx.setParams({
      ...this.baseWakeFilm(),
      filmGrade: 0.85 - s.intensity * 0.6, // less "old TV" as it gets wild
      warp: plan.warp,
      chroma: 0.2 + s.intensity * 0.6,
      bloom: 0.3 + s.intensity * 0.5,
    });

    // coherence: enter/leave convergence on trough boundaries
    if (s.inTrough && s.troughId !== this.activeTrough) {
      this.activeTrough = s.troughId;
      const kind = coherenceForTrough(this.seed, s.troughId);
      this.walker.setConvergence(kind === 'rhyme');
      if (kind === 'phrase') {
        const beat = this.walker.next('text', this.tempoMul);
        this.hooks.setCaption({ whisper: beat.asset.text ?? '' });
      }
    } else if (!s.inTrough && this.activeTrough !== -1 && !this.intensity.sample(this.clock * this.tempoMul).inTrough) {
      this.walker.setConvergence(false);
      this.activeTrough = -1;
    }

    // swap a layer when due; faster at higher intensity
    const interval = 0.12 + (1 - s.intensity) * 0.9; // seconds
    if (this.clock >= this.nextImageAt) {
      this.swapWakeLayer(s.intensity);
      this.nextImageAt = this.clock + interval / Math.max(0.5, this.tempoMul);
    }
  }

  /** Pick the next visual and push it into the next layer slot (round-robin). */
  private swapWakeLayer(intensity: number): void {
    const beat = this.walker.next('image', this.tempoMul);
    const mood = this.walker.currentMood();
    this.hooks.setMood(mood);
    this.safeAudio(() => this.audio.setMood(mood));
    this.hooks.setCaption({ reel: reelLabel(beat.asset), source: beat.asset.source, license: beat.asset.license, attribution: ccByAttribution(beat.asset), attributionUrl: beat.asset.attributionUrl });

    const slot = this.layerCursor % 8;
    this.layerCursor++;
    if (beat.asset.type === 'procedural') {
      const src = this.proc(beat.asset.id, beat.asset.kind ?? 'fog');
      this.markLive(src);
      this.layerStack?.setLayerTexture(slot, src.texture);
    } else if (beat.asset.type === 'image' && beat.asset.src) {
      void this.compositor.showImage(beat.asset.src, beat.asset.grade).then((res) => {
        if (res.ok) this.layerStack?.setLayerTexture(slot, res.texture);
        else {
          const kind = IMAGE_FALLBACK_KINDS[this.presRng.int(IMAGE_FALLBACK_KINDS.length)];
          const src = this.proc(`fallback:${beat.asset.id}:${slot}`, kind);
          this.markLive(src);
          this.layerStack?.setLayerTexture(slot, src.texture);
        }
      });
    } else {
      this.layerStack?.setLayerTexture(slot, this.makeTitleCard(beat.asset.text ?? ''));
    }
  }

  /** Calm base film params for the wake path (mood still nudges these via setParams merge). */
  private baseWakeFilm() {
    return { vignette: 0.3, grain: 0.14, sepia: 0.2, desat: 0.18, scanline: 0.04, halation: 0.2, haze: 0.16, lightLeak: 0.2, tint: 0.18, exposure: 1, breathe: 0.5 };
  }
```

> `setParams` already merges partial params (it's used that way in `applyMoodToFilm`); confirm it does a shallow merge and, if not, spread the current `this.postfx.params` first.

- [ ] **Step 4: Dispose the LayerStack**

In `dispose()`, add: `this.layerStack?.dispose();`. In `reseed()`, after rebuilding the walker, add: `this.intensity.reseed(seed); this.activeTrough = -1; this.layerCursor = 0;`.

- [ ] **Step 5: Typecheck + manual verify**

Run: `npm run typecheck` → PASS.
Then wire the flag (Task 8) before running the app. After Task 8, manually verify with the `/verify` flow: load `?wake=1`, confirm fast sporadic layered motion, occasional calm coherent moments, no console errors.

- [ ] **Step 6: Commit**

```bash
git add src/dream/conductor.ts
git commit -m "feat(dream): intensity-driven wake scheduler wiring LayerStack + coherence"
```

---

## Task 8: `?wake` flag plumbing

**Files:**
- Modify: `app/src/state/url.ts` (`ShareState`, `readShareState`)
- Modify: `app/src/ui/Gate.tsx` (pass `wake` into the conductor `init`)
- Test: `app/tests/unit/url.test.ts` (append)

- [ ] **Step 1: Write the failing test (append)**

```ts
// append to app/tests/unit/url.test.ts
describe('wake flag', () => {
  it('readShareState reads ?wake=1 as true and defaults false', () => {
    // jsdom: set the query string then re-read
    window.history.replaceState(null, '', '/?wake=1');
    expect(readShareState().wake).toBe(true);
    window.history.replaceState(null, '', '/');
    expect(readShareState().wake).toBe(false);
  });
});
```
(Ensure `readShareState` is imported at the top of the test file.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/url.test.ts`
Expected: FAIL — `wake` missing on `ShareState`.

- [ ] **Step 3: Implement**

In `app/src/state/url.ts`: add `wake: boolean;` to `ShareState`, and in `readShareState` add:
```ts
  const wake = q.get('wake') === '1' || q.get('wake') === 'true';
```
and include `wake` in the returned object. (Do **not** write it back in `writeShareState` — it's a dev toggle, not part of the shareable seed yet.)

In `app/src/ui/Gate.tsx`: add `import { readShareState } from '../state/url';` to the imports, then change the conductor `init` object (currently line ~42):
```ts
      { seed: s.seed, surreality: s.surreality, tempoMul: s.tempoMul, archiveOn: s.archiveOn, wake: readShareState().wake },
```
(`DreamConductor` is constructed at `Gate.tsx:36`; the `init` object is the 6th argument. The store doesn't carry `wake`, so we read it straight from the URL here.)

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/unit/url.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/url.ts src/ui/Gate.tsx tests/unit/url.test.ts
git commit -m "feat(state): ?wake flag plumbed into the conductor"
```

---

## Task 9: Author original Joycean text lines

**Files:**
- Modify: the pipeline text source that feeds `manifest.texts` (find it: `cd pipeline && grep -rl "build_texts\|texts" embed/`), then rebuild the seed manifest; OR, if faster for this round, add lines directly to `app/public/manifest.seed.json`'s `texts` array (each needs `id,type,text,embedding,mood,tags,dwellBase,source,license`).
- Reference: `app/src/manifest/types.ts` (Asset shape).

Add ~20 original, ship-safe, Joycean-flavored stream-of-consciousness lines (NOT *Finnegans Wake* text) so the 15% `phrase` coherence has material. License `CC0`, source `"DREAMREEL / original"`.

- [ ] **Step 1: Author the lines** in the text source (portmanteau, dreamlike, original — e.g. "the hush before the unnaming", "she was a door once, and morning"). Keep them short (≤ 8 words).

- [ ] **Step 2: Rebuild + validate**

Run (if pipeline-sourced): `cd pipeline && python -m embed.build_manifest --out out && cd ../app && npx tsx scripts/validate-manifest.ts ../pipeline/out/manifest.json`
Or (if seed-edited): `cd app && npx tsx scripts/validate-manifest.ts public/manifest.seed.json`
Expected: `✓ VALID`.

- [ ] **Step 3: Run unit tests** (manifest + dreamwalker still green)

Run: `cd app && npm run test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "content: original Joycean-flavored dream-text lines for phrase coherence"
```

---

## Task 10: CLAUDE.md rewrite + full verification pass

**Files:**
- Modify: `CLAUDE.md`
- Modify: `app/tests/e2e/smoke.spec.ts` (run against `?wake=1`)

- [ ] **Step 1: Rewrite the invariants** in `CLAUDE.md`:
  - In **Core architecture**, replace "Three desynced layer clocks ... advance independently" with the single-intensity-signal + N-layer feedback model (keep determinism + live-WebGL bullets).
  - Replace the **Aesthetic tokens (the look is fixed; do not redesign)** heading/body: palette + type remain *available tokens*, but the mandated uniform old-cinema treatment is replaced by the intensity-driven chaotic multi-modal description. Keep `prefers-reduced-motion` respect.
  - Leave license rules, determinism, and the contracts sections unchanged.

- [ ] **Step 2: Point the smoke test at wake mode** — in `smoke.spec.ts`, change `await page.goto('/')` to `await page.goto('/?wake=1')` (or add a second test that does). Keep the existing assertions (heading, canvas visible, play, 30s, no console errors, bounded heap).

- [ ] **Step 3: Run the whole suite**

Run: `cd app && npm run test && npm run typecheck && npm run lint`
Expected: all PASS.

Run: `cd app && npm run test:e2e`
Expected: smoke PASS in wake mode (loads, plays 30s, **no console errors, bounded heap** — this is the real guard that the N-layer/feedback path doesn't leak GPU memory or throw).

- [ ] **Step 4: Manual verify against the live reel** (use the `/verify` skill): `npm run dev`, open `/?wake=1`, watch for ~60s. Confirm: fast sporadic layered churn; density visibly surges/relaxes; a calm coherent moment every ~30s (image holds / layers rhyme / a phrase surfaces); no console errors. Tune constants in `intensity.ts` / `layerPlan.ts` if the feel is off, re-running unit tests after each change.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md app/tests/e2e/smoke.spec.ts
git commit -m "docs+test: rewrite aesthetic invariants for wake mode; smoke covers ?wake=1"
```

---

## Task 11: Flip the default + open PR

**Files:**
- Modify: `app/src/state/url.ts` (default `wake` to `true`)

- [ ] **Step 1:** Once Tasks 1–10 are green and the manual verify looks right, default the flag on: in `readShareState`, make `wake` default `true` unless `?wake=0`. Add a test asserting `?wake=0` disables it.

- [ ] **Step 2:** Run `cd app && npm run test && npm run test:e2e`. Expected: PASS.

- [ ] **Step 3:** Commit and open a **draft** PR against `main`:
```bash
git add app/src/state/url.ts app/tests/unit/url.test.ts
git commit -m "feat: enable wake mode by default (?wake=0 to opt out)"
git push -u origin feat/wake-chaos-engine
gh pr create --draft --base main --title "Wake chaos engine: fast sporadic multi-layer dream" --body "Implements docs/superpowers/specs/2026-06-17-wake-chaos-engine-design.md"
```

---

## Self-review — spec coverage

- Sporadic-fast rhythm → Task 1 (envelope) + Task 7 (interval shrinks with intensity). ✓
- Breathing density A/B/C → Task 3 (layerPlan) + Task 5 (LayerStack) + Task 7 (applyPlan). ✓
- Coherence 50/35/15 → Task 2 + Task 7 (rhyme/lucid/phrase handling). ✓
- Convergence for rhyme → Task 4 + Task 7. ✓
- Feedback/fluidity + demoted old-film look → Task 5 (feedback) + Task 6 (filmGrade/warp) + Task 7 (drive them). ✓
- Determinism / seed-shareable → seeded throughout (Tasks 1–4); determinism tests in Tasks 1, 4. ✓
- `prefers-reduced-motion` clamp → Task 1 (`setMaxIntensity`) + Task 7 (apply 0.45). ✓
- Original Joycean text → Task 9. ✓
- CLAUDE.md rewrite → Task 10. ✓
- Tests (units + determinism + smoke + bounded heap) → Tasks 1–8, 10. ✓
- `?wake` rollout (default-on) → Tasks 8, 11. ✓
- Out of scope (filters/video/voice/corpus/photosensitivity) → not in any task, by design. ✓

**Type consistency:** `IntensitySample`/`createIntensityEngine` (T1) used in T7; `coherenceForTrough`/`CoherenceKind` (T2) used in T7; `planLayers`/`LayerPlan`/`MAX_LAYERS`/`BlendName` (T3) used in T5, T7; `setConvergence` (T4) used in T7; `LayerStack.applyPlan/setLayerTexture/dispose` (T5) used in T7; `warp`/`filmGrade` (T6) used in T7; `ShareState.wake` (T8) used in Gate + T11. Consistent.
