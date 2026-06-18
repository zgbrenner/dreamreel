# DREAMREEL — "Finnegans Wake" Chaos Engine + Fluid Dense Layering

**Date:** 2026-06-17
**Status:** Design approved (verbal); awaiting written-spec review
**Sub-project:** 1 of a multi-round aesthetic redesign (this spec covers the *temporal + compositional heartbeat* only)

## Mission

Transform DREAMREEL from a tasteful, uniform old-film reel of still photos into a
**chaotic, fluid, multi-modal stream of consciousness** in the spirit of James Joyce's
*Finnegans Wake*: fast, sporadic, bizarre, densely layered media that mostly seethes and
recombines, with **rare, brief flickers of coherence** before dissolving again.

This sub-project delivers the **heartbeat** — the rhythm, the breathing density, and the
coherent moments — using the **existing 135-image R2 corpus**. It does not add new media
types or a filter catalog; those are later rounds (see Out of Scope).

## Goals / success criteria

- The reel feels **fast and sporadic**, never a regular pulse; flurries of rapid change,
  sudden gaps, the occasional held frame. No long lingering.
- **Density breathes** with a single intensity signal: baseline ~4–6 layers, surging to
  7+ with heavy feedback during frenzies, collapsing to 1–3 at coherent moments.
- **Coherent moments** are rare (~every 25–45s) and brief (~2s), and break down as
  **50% thematic-rhyme / 35% lucid-image / 15% legible-phrase**.
- The whole thing stays **deterministic and shareable** from a `?seed` (designed
  randomness, not un-repeatable randomness).
- Ships within the existing contracts: manifest unchanged, live-WebGL primary,
  license rules intact, `prefers-reduced-motion` respected.

## Core idea — one signal rules everything

A new `IntensityEngine` emits a single scalar **intensity ∈ [0,1]** that evolves over a
*logical* (tempo-scaled) clock seeded from the share-seed. Every subsystem reads it:

| intensity | regime | layers | feedback | churn rate | film/warp |
|-----------|--------|--------|----------|-----------|-----------|
| high (frenzy) | density **C** | 7+ | heavy | very fast swaps | warp/aberration up |
| mid (baseline) | density **B** | 4–6 | trails | fast, uneven | moderate |
| low (trough) | density **A** = *coherent moment* | 1–3 | minimal | slow/held | calm grade |

The envelope is **sporadic, not a smooth wave**: seeded value-noise plus random spikes
("flurries") and holds ("frozen frames"), so it lurches. Troughs (coherent moments) are
*scheduled* to be rare and brief, jittered around ~25–45s spacing, ~2s duration.

## Components

Legend: ✚ new file · ✎ changed file

### ✚ `app/src/dream/intensity.ts`
Pure, seeded function of `(seed, logicalTime)` returning `{ intensity, regime, inTrough,
troughId }`. No rendering, no DOM — fully unit-testable. Encapsulates:
- the sporadic envelope (value-noise + spike/hold events drawn from a seeded PRNG stream),
- the coherence-trough schedule (next trough time + duration, jittered, seeded),
- a single **clamp point** `maxIntensity` (for reduced-motion now, photosensitivity later).

### ✎ `app/src/dream/conductor.ts`
The fixed three beat-clocks (image / ghost / text) are replaced by an
**intensity-driven scheduler**: the interval until the next layer event shrinks as
intensity rises. The conductor still owns mood projection and drives audio. It samples
`IntensityEngine` each tick and orchestrates `LayerStack`, `Dreamwalker`, and coherence.

### ✚ `app/src/render/LayerStack.ts`
Replaces the 2-layer compositor model with **N dynamic layers** drawn from a fixed
texture/quad **pool** (cap ~8). Each layer has its own asset, opacity, and blend mode.
Adds a **ping-pong feedback buffer** (render-to-texture) for smear/trails. Active layer
count and feedback amount are `f(intensity)`. Explicit texture disposal on swap to bound
GPU memory.

### ✚ `app/src/dream/coherence.ts`
At each trough, draws (seeded) **50% thematic-rhyme / 35% lucid-image / 15% legible-phrase**
and instructs `LayerStack` + `Dreamwalker` how to converge:
- **thematic-rhyme** → keep several layers but bias them to one theme (convergence mode).
- **lucid-image** → collapse to a single clear, lightly-graded layer, held.
- **legible-phrase** → calm image + a readable original stream-of-consciousness line.

### ✎ `app/src/dream/dreamwalker.ts`
Adds a **convergence mode**: temporarily tighten softmax temperature and bias selection
toward assets thematically similar to the current point, so rhyme moments actually rhyme.
Normal chaotic drift/leap walk otherwise. Selection still flows through seeded PRNG streams.

