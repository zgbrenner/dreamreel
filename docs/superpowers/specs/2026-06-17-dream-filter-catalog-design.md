# DREAMREEL — Mood-Mapped Dream-Filter Catalog

**Date:** 2026-06-17
**Status:** Design approved (verbal); awaiting written-spec review
**Sub-project:** 2 of the aesthetic redesign. Builds on sub-project 1 (the wake chaos engine,
`docs/superpowers/specs/2026-06-17-wake-chaos-engine-design.md`, branch `feat/wake-chaos-engine`).
This branch (`feat/dream-filters`) is stacked on `feat/wake-chaos-engine`.

## Mission

Replace the single uniform old-film grade with a **rotating library of visual treatments** that
vary per moment — so DREAMREEL stops reading as "one old-TV filter." The active filter follows
the **image's mood**; the round-1 **intensity** heartbeat sets how strong it is; filters **ease
off at coherent moments** so the lucid image reads. Uses the existing wake-mode signals (mood,
intensity, coherence); does not change them.

## Goals / success criteria

- Six filters, chosen by the dominant CLIP **mood axis** (1:1 mapping below), crossfading as the
  mood drifts — only one substantially active at a time.
- **Intensity scales strength** (subtle when calm, cranked in frenzies); **troughs ease all
  filters toward 0** so the coherent image is clean and legible.
- Fully **deterministic** per `?seed` (mood/intensity/coherence are already seeded; the director
  is a pure function of them).
- **Backward-compatible:** all filter strengths default to 0 (identity); the classic reel and the
  non-wake path are byte-identical.
- Completes round 1's **deferred feedback render-to-target** (as the melancholy filter).

## The mood → filter mapping (confirmed)

The dominant mood axis selects the active filter:

| Mood axis | Filter | Character |
|-----------|--------|-----------|
| melancholy | **Feedback echo-trails** | lingering, haunted — the frame won't let go |
| uncanny | **Solarize / x-ray** | tonal inversion — negative, electric, wrong |
| nostalgic | **Liquid warp** | flowing soft-focus reverie |
| ominous | **Kaleidoscope / mirror** | fractured, vertiginous dread |
| tender | **Melt / bloom-bleed** | warm colours swell and bleed |
| mechanical | **Posterize / threshold** | flat, stark, banded — machine-cut |

(Glitch and chromatic-shatter were considered and **excluded** — keeps the palette painterly, not
digital.)

## Core idea

Two signals from round 1 already exist per frame in wake mode: the **mood** (`walker.currentMood()`,
6 axes 0..1) and the **intensity** sample (`{ intensity, inTrough }`). A pure `FilterDirector`
turns them into a strength ∈ [0,1] for each of the 6 filters:

- The **dominant axis** (argmax of mood) names the target filter; its strength rises while the
  previously-dominant filter's strength falls — a **crossfade** so the look doesn't hard-cut.
- The active strength is **scaled by intensity** (e.g. `base * (0.35 + 0.65*intensity)`).
- When `inTrough`, a coherence factor **eases all strengths toward 0** so the lucid moment reads.

Five filters are full-frame fragment-shader operations; the sixth (feedback) is stateful (a
render-to-target memory buffer).

## Components

Legend: ✚ new · ✎ changed

### ✚ `app/src/dream/filterDirector.ts`
Pure, seeded brain. `filterStrengths(mood, intensity, inTrough, prev?) -> FilterStrengths`
where `FilterStrengths = { kaleidoscope, liquid, solarize, melt, posterize, feedback }` (each
0..1). Holds the mood→filter mapping, the argmax-with-crossfade selection, the intensity scaling,
and the trough ease-off. No DOM, no three.js — fully unit-testable. (Crossfade state may be carried
via the `prev` argument or a small internal smoother; determinism preserved since it's a function
of the deterministic mood/intensity series.)

### ✚ `app/src/render/DreamFilter.ts`
A `postprocessing` `Effect` implementing the **five fragment filters**, each gated by a strength
uniform (`uKaleido`, `uLiquid`, `uSolarize`, `uMelt`, `uPosterize`):
- **Kaleidoscope** + **Liquid warp**: UV remaps in the `mainUv` hook (kaleidoscope folds UV into a
  mirrored wedge; liquid displaces UV by flowing noise). Strength 0 → UV unchanged.
