# Wake-mode Pacing + Restraint Tuning — Design

_Date: 2026-06-23. Status: approved (Approach A), ready for implementation plan._

## Goal

Tune the live wake-mode (`?wake=1`) experience so it keeps its chaotic character but gains
**contrast**: calmer, clearer, lingering moments interspersed in the frenzy — especially to let
film clips actually be watched — and stops over-distorting imagery that should read as real and
immersive. Owner feedback (verbatim intent): cuts are "too sporadic/fast without any periods of
time to actually enjoy/ingest anything"; film clips should get time to "add to the overarching
story or add to the craziness"; filters "sometimes distort the images or videos too much… a dream
many times feels real and immersive… some reasonableness and clarity is okay."

This is a **tuning pass** on existing shipped mechanisms (Round 1 chaos engine + Round 2 filters +
Round 4 video). No new subsystems. Approach **A — "Breathing room + lucid showcases."**

## Constraints (unchanged from the project)

- **Determinism preserved.** Every change is a constant or a deterministic scalar; no new
  `Math.random`/wall-clock and no new RNG draws enter the dream path. Same seed → same script.
- TypeScript strict; no `any`. Existing test suite stays green (tests asserting the changed
  constants get updated to the new values — that is expected, not a regression).
- Wake-mode only for the pacing/distortion levers; the video selection weight and the VideoPool
  cap also help classic mode (more video everywhere is desired).
- Muted/visual-only video unchanged.

## The four levers

### Lever 1 — Pacing: breathing room in the swap cadence
`conductor.ts` `wakeTick()` swap interval (currently
`(0.12 + (1 - intensity) * 0.9) / max(0.5, tempoMul)` → 0.12s at peak, ~1.0s calm):

- Widen and slow to **`(0.4 + (1 - intensity) * 1.6) / max(0.5, tempoMul)`** → ~0.4s at peak
  (still energetic, ~2–3 cuts/sec), **~2.0s when calm** (genuine room to take something in).
- **Trough hold:** when `s.inTrough`, multiply the computed interval by **2.0** so a lucid moment
  lingers (~3.5–4s) instead of being cut away. `s.inTrough` is already in scope in `wakeTick`.

### Lever 2 — More and longer lucid moments (coherence troughs)
`intensity.ts` trough schedule constants:

- `TROUGH_MIN_GAP` 22 → **14**, `TROUGH_MAX_GAP` 46 → **30** — troughs ~1.5× more frequent.
- `TROUGH_DUR` 2.0 → **4.0** — each lucid window lasts long enough to actually watch a clip.
- `TROUGH_RAMP` 0.8 → **1.0** — slightly gentler ease in/out.

Troughs are where the walk converges and (Lever 4) filters ease hardest — the "sit and enjoy"
beats. Making them more frequent + longer is the core of "periods to enjoy."

### Lever 3 — Video presence + linger
1. **Frequency** — `dreamwalker.ts` `pick()`: introduce a module constant
   `TYPE_WEIGHTS: Record<string, number> = { video: 3.5 }` (default 1.0 for others) and multiply
   each candidate's pre-softmax weight by its type weight. Deterministic (scalar multiply, no new
   RNG). Lifts video from ~11% of selections toward ~25–30% without overwhelming the walk's
   embedding geometry. Applies to wake and classic.
2. **Linger** — when a video lands on a layer slot in `swapWakeLayer()`, hold that slot so the
   clip can play instead of being overwritten on the next tick. Implement a small **pure,
   unit-tested helper** `pickSwapSlot(cursor, heldUntil, clock, maxLayers) -> { slot, nextCursor }`
   that advances the round-robin cursor but skips slots whose `heldUntil > clock` (falling back to
   the cursor slot if every slot is held, so it can never deadlock). On placing a video, set that
   slot's `heldUntil = clock + VIDEO_HOLD` where `VIDEO_HOLD = 5.0` (**8.0 in a trough**). Non-video
   placements set no hold (or `heldUntil = 0`). The conductor keeps a `slotHeldUntil: number[]`
   (length `MAX_LAYERS`).
3. **Concurrency** — `Compositor.ts` `VideoPool` cap **2 → 3** so a few more clips can be moving at
   once (the pool still freezes the oldest beyond cap; the linger means less churn, so 3 is safe).

### Lever 4 — Distortion restraint (clarity for immersion)
- `filterDirector.ts` strength scale: `(0.35 + 0.65 * intensity)` → **`(0.18 + 0.5 * intensity)`**
  (peak 0.68 vs 1.0; calm 0.18 vs 0.35) — most assets read clearly; heavy distortion still
  available at true peaks.
