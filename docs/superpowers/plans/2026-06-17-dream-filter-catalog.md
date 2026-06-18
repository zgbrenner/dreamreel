# Dream-Filter Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single uniform film grade with a 6-filter catalog whose active filter follows the image's mood, scaled by the round-1 intensity heartbeat and eased off at coherence troughs.

**Architecture:** A pure seeded `FilterDirector` maps mood + intensity + trough → a strength per filter (soft-weighted by the dominant mood axis, so mood drift = crossfade). A `DreamFilter` postprocessing effect implements the 5 fragment filters (kaleidoscope, liquid, solarize, melt, posterize) by strength uniform; the 6th (feedback echo-trails) completes the round-1 LayerStack render-to-target. Everything is default-0 (identity) so the classic/non-wake reel is unchanged. Spec: `docs/superpowers/specs/2026-06-17-dream-filter-catalog-design.md`.

**Tech Stack:** Vite + React + TypeScript, three.js 0.169, the `postprocessing` library (EffectComposer/Effect), Vitest, Playwright. All randomness/seeded signals come from round 1 (no new randomness here — the director is a pure function of already-deterministic inputs).

---

## Conventions

- All commands from `app/`. Unit test: `npx vitest run tests/unit/<file>`. Full unit suite: `npm run test`. Smoke: `npm run test:e2e`. Typecheck: `npm run typecheck`. Lint: `npm run lint`.
- Branch `feat/dream-filters` (already created, stacked on `feat/wake-chaos-engine`). Commit after every task. TS strict, no `any`.
- Mood axis order (from `app/src/manifest/types.ts`): `melancholy, uncanny, nostalgic, ominous, tender, mechanical`.

## File Structure

| File | New/Mod | Responsibility |
|------|---------|----------------|
| `app/src/dream/filterDirector.ts` | new | Pure mood+intensity+trough → per-filter strengths. |
| `app/src/render/DreamFilter.ts` | new | postprocessing Effect: 5 fragment filters by strength uniform. |
| `app/src/render/postfx.ts` | mod | Add DreamFilter to the chain; `setFilterStrengths()`. |
| `app/src/render/LayerStack.ts` | mod | Complete feedback render-to-target; `setFeedback()`. |
| `app/src/dream/conductor.ts` | mod | Drive FilterDirector each wake frame → postfx + layerstack. |
| `app/tests/unit/filterDirector.test.ts` | new | Director behaviour + determinism. |
| `app/tests/unit/dreamFilter.test.ts` | new | Effect uniform defaults + setStrengths. |
| `CLAUDE.md` | mod | Note the mood-mapped filter catalog. |

---

## Task 1: FilterDirector — the pure brain

**Files:**
- Create: `app/src/dream/filterDirector.ts`
- Test: `app/tests/unit/filterDirector.test.ts`