### ✎ `app/src/render/postfx.ts` + `app/src/render/filmParams.ts`
The uniform old-film grade is **demoted to one intensity-modulated component** (no longer
"old TV on everything"). Add the minimal fluid primitives needed for this round:
- feedback smear (lives in `LayerStack`),
- a **warp / displacement** that ramps with intensity (during frenzies).
The full rotating filter catalog (kaleidoscope, datamosh, solarize, …) is a later round.

### Text content
Original, ship-safe, Joycean-flavored stream-of-consciousness lines authored for the
project (NOT *Finnegans Wake* text, which is not US public-domain until 2035). A modest
set of these lines is **authored as part of this round** and fed into the existing text
pool (a content change, not a contract change) so the 15% legible-phrase coherence has
material worth surfacing. Larger-scale text generation/curation can come later.

## Data flow (per frame)

```
intensity = IntensityEngine.sample(seed, logicalTime)
  → scheduler: is a layer event due? (sooner at high intensity)
      → Dreamwalker.pick(normal | convergence)         // seeded, ordered
      → LayerStack.update(count, blend, feedback = f(intensity))
  → postfx aggression (warp/grade/aberration) = f(intensity)
  → if inTrough: coherence.apply(rhyme | lucid | phrase)
  → render N layers + feedback → post-FX → frame
```

## Determinism & shareability

- Intensity is a function of a **logical clock** (accumulated tempo-scaled `dt`), never
  wall-clock, so the number of events in a logical interval is fixed across machines.
- Every content decision (asset pick, layer swap, coherence type, convergence target) is
  drawn **in order** from seeded PRNG streams (forked per concern, as today).
- Therefore: same `?seed` → identical dream script (sequence of assets, layer events,
  coherence moments) in the same order; only exact render *timing* drifts with frame rate.
- Reseed → a different but fully reproducible dream. This preserves the existing contract.

## Performance & safety

- **GPU memory:** fixed texture pool (≤ ~8 layers), feedback buffer at reduced resolution,
  explicit disposal on layer swap. The Playwright smoke test's bounded-heap assertion
  guards against leaks.
- **Mobile:** existing 1600px downscale retained; feedback/layer caps lower on small
  screens.
- **`prefers-reduced-motion`:** clamps `maxIntensity` (no frenzies/strobe, longer holds),
  reusing the existing intensity hook in the conductor.
- **Photosensitivity:** deferred per product owner. A single clamp point
  (`maxIntensity` / max swap-rate / max per-frame luminance delta) is left in
  `IntensityEngine` so the future safety pass is a config change, not a refactor.

## Testing

- **Vitest (dream/):**
  - intensity envelope is reproducible for a given seed (snapshot of sampled series);
  - trough cadence ≈ 25–45s and brief (~2s) within tolerance over a long run;
  - coherence split ≈ 50/35/15 over many seeds within tolerance;
  - active layer count rises monotonically with intensity;
  - convergence mode measurably reduces mean pairwise embedding distance during rhyme.
- **Determinism test:** same seed → identical ordered event sequence; reseed differs.
- **Contract tests:** manifest unchanged → existing pipeline/manifest tests still pass.
- **Playwright smoke:** loads, plays for the run window, no console errors, bounded heap.

## Rollout

- Develop behind a `?wake` flag (or store toggle), default **off** until solid, then flip
  to **default on** — the new engine becomes DREAMREEL's normal behavior. The flag is a
  development safety net, not a permanent dual-mode.

## CLAUDE.md changes (part of this work)

Rewrite the sections that encode the old aesthetic as invariants:
- **"Aesthetic tokens (the look is fixed; do not redesign)"** → describe the intensity-driven,
  chaotic, multi-modal, fluid-layered model; keep the palette/type as *available* tokens
  rather than a mandated uniform old-cinema treatment.
- **Core architecture** lines that assume "three desynced layer clocks" and old-cinema
  signature → describe the single intensity signal + N-layer feedback stack + coherence
  troughs.
- **Keep unchanged:** determinism/seed-shareability, live-WebGL-primary, and all license rules.

## Out of scope (explicitly — later rounds)

- **Filter catalog** (kaleidoscope, datamosh, solarize/x-ray, melt-bloom, …) — work-stream #2.
- **Video playback** (THREE.VideoTexture + video transcode/upload path) — work-stream #4.
- **Spoken-word / "audiobook" voices** (sampled-audio subsystem) — work-stream #5.
- **Weirder/scarier corpus curation** (uncanny public-domain sourcing) — work-stream #1.
- **Photosensitivity hardening** — deferred per product owner; seam left in `IntensityEngine`.

## Open questions

None blocking. Tuning constants (exact trough cadence, layer caps, envelope spikiness) will
be dialed in during implementation against the live reel and the smoke/eval loop.