- `filterDirector.ts` `TROUGH_EASE` 0.12 → **0.08** — lucid moments are nearly clean.
- `conductor.ts` after `filterStrengths(...)` (the two geometry-manglers): cap
  **`fs.kaleidoscope = min(fs.kaleidoscope, 0.5)`** and **`fs.liquid = min(fs.liquid, 0.7)`** so the
  image is never fully obliterated by a UV remap. ("If distortion is necessary to fill the screen,
  so be it" — capping at 0.5/0.7 still distorts meaningfully but preserves the underlying image.)
- `conductor.ts` film-shader warp: `min(1, intensity*intensity*0.9)` → **`min(1, intensity*intensity*0.5)`**
  — less compounding UV drift on top of the liquid filter.

## Components touched

| File | Change | Testable unit |
|------|--------|---------------|
| `app/src/dream/intensity.ts` | 4 trough constants | `intensity.test.ts` (trough frequency/duration) — update + assert new cadence |
| `app/src/dream/dreamwalker.ts` | `TYPE_WEIGHTS` + weight multiply in `pick()` | new test: video weighting boosts video selection share, deterministic |
| `app/src/dream/slotHold.ts` (new) | pure `pickSwapSlot()` helper | new unit test: skips held slots, no deadlock when all held, round-robin otherwise |
| `app/src/dream/conductor.ts` | swap interval + trough hold; `slotHeldUntil` + `pickSwapSlot` use; kaleidoscope/liquid caps; warp coefficient | verified by typecheck/lint + full suite + manual `?wake=1` (conductor is not unit-harnessed) |
| `app/src/dream/filterDirector.ts` | strength scale + `TROUGH_EASE` | `filterDirector.test.ts` — update to new scale |
| `app/src/render/Compositor.ts` | `VideoPool` cap 2 → 3 | existing compositor test unaffected |

## Data flow (unchanged shape, new dynamics)

`IntensityEngine.sample` (more/longer troughs) → `wakeTick` (slower cadence; trough holds longer;
softer filters; kaleidoscope/liquid capped) → coherence trough eases filters to near-clean →
`swapWakeLayer` picks a slot via `pickSwapSlot` (skipping held video slots) → video lands more
often (`TYPE_WEIGHTS`) and holds (`VIDEO_HOLD`, longer in trough) → `VideoPool` (cap 3) plays it.

## Error handling / determinism

- No new failure modes. `pickSwapSlot` always returns a valid slot (never deadlocks). All numeric
  changes are bounded and clamped where they already were.
- Determinism: `TYPE_WEIGHTS` multiply is deterministic; trough constants change the seeded
  schedule's values but not its determinism (same seed → same new schedule); slot-hold tracking is
  driven by the logical clock, not randomness. The per-seed *sequence* of assets/troughs remains a
  pure function of the seed.

## Testing strategy

- **Unit (vitest):** new `slotHold.test.ts` (skip-held / no-deadlock / round-robin); new dreamwalker
  test that with `TYPE_WEIGHTS.video > 1` a video-heavy-similarity pool selects video more than the
  unweighted baseline, and that weights of 1.0 reproduce current behavior (regression guard);
  update `intensity.test.ts` and `filterDirector.test.ts` to the new constants and assert the new
  cadence/scale.
- **Integration:** `npm run typecheck && npm run lint && npx vitest run` all green; conductor wiring
  (swap interval, trough hold, caps, slot-hold) verified by the full suite not regressing.
- **Manual:** rebuild + `npm run preview`, open `?wake=1`, confirm: visible calm/lucid stretches,
  film clips that linger and read clearly, fewer obliterating kaleidoscope frames, more video
  overall. (Playwright smoke still passes.)

## Out of scope (YAGNI)

- No "force a video specifically during the lucid-image trough kind" — the type-weight + longer
  troughs + filter-ease already make clips land more often and read clearly; an explicit forcing
  rule adds coupling for little gain.
- No classic-mode transition changes (owner is judging wake mode; classic transitions are a
  separate concern if/when classic is revisited).
- No new URL params / UI controls for these knobs — they are tuned constants.

## Approaches considered

- **A (chosen):** reshape the dynamics — slower/widened cadence, more+longer lucid troughs, video
  presence+linger, distortion restraint. Serves all of: periods to enjoy, clarity for immersion,
  watchable clips, **and** the craziness.
- **B — global dials only:** slower interval + lower filter scale + video weight, no troughs/linger.
  Uniformly gentler; loses the frantic↔calm contrast and the "watchable clip" goal.
- **C — heavy-handed restraint:** strongly slow + strongly de-distort + heavily favor video. Risks
  flattening the chaotic character the redesign is built on.