A pure function of (mood, intensity, inTrough). Each mood axis maps 1:1 to a filter; strengths are a **sharpened, normalized weighting** of the mood axes (so the dominant axis's filter dominates, and as mood drifts the weights crossfade smoothly — no temporal state needed). Intensity scales the strengths; troughs ease them toward ~0.

- [ ] **Step 1: Write the failing test**

```ts
// app/tests/unit/filterDirector.test.ts
import { describe, it, expect } from 'vitest';
import { filterStrengths, MOOD_FILTER, type FilterStrengths } from '../../src/dream/filterDirector';
import { MOOD_AXES, type MoodAxis } from '../../src/manifest/types';

function moodPeaking(axis: MoodAxis, peak = 0.9, base = 0.4): Record<MoodAxis, number> {
  const m = {} as Record<MoodAxis, number>;
  for (const a of MOOD_AXES) m[a] = a === axis ? peak : base;
  return m;
}
const FILTERS: (keyof FilterStrengths)[] = ['kaleidoscope', 'liquid', 'solarize', 'melt', 'posterize', 'feedback'];
const argmaxFilter = (s: FilterStrengths) =>
  FILTERS.reduce((best, f) => (s[f] > s[best] ? f : best), FILTERS[0]);

describe('FilterDirector mapping', () => {
  it('every mood axis, when dominant, makes its mapped filter the strongest', () => {
    for (const axis of MOOD_AXES) {
      const s = filterStrengths(moodPeaking(axis), 1, false);
      expect(argmaxFilter(s)).toBe(MOOD_FILTER[axis]);
    }
  });

  it('all six filters are reachable across the mood space', () => {
    const reached = new Set(MOOD_AXES.map((a) => argmaxFilter(filterStrengths(moodPeaking(a), 1, false))));
    expect(reached.size).toBe(6);
  });
});

describe('FilterDirector intensity + trough', () => {
  it('intensity scales strength up', () => {
    const lo = filterStrengths(moodPeaking('ominous'), 0.15, false);
    const hi = filterStrengths(moodPeaking('ominous'), 0.95, false);
    expect(hi.kaleidoscope).toBeGreaterThan(lo.kaleidoscope);
  });

  it('troughs ease all strengths toward ~0 (clean coherent image)', () => {
    const open = filterStrengths(moodPeaking('uncanny'), 0.9, false);
    const trough = filterStrengths(moodPeaking('uncanny'), 0.9, true);
    expect(trough.solarize).toBeLessThan(open.solarize * 0.4);
    for (const f of FILTERS) expect(trough[f]).toBeLessThan(0.25);
  });
});

describe('FilterDirector bounds + determinism', () => {
  it('all strengths stay within [0,1]', () => {
    for (const axis of MOOD_AXES) {
      const s = filterStrengths(moodPeaking(axis, 1, 0.8), 1, false);
      for (const f of FILTERS) {
        expect(s[f]).toBeGreaterThanOrEqual(0);
        expect(s[f]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is a pure deterministic function of its inputs', () => {
    const m = moodPeaking('tender');
    expect(filterStrengths(m, 0.6, false)).toEqual(filterStrengths(m, 0.6, false));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/filterDirector.test.ts`
Expected: FAIL — `filterStrengths` / `MOOD_FILTER` not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/src/dream/filterDirector.ts
// Pure, seeded-input brain for the dream-filter catalog. Maps the current mood (6 CLIP axes)
// to a strength for each of the 6 filters: the dominant axis's filter dominates (sharpened
// weighting → a smooth crossfade as mood drifts), intensity scales the strengths, and coherence
// troughs ease them toward 0 so the lucid image reads clean. No DOM, no three.js, no randomness
// of its own — a pure function of the already-deterministic mood/intensity/trough.

import { MOOD_AXES, type MoodAxis } from '../manifest/types';

export interface FilterStrengths {
  kaleidoscope: number;
  liquid: number;
  solarize: number;
  melt: number;
  posterize: number;
  feedback: number;
}

/** 1:1 mood-axis → filter mapping (confirmed in the spec). */
export const MOOD_FILTER: Record<MoodAxis, keyof FilterStrengths> = {
  melancholy: 'feedback',
  uncanny: 'solarize',
  nostalgic: 'liquid',
  ominous: 'kaleidoscope',
  tender: 'melt',
  mechanical: 'posterize',
};

const SHARPEN = 4; // higher => the dominant axis's filter stands out more
const TROUGH_EASE = 0.12; // strengths scale by this inside a coherence trough

function zero(): FilterStrengths {
  return { kaleidoscope: 0, liquid: 0, solarize: 0, melt: 0, posterize: 0, feedback: 0 };
}
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function filterStrengths(
  mood: Record<MoodAxis, number>,
  intensity: number,
  inTrough: boolean,
): FilterStrengths {
  // sharpen + normalize the mood axes into weights that sum to 1
  const pow = MOOD_AXES.map((a) => Math.pow(Math.max(0, mood[a]), SHARPEN));
  const sum = pow.reduce((s, x) => s + x, 0) || 1;
  const scale = (0.35 + 0.65 * clamp01(intensity)) * (inTrough ? TROUGH_EASE : 1);

  const out = zero();
  MOOD_AXES.forEach((axis, i) => {
    const w = pow[i] / sum;
    const filter = MOOD_FILTER[axis];
    out[filter] = clamp01(out[filter] + w * scale);
  });
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/filterDirector.test.ts`
Expected: PASS (all cases). If the "trough < 0.25" bound is tight, lower `TROUGH_EASE` — do NOT weaken the test.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/dream/filterDirector.ts tests/unit/filterDirector.test.ts
git commit -m "feat(dream): pure FilterDirector — mood->filter strengths"
```

---

## Task 2: DreamFilter effect — the 5 fragment filters

**Files:**
- Create: `app/src/render/DreamFilter.ts`
- Test: `app/tests/unit/dreamFilter.test.ts`

A `postprocessing` `Effect` whose shader implements kaleidoscope + liquid (UV remaps in `mainUv`) and solarize + melt + posterize (colour ops in `mainImage`), each gated by a strength uniform. All strengths 0 → exact passthrough. The `Effect` constructor is GL-free (it just stores the shader + uniforms), so the uniform defaults/setter are unit-testable in jsdom.

- [ ] **Step 1: Write the failing test**

```ts
// app/tests/unit/dreamFilter.test.ts
import { describe, it, expect } from 'vitest';
import { DreamFilter } from '../../src/render/DreamFilter';

const U = ['uKaleido', 'uLiquid', 'uSolarize', 'uMelt', 'uPosterize'];

describe('DreamFilter', () => {
  it('defaults every filter strength to 0 (identity passthrough)', () => {
    const fx = new DreamFilter();
    for (const u of U) expect((fx.uniforms.get(u) as { value: number }).value).toBe(0);
  });

  it('setStrengths writes the five fragment-filter uniforms', () => {
    const fx = new DreamFilter();
    fx.setStrengths({ kaleidoscope: 0.1, liquid: 0.2, solarize: 0.3, melt: 0.4, posterize: 0.5, feedback: 0.9 });
    expect((fx.uniforms.get('uKaleido') as { value: number }).value).toBeCloseTo(0.1);
    expect((fx.uniforms.get('uLiquid') as { value: number }).value).toBeCloseTo(0.2);
    expect((fx.uniforms.get('uSolarize') as { value: number }).value).toBeCloseTo(0.3);
    expect((fx.uniforms.get('uMelt') as { value: number }).value).toBeCloseTo(0.4);
    expect((fx.uniforms.get('uPosterize') as { value: number }).value).toBeCloseTo(0.5);
    // feedback is NOT a DreamFilter uniform (it's the LayerStack RT) — must be ignored here
    expect(fx.uniforms.has('uFeedback')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/dreamFilter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// app/src/render/DreamFilter.ts
// The dream-filter catalog as one postprocessing Effect: five fragment filters, each gated by a
// strength uniform (0 = passthrough). kaleidoscope + liquid remap UV (mainUv); solarize + melt +
// posterize are colour ops (mainImage). The 6th filter (feedback echo-trails) is stateful and
// lives in the LayerStack render-to-target, not here. Strengths come from dream/filterDirector.

import * as THREE from 'three';
import { Effect } from 'postprocessing';
import type { FilterStrengths } from '../dream/filterDirector';

const DREAM_FILTER_FRAG = /* glsl */ `
uniform float uTime;
uniform float uKaleido;
uniform float uLiquid;
uniform float uSolarize;
uniform float uMelt;
uniform float uPosterize;

const vec3 LUMA = vec3(0.299, 0.587, 0.114);

void mainUv(inout vec2 uv) {
  // liquid warp: flowing UV displacement (0 at uLiquid 0)
  vec2 w = vec2(sin(uv.y * 8.0 + uTime * 0.6), cos(uv.x * 9.0 + uTime * 0.5));
  uv += w * uLiquid * 0.03;

  // kaleidoscope: fold uv into a mirrored wedge around centre (blended in by strength)
  vec2 c = uv - 0.5;
  float ang = atan(c.y, c.x);
  float r = length(c);
  float seg = 3.14159265 / 3.0;            // 6-fold symmetry
  float folded = abs(mod(ang, seg * 2.0) - seg);
  vec2 k = 0.5 + vec2(cos(folded), sin(folded)) * r;
  uv = mix(uv, k, uKaleido);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 col = inputColor.rgb;

  // solarize / x-ray: invert the highlights (tonal inversion)
  vec3 solar = mix(col, 1.0 - col, step(0.5, col));
  col = mix(col, solar, uSolarize);

  // posterize: quantise into flat bands
  float levels = 5.0;
  vec3 post = floor(col * levels) / levels;
  col = mix(col, post, uPosterize);

  // melt / bloom-bleed: boost saturation + warm bleed in the highlights
  float l = dot(col, LUMA);
  vec3 melted = clamp(l + (col - l) * 1.8, 0.0, 1.0);
  melted += vec3(0.08, 0.05, 0.0) * smoothstep(0.5, 1.0, l);
  col = mix(col, melted, uMelt);

  outputColor = vec4(clamp(col, 0.0, 1.0), inputColor.a);
}
`;

export class DreamFilter extends Effect {
  constructor() {
    super('DreamFilter', DREAM_FILTER_FRAG, {
      uniforms: new Map<string, THREE.Uniform>([
        ['uTime', new THREE.Uniform(0)],
        ['uKaleido', new THREE.Uniform(0)],
        ['uLiquid', new THREE.Uniform(0)],
        ['uSolarize', new THREE.Uniform(0)],
        ['uMelt', new THREE.Uniform(0)],
        ['uPosterize', new THREE.Uniform(0)],
      ]),
    });
  }

  setTime(t: number): void {
    (this.uniforms.get('uTime') as THREE.Uniform).value = t;
  }

  /** Drive the five fragment-filter strengths. `feedback` is intentionally ignored (LayerStack). */
  setStrengths(s: FilterStrengths): void {
    (this.uniforms.get('uKaleido') as THREE.Uniform).value = s.kaleidoscope;
    (this.uniforms.get('uLiquid') as THREE.Uniform).value = s.liquid;
    (this.uniforms.get('uSolarize') as THREE.Uniform).value = s.solarize;
    (this.uniforms.get('uMelt') as THREE.Uniform).value = s.melt;
    (this.uniforms.get('uPosterize') as THREE.Uniform).value = s.posterize;
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/unit/dreamFilter.test.ts && npm run typecheck`
Expected: PASS. (If `new DreamFilter()` throws in jsdom because `Effect` needs a GL context — it should not, the constructor only stores data — fall back to testing a tiny pure helper that builds the uniform map, and report it. GLSL itself is validated by the smoke test later.)

- [ ] **Step 5: Commit**

```bash
git add src/render/DreamFilter.ts tests/unit/dreamFilter.test.ts
git commit -m "feat(render): DreamFilter effect — 5 fragment filters by strength (identity at 0)"
```

---

## Task 3: Wire DreamFilter into the post-FX chain

**Files:**
- Modify: `app/src/render/postfx.ts`

Add the DreamFilter effect to the composer (in the film EffectPass, BEFORE the FilmEffect so the catalog transforms the image and the grade is the unifying floor), drive its `uTime`, and expose `setFilterStrengths`. Default-0 keeps the classic look identical.

- [ ] **Step 1: Add the effect**

In `postfx.ts`:
- Import: `import { DreamFilter } from './DreamFilter';` and `import type { FilterStrengths } from '../dream/filterDirector';`.
- Add a field next to `private readonly effect = new FilmEffect();`:
```ts
  private readonly dreamFilter = new DreamFilter();
```
- In the constructor, change the film EffectPass so DreamFilter runs first:
```ts
    this.composer.addPass(new EffectPass(compositor.camera, this.dreamFilter, this.effect, this.bloom));
```
(DreamFilter and FilmEffect both define `mainUv`; postprocessing composes them into the single shared-UV sample — DreamFilter's kaleidoscope/liquid remap then FilmEffect's weave, one sample, then each `mainImage` in order. This is fine; chroma stays its own pass as today.)
- In `update(dt, elapsed)`, after `this.effect.setTime(elapsed);` add:
```ts
    this.dreamFilter.setTime(elapsed);
```

- [ ] **Step 2: Add `setFilterStrengths`**

Add a public method (near `setParams`):
```ts
  /** Drive the dream-filter catalog (the 5 fragment filters). feedback is handled by LayerStack. */
  setFilterStrengths(s: FilterStrengths): void {
    this.dreamFilter.setStrengths(s);
  }
```

- [ ] **Step 3: Typecheck + lint + unit**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all clean; existing unit tests still pass (PostFX isn't unit-tested directly — it needs WebGL — so this is verified at the type level here and by the smoke test in Task 6).

- [ ] **Step 4: Commit**

```bash
git add src/render/postfx.ts
git commit -m "feat(render): add DreamFilter to the post-FX chain + setFilterStrengths"
```

---

## Task 4: Complete the LayerStack feedback render-to-target (the 6th filter)

**Files:**
- Modify: `app/src/render/LayerStack.ts`

This is the highest-risk task: it completes round 1's deferred `captureFeedback` stub so the melancholy "echo-trails" filter actually accumulates. Add `setFeedback(amount)` and implement real ping-pong: each frame, render the current composited scene into the write target, then show that texture on the feedback quad at the trail strength, blended additively beneath the live layers so previous frames persist and decay.

> **Verification:** validated by the `?wake=1` Playwright smoke (no console errors, **bounded heap** = no RT leak) + manual visual pass — not a fabricated unit test (mocking WebGL tests the mock). Keep the change contained to LayerStack.

- [ ] **Step 1: Add `setFeedback` + drive the feedback quad opacity from it**

In `LayerStack.ts`, add a field and method, and stop deriving the feedback quad opacity solely from `plan.feedback` (the director now owns it):
```ts
  // (field, near `private feedback = 0;`)
  private feedbackTrail = 0; // melancholy echo-trail strength, 0..1 (set by the conductor)

  // (method)
  /** Echo-trail strength for the melancholy "feedback" filter (0 = off). */
  setFeedback(amount: number): void {
    this.feedbackTrail = Math.max(0, Math.min(1, amount));
  }
```

- [ ] **Step 2: Implement real render-to-target capture**

Replace the body of `captureFeedback(renderer)` so it actually renders the scene into the write target and binds it for the next frame (the meshes already live in `compositor.scene`; render that scene to the target). Use the compositor's scene/camera:
```ts
  captureFeedback(renderer: THREE.WebGLRenderer): void {
    this.fbMat.opacity = this.feedbackTrail * 0.85;     // how strongly the echo shows
    this.fbMesh.visible = this.feedbackTrail > 0.01;
    if (this.feedbackTrail <= 0.01) return;

    // Render the current composited scene into the write target, then ping-pong: the freshly
    // written target becomes next frame's echo texture. The feedback quad samples the PREVIOUS
    // capture (bound last frame), so trails accumulate + decay by the opacity above.
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.fbB);
    renderer.render(this.compositor.scene, this.compositor.camera);
    renderer.setRenderTarget(prevTarget);

    const tmp = this.fbA;
    this.fbA = this.fbB;
    this.fbB = tmp;
    this.fbMat.map = this.fbA.texture;
    this.fbMat.needsUpdate = true;
  }
```
Notes for the implementer:
- The `fbMesh` is already added to the scene; rendering the scene into `fbB` will include the fbMesh itself (that *is* the feedback loop — last frame's echo feeds forward, which is what produces trails). Keep its `renderOrder = 9` (beneath the live layers).
- `compositor.scene` and `compositor.camera` are public on `Compositor`. `renderer` is passed in (the conductor calls `captureFeedback(this.compositor.renderer)` already).
- Make `fbMesh` visibility honour `feedbackTrail` so when melancholy is 0 the quad is hidden and the extra render is skipped (perf + exact identity when off).
- Wire `resize()` into the conductor or compositor so `fbA/fbB` track window size (round-1 review noted `resize` was never called): in the conductor, when wake is on, forward compositor resize to `layerStack.resize(w, h)`. If that's awkward, document it; the half-res targets still render, just not re-sized on window change.

- [ ] **Step 3: Ensure default-off is identity**

Confirm: when `feedbackTrail === 0` (no melancholy), `fbMesh.visible = false`, no extra render happens, and the frame is identical to today. The `applyPlan` feedback line from round 1 (`this.fbMat.opacity = plan.feedback * 0.9`) should be REMOVED or overridden — the director's `setFeedback` is now the single source of the trail strength (otherwise two sources fight). Update `applyPlan` to not touch `fbMat.opacity`.

- [ ] **Step 4: Typecheck + lint + the wake smoke (early check)**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: clean; 84 unit tests pass (LayerStack has no unit tests). Run `npm run test:e2e` and confirm `?wake=1` still passes (no console errors, bounded heap). If the feedback render-to-target throws or leaks (heap assertion fails), apply the **fallback**: revert `captureFeedback` to the inert stub, leave `setFeedback` storing the value, approximate the trail by NOT clearing recent layers as fast (raise older-layer opacity persistence in `applyPlan` when `feedbackTrail` is high), and note the limitation in the commit + report.

- [ ] **Step 5: Commit**

```bash
git add src/render/LayerStack.ts
git commit -m "feat(render): complete LayerStack feedback RT (melancholy echo-trails)"
```

---

## Task 5: Drive the catalog from the conductor (wake mode)

**Files:**
- Modify: `app/src/dream/conductor.ts`

Each wake frame, compute the strengths from the current mood + intensity + trough and push them to postfx + the LayerStack. Non-wake path untouched.

- [ ] **Step 1: Import + hold the current mood**

Add import: `import { filterStrengths } from './filterDirector';`. The conductor already computes mood on each swap (`this.walker.currentMood()` in `swapWakeLayer`). Add a field `private wakeMood = blankMood-equivalent` so `wakeTick` has a mood every frame:
- Add import for a blank mood. There isn't a `blankMood` export used in conductor; instead store the last mood. Add a field:
```ts
  private lastWakeMood: Record<MoodAxis, number> | null = null;
```
- In `swapWakeLayer`, where `const mood = this.walker.currentMood();` already exists, after it set `this.lastWakeMood = mood;`.

- [ ] **Step 2: Drive the filters in `wakeTick`**

In `wakeTick`, after the existing `this.postfx.setParams({...})` block (and after `s` is sampled), add:
```ts
    if (this.lastWakeMood) {
      const fs = filterStrengths(this.lastWakeMood, s.intensity, s.inTrough);
      this.postfx.setFilterStrengths(fs);
      this.layerStack?.setFeedback(fs.feedback);
    }
```
(`s` is the `IntensitySample` already sampled at the top of `wakeTick`; `this.layerStack` is the stack guarded earlier in the method.)

- [ ] **Step 3: Reset on reseed**

In `reseed()`, add `this.lastWakeMood = null;` so a reseed starts clean.

- [ ] **Step 4: Typecheck + lint + unit**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: clean; 84 unit tests still pass (non-wake path unchanged — the new code is inside `wakeTick`, which only runs when `this.wake`).

- [ ] **Step 5: Commit**

```bash
git add src/dream/conductor.ts
git commit -m "feat(dream): drive the mood-mapped filter catalog from wakeTick"
```

---

## Task 6: CLAUDE.md note + full verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Note the catalog** in `CLAUDE.md` under the aesthetic section (which round 1 already rewrote): add a short bullet that in wake mode the look is a **mood-mapped filter catalog** (kaleidoscope/liquid/solarize/melt/posterize + feedback echo-trails), the dominant CLIP mood axis selecting the active filter, intensity scaling its strength, eased off at coherence. Keep it tight; don't restructure the file.

- [ ] **Step 2: Full suite**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: all PASS (86 unit tests now: 84 + filterDirector + dreamFilter).

Run: `npm run test:e2e`
Expected: both smoke tests pass, including `?wake=1` (loads, plays, **zero console errors, bounded heap** — the leak guard for the feedback RT).

- [ ] **Step 3: Manual verify** (use the `/verify` skill): build with the R2 manifest and watch `?wake=1`:
```bash
VITE_MANIFEST_URL="https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json" npm run build
npm run preview -- --port 4173 --strictPort
```
Open `http://localhost:4173/?wake=1`. Confirm: the look visibly *changes* as the imagery's mood drifts (solarize/kaleidoscope on eerie/ominous frames, melt/liquid on warm/soft ones, posterize on hard-edged ones, trailing echoes on melancholy ones); filters intensify in frenzies and calm at coherent moments; no console errors. Tune `SHARPEN` / strength constants / per-filter UV-colour amounts if the feel is off, re-running unit tests after each change.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: note the mood-mapped dream-filter catalog (wake mode)"
```

---

## Task 7: Draft PR (stacked)

- [ ] **Step 1:** Push and open a **draft** PR. Because this is stacked on `feat/wake-chaos-engine` (which isn't merged yet), target that branch so the diff is just the filter catalog:
```bash
git push -u origin feat/dream-filters
gh pr create --draft --base feat/wake-chaos-engine --title "Dream-filter catalog: mood-mapped visual treatments (sub-project 2)" --body "Implements docs/superpowers/specs/2026-06-17-dream-filter-catalog-design.md. Stacked on the wake engine (#14)."
```
(If round 1 has merged to main by then, retarget `--base main` instead.)

---

## Self-review — spec coverage

- 6-filter mood-mapped catalog → Task 1 (mapping/strengths) + Task 2 (5 fragment filters) + Task 4 (feedback). ✓
- Dominant-axis selection + crossfade → Task 1 (sharpened weighting; mood drift = crossfade). ✓
- Intensity scales strength; trough ease-off → Task 1 + Task 5 (drives from `s.intensity`/`s.inTrough`). ✓
- DreamFilter identity at 0 / backward-compat → Task 2 (default-0 uniforms, mix-identity) + Task 4 (feedback hidden at 0) + Task 5 (wake-only). ✓
- Feedback echo-trails = complete round-1 RT, with fallback → Task 4. ✓
- Determinism → Task 1 (pure function of deterministic inputs; determinism test). ✓
- Testing (director units + dreamFilter units + smoke/heap) → Tasks 1, 2, 6. ✓
- CLAUDE.md note → Task 6. ✓
- Scope (no glitch/chroma, full-frame only, wake-mode) → respected; not in any task. ✓

**Type consistency:** `FilterStrengths` (6 fields) defined in Task 1, consumed by Task 2 (`setStrengths`, ignores `feedback`), Task 3 (`setFilterStrengths`), Task 5. `MOOD_FILTER` (Task 1) used in Task 1 tests. `filterStrengths()` (Task 1) called in Task 5. `DreamFilter.setStrengths/setTime` (Task 2) used in Task 3. `LayerStack.setFeedback` (Task 4) used in Task 5. Consistent.
