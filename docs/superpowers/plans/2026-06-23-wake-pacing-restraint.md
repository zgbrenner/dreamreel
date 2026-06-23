# Wake-mode Pacing + Restraint — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tune wake-mode (`?wake=1`) so it keeps its chaos but gains contrast — calmer/clearer lingering moments (especially to watch film clips) and less over-distortion of imagery — via constant + small-helper changes.

**Architecture:** Five focused changes: (1) coherence troughs more frequent + longer (`intensity.ts`); (2) gentler filter strength + a distortion cap helper (`filterDirector.ts`); (3) a video selection weight in the dreamwalker softmax (`dreamwalker.ts`); (4) a pure round-robin slot picker that skips "held" video slots (`slotHold.ts`); (5) conductor + compositor wiring (slower/widened swap cadence, trough hold, video-linger, distortion cap, warp coefficient, video-pool cap). Tasks 1–4 are pure and TDD'd; Task 5 is integration verified by typecheck/lint/full-suite + manual preview (the conductor is not unit-harnessed in this codebase).

**Tech Stack:** TypeScript (three.js, vitest). All changes in `app/src/dream/` + one line in `app/src/render/Compositor.ts`.

## Global Constraints

- **Determinism preserved** — every change is a constant or a deterministic scalar; no new `Math.random`/wall-clock and no new RNG draws in the dream path. Same seed → same (new) script. (spec)
- TypeScript strict; **no `any`** in committed code; ESLint + Prettier clean. (CLAUDE.md)
- Existing tests that assert a changed constant are **updated to the new value** — that is expected, not a regression. (spec)
- Exact tuned values (verbatim from the spec):
  - Swap interval: `(0.4 + (1 - intensity) * 1.6) / max(0.5, tempoMul)`; **× 2.0 when `inTrough`**.
  - Troughs: `TROUGH_MIN_GAP 14`, `TROUGH_MAX_GAP 30`, `TROUGH_DUR 4.0`, `TROUGH_RAMP 1.0`.
  - Video: `TYPE_WEIGHTS.video = 3.5`; `VIDEO_HOLD = 5.0` (**8.0 in a trough**); VideoPool `cap = 3`.
  - Distortion: filter scale `(0.18 + 0.5 * intensity)`; `TROUGH_EASE 0.08`; cap `kaleidoscope ≤ 0.5`, `liquid ≤ 0.7`; warp coefficient `intensity*intensity*0.5`.
- Wake-mode focused; video weight + pool cap also affect classic (intended). Muted video unchanged.

---

## Task 1: Troughs more frequent + longer

**Files:**
- Modify: `app/src/dream/intensity.ts` (the four `TROUGH_*` constants, currently lines 30–33)
- Test: `app/tests/unit/intensity.test.ts` (the "troughs are rare and brief" test)

**Interfaces:**
- Consumes: nothing.
- Produces: no API change — only the seeded trough schedule's frequency/duration change.

- [ ] **Step 1: Update the trough test to the new cadence (write the new expectation first)**

Replace the test block currently titled `'troughs are rare and brief over 5 minutes'` in `app/tests/unit/intensity.test.ts` (lines ~40–52) with:

```typescript
  it('troughs are regular and lingering over 5 minutes (more frequent + longer than before)', () => {
    const eng = createIntensityEngine('troughs');
    const ids = new Set<number>();
    let troughSamples = 0;
    const total = 3000; // 300 logical seconds at 0.1s step
    for (let i = 0; i < total; i++) {
      const s = eng.sample(i * 0.1);
      if (s.inTrough) { troughSamples++; ids.add(s.troughId); }
    }
    // gaps 14..30s + 4s duration => ~9-16 troughs over 300s (was 5-14, rarer + briefer)
    expect(ids.size).toBeGreaterThanOrEqual(8);
    expect(ids.size).toBeLessThanOrEqual(20);
    // lucid time is now a meaningful slice (was <0.15), but still not dominating
    expect(troughSamples / total).toBeGreaterThan(0.1);
    expect(troughSamples / total).toBeLessThan(0.3);
  });
```

- [ ] **Step 2: Run it to verify it fails against the current constants**