- **Solarize**, **Melt**, **Posterize**: colour ops in `mainImage`, each `col = mix(col,
  op(col), strength)`. Solarize = tonal inversion curve; posterize = level quantisation; melt =
  saturate + warm bleed/brighten (a cheap per-pixel approximation; no expensive blur taps).
Strengths all 0 → the effect is an exact passthrough (identity).

### ✎ `app/src/render/postfx.ts`
Add `DreamFilter` to the EffectComposer chain, ordered **before** the FilmEffect grade so the
catalog transforms the image and the grade remains the unifying floor:
`RenderPass → EffectPass(DreamFilter, FilmEffect, Bloom) → EffectPass(Chroma)`. Add
`setFilterStrengths(s: FilterStrengths)` to push the five uniforms. DreamFilter defaults to all-0.

### ✎ `app/src/render/LayerStack.ts`
**Complete the feedback render-to-target** (the round-1 `captureFeedback` stub): render the
composited frame into the ping-pong target and blend the previous frame back in, with trail
strength driven by the **feedback** (melancholy) value. Add `setFeedback(amount: number)`.
Bounded by the existing half-res targets + disposal; the smoke heap guard covers leaks.

### ✎ `app/src/dream/conductor.ts`
In `wakeTick`, each frame: compute `FilterDirector.filterStrengths(mood, intensity, inTrough)` and
call `postfx.setFilterStrengths(...)` + `layerStack.setFeedback(strengths.feedback)`. Mood is
already read each swap; sample it (or hold the last swap's mood) for the director. No change to the
non-wake path.

## Data flow (per frame, wake mode)

```
mood = walker.currentMood()                 // already tracked
{ intensity, inTrough } = intensity.sample  // already sampled
s = FilterDirector.filterStrengths(mood, intensity, inTrough)
  → postfx.setFilterStrengths(s)            // 5 fragment filters
  → layerStack.setFeedback(s.feedback)      // the 6th, stateful
→ render: DreamFilter → FilmEffect(grade) → bloom → chroma
```

## Determinism

`mood`, `intensity`, `inTrough` are deterministic per seed (sub-project 1). `FilterDirector` is a
pure function of them, so the sequence of active filters and their strengths reproduces exactly
from a `?seed`. Only the crossfade ramp's wall-clock timing varies with frame rate — cosmetic, the
same carve-out the film look already has.

## The feedback-RT risk (highest-risk task) + fallback

Five filters are routine fragment work. **Feedback echo-trails** needs real render-to-target
ping-pong, which tangles with the post-FX composer (the reason it was deferred in round 1).
Mitigation: implement it as its own focused task with an explicit fallback — **if** clean
render-to-target feedback proves too entangled, ship the other five filters and approximate the
melancholy "trail" with a cheaper persistence (lean on the existing dense LayerStack lingering /
a layer-opacity hold), and log the limitation. The five fragment filters carry the catalog
regardless, so this risk never blocks the round.

## Testing

- **Vitest (`filterDirector`):** dominant axis → the correct filter; intensity scales strength;
  `inTrough` eases strengths toward ~0; during a dominant-axis change two strengths crossfade
  (sum stays bounded, neither spikes); **all six filters are reachable** across the mood space;
  determinism (same mood/intensity series → identical strengths); the all-zero/identity default.
- **Shader + feedback (GPU):** the existing `?wake=1` Playwright smoke (loads, plays, **zero
  console errors, bounded heap** — the feedback-RT leak guard) + a manual visual pass.
- **Backward-compat:** a test asserting default `FilterStrengths` are all 0 and that DreamFilter at
  0 strength is identity; the existing unit + smoke suites stay green.

## Scope

*In:* `FilterDirector`, `DreamFilter` (5 fragment filters), completing the LayerStack feedback RT,
conductor wiring, tests, a CLAUDE.md note. Active in **wake mode** (default-0 elsewhere, classic
unchanged). Reads round 1's signals; does not change them.

*Out (not this round):* glitch + chromatic-shatter (not chosen); per-layer filters (full-frame
only); new mood axes; a user-facing filter toggle; tuning beyond sane defaults (dial in during the
visual pass).

## Open questions

None blocking. Exact strength curves, crossfade speed, and per-filter UV/colour constants are tuned
during implementation against the live `?wake=1` reel.