Run: `cd app && npx vitest run tests/unit/intensity.test.ts -t "regular and lingering"`
Expected: FAIL — with the current `TROUGH_MIN_GAP=22 / DUR=2.0`, `troughSamples/total` is < 0.1 (so `toBeGreaterThan(0.1)` fails).

- [ ] **Step 3: Update the four constants**

In `app/src/dream/intensity.ts`, change the constants block (currently lines 30–33):

```typescript
const TROUGH_MIN_GAP = 14;
const TROUGH_MAX_GAP = 30;
const TROUGH_DUR = 4.0;
const TROUGH_RAMP = 1.0;
```

- [ ] **Step 4: Run the full intensity suite**

Run: `cd app && npx vitest run tests/unit/intensity.test.ts`
Expected: PASS (the new trough test + the unchanged determinism/range/sporadicity/low-high/clamp tests — the low-in-trough/high-outside test still holds because trough depth math is unchanged).

- [ ] **Step 5: Commit**

```bash
git add app/src/dream/intensity.ts app/tests/unit/intensity.test.ts
git commit -m "feat(dream): more frequent + longer coherence troughs"
```

---

## Task 2: Distortion restraint + cap helper

**Files:**
- Modify: `app/src/dream/filterDirector.ts` (`TROUGH_EASE` line 29; `scale` line 43; add `capDistortion`)
- Test: `app/tests/unit/filterDirector.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `capDistortion(fs: FilterStrengths): FilterStrengths` — returns a copy with `kaleidoscope ≤ 0.5` and `liquid ≤ 0.7`, other fields unchanged. Lower overall `filterStrengths` magnitude.

- [ ] **Step 1: Write the failing tests**

Append to `app/tests/unit/filterDirector.test.ts` (add the `capDistortion` import to the existing import line: `import { filterStrengths, MOOD_FILTER, capDistortion, type FilterStrengths } from '../../src/dream/filterDirector';`):

```typescript
describe('FilterDirector restraint', () => {
  it('peak strength is held back (no full-strength obliteration at intensity 1)', () => {
    // ominous -> kaleidoscope; a fully-dominant axis at intensity 1 used to reach ~1.0.
    const s = filterStrengths(moodPeaking('ominous', 1, 0.1), 1, false);
    expect(s.kaleidoscope).toBeLessThan(0.7);
  });

  it('capDistortion clamps the two geometry-manglers, leaving others untouched', () => {
    const capped = capDistortion({
      kaleidoscope: 0.9, liquid: 0.95, solarize: 0.6, melt: 0.4, posterize: 0.3, feedback: 0.8,
    });
    expect(capped.kaleidoscope).toBe(0.5);
    expect(capped.liquid).toBe(0.7);
    expect(capped.solarize).toBe(0.6);
    expect(capped.feedback).toBe(0.8);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app && npx vitest run tests/unit/filterDirector.test.ts -t "restraint"`
Expected: FAIL — `capDistortion` is not exported (import error), and with the current `scale=(0.35+0.65*i)` the peak kaleidoscope is ~0.98 (not `< 0.7`).

- [ ] **Step 3: Apply the restraint changes**

In `app/src/dream/filterDirector.ts`:

Change `TROUGH_EASE` (line 29):
```typescript
const TROUGH_EASE = 0.08; // strengths scale by this inside a coherence trough (lucid = near-clean)
```

Change the `scale` line (line 43) inside `filterStrengths`:
```typescript
  const scale = (0.18 + 0.5 * clamp01(intensity)) * (inTrough ? TROUGH_EASE : 1);
```

Add `capDistortion` at the end of the file:
```typescript
/** Cap the two geometry-mangling filters so the underlying image is never fully obliterated —
 *  some clarity keeps a dream feeling real. Other filters pass through unchanged. */
export function capDistortion(fs: FilterStrengths): FilterStrengths {
  return { ...fs, kaleidoscope: Math.min(fs.kaleidoscope, 0.5), liquid: Math.min(fs.liquid, 0.7) };
}
```

- [ ] **Step 4: Run the full filterDirector suite**

Run: `cd app && npx vitest run tests/unit/filterDirector.test.ts`
Expected: PASS — the new restraint tests plus the existing mapping/intensity-scales-up/trough-ease/bounds/determinism tests (all relative or bound assertions that still hold under the lower scale).

- [ ] **Step 5: Commit**

```bash
git add app/src/dream/filterDirector.ts app/tests/unit/filterDirector.test.ts
git commit -m "feat(dream): gentler filter scale + cap kaleidoscope/liquid distortion"
```

---

## Task 3: Video selection weight

**Files:**
- Modify: `app/src/dream/dreamwalker.ts` (add `TYPE_WEIGHTS` near line 39; multiply in `pick()` lines 186–190)
- Test: `app/tests/unit/videoWeight.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: no API change — `pick()` now multiplies each candidate's softmax weight by `TYPE_WEIGHTS[type] ?? 1`. Video share of selections rises.

- [ ] **Step 1: Write the failing test**

Create `app/tests/unit/videoWeight.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createDreamwalker, type DreamwalkerPools } from '../../src/dream/dreamwalker';
import { MOOD_AXES, type Asset, type MoodAxis } from '../../src/manifest/types';

// All assets share one embedding so cosine is equal for every candidate — the ONLY selection
// bias left is the type weight. Without weighting, a 50/50 video/image pool picks ~50% video.
function asset(id: string, type: Asset['type']): Asset {
  return {
    id,
    type,
    src: 'x',
    embedding: [1, 0, 0, 0],
    mood: Object.fromEntries(MOOD_AXES.map((a) => [a, 0])) as Record<MoodAxis, number>,
    tags: [],
    dwellBase: 6,
    source: 's',
    license: 'PD',
  };
}

function videoFraction(seedStr: string): number {
  const visual: Asset[] = [];
  for (let i = 0; i < 10; i++) {
    visual.push(asset(`img-${i}`, 'image'));
    visual.push(asset(`vid-${i}`, 'video'));
  }
  const pools: DreamwalkerPools = {
    visual,
    texts: [],
    moodAxes: Object.fromEntries(MOOD_AXES.map((a) => [a, [0, 0, 0, 0]])) as Record<MoodAxis, number[]>,
    embeddingDim: 4,
  };
  const w = createDreamwalker(pools, { seed: seedStr, surreality: 0.4 });
  let vids = 0;
  const N = 600;
  for (let i = 0; i < N; i++) if (w.next('image', 1).asset.type === 'video') vids++;
  return vids / N;
}

describe('Dreamwalker video weighting', () => {
  it('lifts scarce video well above its raw 50% share when embeddings are equal', () => {
    const f = videoFraction('vidw');
    expect(f).toBeGreaterThan(0.6); // 3.5x weight pushes well past the unweighted 0.5
    expect(f).toBeLessThan(0.95); // still selects images too
  });

  it('is deterministic across fresh instances', () => {
    expect(videoFraction('same')).toBe(videoFraction('same'));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app && npx vitest run tests/unit/videoWeight.test.ts`
Expected: FAIL — with no type weighting, `videoFraction` ≈ 0.5, so `toBeGreaterThan(0.6)` fails.

- [ ] **Step 3: Add the weight constant and apply it in `pick()`**

In `app/src/dream/dreamwalker.ts`, add after `const RECENT_WINDOW = 6;` (line 39):

```typescript
// Bias selection toward scarce moving-image so video reads as a real part of the reel, not a
// rarity. Multiplicative on the pre-softmax weight (deterministic — no extra RNG draw).
const TYPE_WEIGHTS: Record<string, number> = { video: 3.5 };
```

Replace the `weights` mapping inside `pick()` (lines 186–190):

```typescript
    const weights = scores.map((s, i) => {
      const w = Math.exp(s - max) * (TYPE_WEIGHTS[candidates[i].type] ?? 1);
      sum += w;
      return w;
    });
```

- [ ] **Step 4: Run the new test + the existing dreamwalker suite (no regressions)**

Run: `cd app && npx vitest run tests/unit/videoWeight.test.ts tests/unit/dreamwalker.test.ts`
Expected: PASS — video weighting test passes; the existing determinism/entropy/anti-repeat/convergence tests still pass (the seed manifest has 1 video among ~26 assets, so the weight barely perturbs those aggregate-entropy assertions; anti-repeat and determinism are unaffected by a positive scalar weight).

- [ ] **Step 5: Commit**

```bash
git add app/src/dream/dreamwalker.ts app/tests/unit/videoWeight.test.ts
git commit -m "feat(dream): weight video selection up (3.5x) so clips appear more often"
```

---

## Task 4: Slot-hold helper

**Files:**
- Create: `app/src/dream/slotHold.ts`
- Test: `app/tests/unit/slotHold.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `pickSwapSlot(cursor: number, heldUntil: number[], clock: number, maxLayers: number): { slot: number; nextCursor: number }` — round-robin from `cursor`, skipping any slot whose `heldUntil[slot] > clock`; if every slot is held, returns the cursor slot (never deadlocks). `nextCursor` is what the caller stores back.

- [ ] **Step 1: Write the failing test**

Create `app/tests/unit/slotHold.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { pickSwapSlot } from '../../src/dream/slotHold';

describe('pickSwapSlot', () => {
  it('round-robins when nothing is held', () => {
    const held = [0, 0, 0, 0];
    const a = pickSwapSlot(0, held, 5, 4);
    expect(a).toEqual({ slot: 0, nextCursor: 1 });
    const b = pickSwapSlot(a.nextCursor, held, 5, 4);
    expect(b).toEqual({ slot: 1, nextCursor: 2 });
  });

  it('skips a slot whose hold has not expired', () => {
    const held = [10, 0, 0, 0]; // slot 0 held until t=10
    const r = pickSwapSlot(0, held, 5, 4); // clock 5 < 10 -> skip 0
    expect(r.slot).toBe(1);
    expect(r.nextCursor).toBe(2);
  });

  it('does not skip a slot whose hold has expired', () => {
    const held = [3, 0, 0, 0]; // expired at t=3
    const r = pickSwapSlot(0, held, 5, 4); // clock 5 > 3 -> slot 0 usable
    expect(r.slot).toBe(0);
  });

  it('never deadlocks: if every slot is held, returns the cursor slot', () => {
    const held = [100, 100, 100, 100];
    const r = pickSwapSlot(2, held, 5, 4);
    expect(r.slot).toBe(2);
    expect(r.nextCursor).toBe(3);
  });

  it('wraps around the ring', () => {
    const held = [0, 0, 0, 0];
    const r = pickSwapSlot(3, held, 5, 4);
    expect(r.slot).toBe(3);
    const next = pickSwapSlot(r.nextCursor, held, 5, 4);
    expect(next.slot).toBe(0); // 4 % 4
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app && npx vitest run tests/unit/slotHold.test.ts`
Expected: FAIL — cannot find module `../../src/dream/slotHold`.

- [ ] **Step 3: Write the helper**

Create `app/src/dream/slotHold.ts`:

```typescript
// app/src/dream/slotHold.ts
// Round-robin layer-slot picker that respects per-slot "holds" so a video clip (or any content
// we want watched) isn't overwritten before its hold expires. Pure + deterministic; the caller
// owns the cursor and the heldUntil array (in logical-clock seconds).

export function pickSwapSlot(
  cursor: number,
  heldUntil: number[],
  clock: number,
  maxLayers: number,
): { slot: number; nextCursor: number } {
  for (let i = 0; i < maxLayers; i++) {
    const slot = (cursor + i) % maxLayers;
    if (!(heldUntil[slot] > clock)) {
      return { slot, nextCursor: cursor + i + 1 };
    }
  }
  // Every slot is held — fall back to the cursor slot so we never stall.
  return { slot: cursor % maxLayers, nextCursor: cursor + 1 };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd app && npx vitest run tests/unit/slotHold.test.ts`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add app/src/dream/slotHold.ts app/tests/unit/slotHold.test.ts
git commit -m "feat(dream): pickSwapSlot — round-robin that skips held layer slots"
```

---

## Task 5: Conductor + Compositor integration

**Files:**
- Modify: `app/src/dream/conductor.ts` (imports; new `slotHeldUntil` field; `wakeTick` swap-cadence + trough hold + `capDistortion` + warp; `swapWakeLayer` slot pick + video hold; reset)
- Modify: `app/src/render/Compositor.ts` (VideoPool `cap: 2` → `3`, line 42)

**Interfaces:**
- Consumes: `capDistortion` (Task 2), `pickSwapSlot` (Task 4). Existing: `filterStrengths`, `MAX_LAYERS`, `this.intensity.sample`, `this.layerCursor`, `this.clock`, `this.tempoMul`, `stack.setLayerTexture`.
- Produces: no new exports — behavioral wiring only.

This file is not unit-harnessed (it wires three.js + audio + DOM). Verified by typecheck + lint + the full vitest suite (no regressions) + manual `?wake=1` preview. Apply edits at the quoted anchors (read the current file first; line numbers may have shifted slightly).

- [ ] **Step 1: Extend the imports**

In `app/src/dream/conductor.ts`:
- Add to the `filterDirector` import (it currently imports `filterStrengths`): `import { filterStrengths, capDistortion } from './filterDirector';` (preserve any other names already imported from that module).
- Add a new import: `import { pickSwapSlot } from './slotHold';`

- [ ] **Step 2: Add the per-slot hold field + reset it**

Near the existing fields (`private layerCursor = 0;` etc., ~line 51), add:

```typescript
  private slotHeldUntil: number[] = new Array(MAX_LAYERS).fill(0);
```

In the reset method, next to `this.layerCursor = 0;` (~line 156), add:

```typescript
    this.slotHeldUntil.fill(0);
```

- [ ] **Step 3: Soften the film warp + cap the distortion filters in `wakeTick`**

Change the `warp` line (currently `warp: Math.min(1, intensity * intensity * 0.9),`):

```typescript
      warp: Math.min(1, intensity * intensity * 0.5),
```

Change the filter-strength application block (currently):
```typescript
    if (this.lastWakeMood) {
      const fs = filterStrengths(this.lastWakeMood, s.intensity, s.inTrough);
      this.postfx.setFilterStrengths(fs);
      stack.setFeedback(fs.feedback);
    }
```
to:
```typescript
    if (this.lastWakeMood) {
      const fs = filterStrengths(this.lastWakeMood, s.intensity, s.inTrough);
      this.postfx.setFilterStrengths(capDistortion(fs));
      stack.setFeedback(fs.feedback);
    }
```

- [ ] **Step 4: Slow + widen the swap cadence, with a trough hold**

Change the swap block (currently):
```typescript
    if (this.clock >= this.nextSwapAt) {
      this.swapWakeLayer();
      const interval = (0.12 + (1 - intensity) * 0.9) / Math.max(0.5, this.tempoMul);
      this.nextSwapAt = this.clock + interval;
    }
```
to:
```typescript
    if (this.clock >= this.nextSwapAt) {
      this.swapWakeLayer();
      // Breathing room: slower baseline + a wider range so calm stretches actually linger; a
      // lucid trough holds even longer so the clear image can be taken in.
      let interval = (0.4 + (1 - intensity) * 1.6) / Math.max(0.5, this.tempoMul);
      if (s.inTrough) interval *= 2.0;
      this.nextSwapAt = this.clock + interval;
    }
```

- [ ] **Step 5: Use `pickSwapSlot` and hold a video slot in `swapWakeLayer`**

In `swapWakeLayer()`, the slot is currently chosen by `const slot = this.layerCursor++ % MAX_LAYERS;`. The method already samples intensity near its top (`const intensity = this.intensity.sample(this.clock * this.tempoMul).intensity;`). Change that sample line to keep the whole sample so we know if we're in a trough:

```typescript
    const sample = this.intensity.sample(this.clock * this.tempoMul);
    const intensity = sample.intensity;
```
(Update the `planLayers(intensity, this.presRng)` call below it to keep using `intensity` — unchanged.)

Replace the slot line:
```typescript
    const { slot, nextCursor } = pickSwapSlot(
      this.layerCursor,
      this.slotHeldUntil,
      this.clock,
      MAX_LAYERS,
    );
    this.layerCursor = nextCursor;
```

In the **video branch** of `swapWakeLayer` (the `else if (asset.type === 'video' && asset.src)` block added in Round 4), on the success path — right after `stack.setLayerTexture(slot, res.texture);` — add the hold so the clip can play:

```typescript
          this.slotHeldUntil[slot] = this.clock + (sample.inTrough ? 8.0 : 5.0);
```

(Do not set a hold on the procedural-fallback path or for non-video assets — only a successfully-bound video clip is held.)

- [ ] **Step 6: Bump the concurrent-video cap**

In `app/src/render/Compositor.ts` line 42:
```typescript
  private videoPool = new VideoPool({ cap: 3 });
```

- [ ] **Step 7: Typecheck, lint, full suite**

Run: `cd app && npm run typecheck && npm run lint && npx vitest run`
Expected: PASS — no type/lint errors (no `any`); all unit tests green including the Task 1–4 tests and the existing suite. (The compositor video test is unaffected by the cap value.)

- [ ] **Step 8: Commit**

```bash
git add app/src/dream/conductor.ts app/src/render/Compositor.ts
git commit -m "feat(dream): wake pacing — slower cadence, trough holds, video linger, distortion cap"
```

---

## Task 6: Manual preview verification

**Files:** none (verification only).

- [ ] **Step 1: Build with the live manifest and preview**

Run:
```bash
cd app
VITE_MANIFEST_URL="https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json" npm run build
# kill any process on 4173 first (Windows PowerShell):
#   Get-NetTCPConnection -LocalPort 4173 -ErrorAction SilentlyContinue | %{ Stop-Process -Id $_.OwningProcess -Force }
npm run preview -- --port 4173 --strictPort
# open http://localhost:4173/?wake=1
```

- [ ] **Step 2: Confirm the four intended changes are visible**

Watch `?wake=1` for ~1–2 minutes and confirm: (a) there are calm/clear stretches, not a constant strobe of cuts; (b) film clips appear noticeably more often and **linger long enough to watch** (especially during a lucid moment); (c) fewer frames are fully obliterated by kaleidoscope/liquid — most imagery reads clearly; (d) the chaotic character is still present at peaks. Note anything that still feels off for a follow-up tuning pass.

- [ ] **Step 3: Run the e2e smoke (stale-server gotcha)**

Run: `cd app && npm run test:e2e` (kill any process on port 4173 first; a real run rebuilds, ~60s).
Expected: PASS — `?wake=1` still renders.

---

## Self-Review

**Spec coverage:**
- Lever 1 (cadence slow/widen + trough hold) → Task 5 Steps 4. ✓
- Lever 2 (troughs more frequent + longer) → Task 1. ✓
- Lever 3 (video weight) → Task 3; (video linger) → Task 4 helper + Task 5 Step 5; (cap 2→3) → Task 5 Step 6. ✓
- Lever 4 (filter scale + TROUGH_EASE) → Task 2; (kaleidoscope/liquid cap) → Task 2 `capDistortion` + Task 5 Step 3; (warp coefficient) → Task 5 Step 3. ✓
- Determinism preserved (no new RNG draws; `TYPE_WEIGHTS` multiply, clock-driven holds, constant changes) → Tasks 3/4/5. ✓
- Tests: intensity, filterDirector, dreamwalker-video, slotHold updated/added → Tasks 1–4; integration via typecheck/suite/manual → Tasks 5–6. ✓

**Placeholder scan:** none — every code step has complete code; the only "note anything off" is in the manual-verify task, which is intentional human observation, not an implementation placeholder.

**Type consistency:** `capDistortion(fs: FilterStrengths): FilterStrengths` (Task 2) is imported and called in Task 5 with the `FilterStrengths` returned by `filterStrengths` — consistent. `pickSwapSlot(cursor, heldUntil, clock, maxLayers) → { slot, nextCursor }` (Task 4) is consumed in Task 5 with `this.layerCursor`, `this.slotHeldUntil`, `this.clock`, `MAX_LAYERS`, and its `{ slot, nextCursor }` destructured exactly. `TYPE_WEIGHTS` (Task 3) is module-private; no cross-task signature. `slotHeldUntil` is `number[]` of length `MAX_LAYERS`, indexed by `slot` — consistent across Task 5 steps.
