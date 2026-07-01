# DREAMREEL — Handoff / Pick-Up Doc

_Last updated: 2026-06-29 (coverage backfill + PD-poetry + so400m re-embed, all live). Read this first when resuming._

## Latest session (2026-06-29) — the headline

Four roadmap items shipped, all live in production as one final consolidated corpus
(**`v2026.06.29-2332`**, see "Now serving" below). Five validated manifest reships, each preserving
prior data:

1. **Coverage backfill** (new `--only-missing` flags on `embed.shots` / `embed.entities`, merged
   PR #53): `shots[]` **22 → 31/37** videos (tuned `--lead 8 --window 120 --max-shots 10`), RAM++
   `entities[]` **270 → 280/281** visuals. Remaining gaps are dead / cut-less archive.org URLs.
2. **Sprite-pool deepen** (orchestration over `embed.sprites` + `embed.sprite_clips` building blocks,
   append-only): `entitySprites[]` **44 → 62** (50 static + 12 animated). Only 3 new animated landed —
   most videos' first entity is abstract (`dark`/`cloud`) and Grounding DINO can't localize it.
3. **PD-poetry ingest** (`embed.poetry`, merged PR #52): **+100** public-domain poetry lines
   (Dickinson/Blake/Poe/Whitman/Rossetti), tagged `license: "PD"`, texts **242 → 342**.
4. **so400m SigLIP 2 re-embed** (`reembed_siglip --model …-so400m`): the whole visual+text pool
   re-embedded **768-d → 1152-d**, 12 mood axes refit in the new space. Audio/CLAP/`claptext`/
   `aesthetic`/`bpm`/`entities`/`shots`/`sprites` all preserved.

**⚠ Operational notes for re-runs:** (a) the so400m 4.5 GB checkpoint is cached but Windows blocked
HF's cache symlinks (`WinError 1314`, Dev Mode off) — finalize via **copy-mode** (monkeypatch
`huggingface_hub.file_download.are_symlinks_supported → False` before download); (b) `embed.poetry` /
`embed.textgen` embed with CLIP-512 and CRASH projecting onto 768/1152-d mood axes — fixed to write
provisional placeholders + warn (PR #54); the augment-then-reembed lineage sets the real embeddings.
Manifest is now **~9.9 MB** (1152-d), up from 6.5 MB.

## Latest session (2026-06-25) — the headline

Two big arcs landed on top of the wake-mode redesign, all merged to `main` and live in production:

1. **An open-source improvement batch** (each its own offline tool + reship): **organic film grain**
   (Ashima webgl-noise), a **photosensitivity flash governor** (WCAG ≤3/sec), **SemDeDup** corpus
   pruning, a **LAION aesthetic** quality bias, a **generative text engine** (+200 grammar lines), a
   **SigLIP 2 (768-d)** embedder upgrade, **29 transitions**, and **shot-detection montage**
   (PySceneDetect) — video assets now play a real interior shot instead of the film's leader.
2. **The memory system — dream RECURRENCE** (`dream/memory.ts` `DreamMemory`), three layers deep:
   - **Recurrence bias** — RAM++ open-set `entities[]` per asset feed a decaying memory; the walk
     leans toward candidates that echo remembered motifs (bounded + relaxing + deterministic).
   - **Literal reuse** — Grounding DINO + SAM 2 segment recurring entities into RGBA cutouts
     (`entitySprites[]`); the conductor summons one as a drifting ghost when its entity is strongly
     remembered (`render/SpriteField.ts`).
   - **Animated reuse** — SAM 2 *video* tracking turns a tracked entity into a sprite-sheet that the
     SpriteField cycles, so the recurring figure MOVES.

   **⚠ Operational reality for re-runs (this matters at pickup):** RAM++ needs transformers **4.x**
   (we're on 5.x for SigLIP 2) → run `embed.entities` in a `--system-site-packages` venv with
   `transformers==4.48.3` reusing global torch. Large HF checkpoints (so400m, RAM++) **stall on this
   connection** → use the resilient resumable downloader (`scratchpad/dl_ram.py` pattern: HTTP Range +
   read-timeout + resume) and pass the local file via `--checkpoint`. Grounding DINO + SAM 2 download
   fine. See the roadmap rows for the exact per-tool notes.

## TL;DR — where we are

DREAMREEL is being redesigned from a tasteful old-film reel into a **chaotic, fluid, multi-modal,
Finnegans-Wake-style stream of consciousness**. As of 2026-06-23, **wake mode is the default
experience**; the classic three-clock reel is now opt-out via **`?wake=0`**. The redesign is well
advanced — all merged to `main`:

- **Chaos engine + fluid layering** (rounds 6/3): a seeded `intensity` heartbeat drives sporadic
  layer-swaps, breathing N-layer density (`LayerStack`), and rare **coherence troughs**.
- **Dream-filter catalog** (round 2): mood-axis-selected filters (kaleidoscope, liquid, solarize,
  melt, posterize, feedback echo-trails).
- **Uncanny image corpus** (round 1): CLIP-embedded public-domain images.
- **Moving image / video** (round 4): short, muted, looping public-domain film clips as first-class
  visual assets.
- **Wake-mode "pacing + restraint" polish** (2026-06-23, PR #20): a large live-feel tuning pass on
  owner feedback — calmer/widened cadence, more+longer lucid moments, far more (7×) and longer-held
  (9–13 s) **video that is pinned visible while it plays**, **content-aware clip frames** (CLIP
  avoids title cards/logos), much less distortion/flicker/old-TV/feedback, **cross-faded layer
  swaps**, and less on-screen text.
- **Sampled audio as a first-class medium** (round 5, 2026-06-23, merged `main` `4c573bc`): a second
  Infinite-Jukebox walk in **CLAP** space (`dream/audioWalker.ts`), **text-bridge-coupled** to the
  on-screen visual (each visual asset carries a `claptext` vector), mixed over the untouched synth bed
  by a Tone bus graph (`audio/mixer.ts`: music/foley/voice/film-clip buses + ducking + bounded
  `AudioPool`). Plays in **both** classic and wake, behind the existing sound/archive toggles.
  Determinism preserved: audio picks fire on **logical visual beats** (`dream/audioCadence.ts`), not
  wall-clock. Film clips now ship **with** their native soundtrack (ducked in when a clip is the hero).
- **Single-verb UX** (2026-06-23, `main` `fc1af01`): the viewer can only summon a **new dream** —
  no dream-shaping controls. Surreality + tempo are now derived from the seed (`dream/seedParams.ts`),
  not user knobs; the UI is just **New dream / play-pause / sound on-off**. Shareable state reduced to
  **`?seed=`** only (`?wake=0` remains a non-UI engine-mode opt-out). Store no longer holds
  surreality/tempo/archive.
- **Emotion-taxonomy expansion to 12 blendable axes** (2026-06-23, data + types + docs): added
  **love, loss, joy, fear, absurdity, strange** to the original six CLIP mood axes. Mood is a
  continuous, blendable vector over all axes (never a single label). Helpers `dominantAxes`,
  `blendMoods`, and `moodAffinity` in `dream/mood.ts`.
- **12-axis wiring through visuals, audio, and text** (2026-06-24, `main` `2ff5ca9` — *the six new
  axes are no longer data-only*): `filterDirector.ts` now maps **all twelve** axes (paired 2:1 onto
  the six filters) for post-FX strength + transition family + procedural params; `audio/params.ts`
  `bedParamsFor` reshapes the whole bed off all twelve; the CLAP audio walk gains a `moodAffinity`
  bias (`audioWalker.ts` `MOOD_COUPLING`); `dreamwalker.ts` biases text + intertitle picks by mood
  (`pickCardByMood`) and widens the ghost trigger to fear/strange; `textDirector.ts` tints whispers +
  title cards by the live blend, consumed by `Captions.tsx` and `conductor.makeTitleCard`. Mood flows
  live to the store each beat (`conductor.setMood` → `Gate` → `_setMood` → `s.mood`) in **both** wake
  and classic. `moodAffinity` (signed dot of mood deviations) is the shared bias currency.
- **Manifest remood tool** (2026-06-24, `main` `673b62b`): `pipeline/embed/remood_manifest.py` fetches
  the live R2 manifest, rebuilds the 12 CLIP/CLAP axis vectors, re-projects every baked mood from the
  **existing** embeddings (no re-download/re-transcode), bumps the version, and can upload
  **manifest-only** to R2. **Ran 2026-06-24** — the live corpus is now 12-axis (see below).

- Live app: **https://dreamreel.pages.dev** (**wake by default**; add **`?wake=0`** for the classic
  three-clock reel). **Production deploys from `main`** via Cloudflare Pages Git integration.
- Production manifest: `VITE_MANIFEST_URL` on Cloudflare Pages (prod **and** preview) →
  `https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json`. **Now serving
  v`2026.06.29-2332`: 290 visual assets (SemDeDup-pruned from 326) + 342 texts (42 curated + 200
  generated + **100 public-domain poetry**) + `claptext` on every visual asset, plus a `44`-clip
  `audio[]` pool, `audioEmbeddingDim 512`. Visual + text embeddings are now **SigLIP 2 so400m,
  `embeddingDim 1152`** with 12-axis moods refit in that space (upgraded from the 768-d base);
  244 images carry a LAION `aesthetic` score; audio carries `bpm`/`energy`; **31/37** videos carry
  interior `shots[]`; **280/281** visuals carry RAM++ `entities[]`; and the manifest has a
  **62-entry `entitySprites[]` pool (50 static cutouts + 12 SAM 2 video-tracked animated)** for memory
  recurrence. Built by the 2026-06-24/25 improvement batch + memory system + the 2026-06-29 backfill /
  poetry / so400m session (see roadmap). Manifest ≈ 9.9 MB at 1152-d.**

  **Reship lineage (each a manifest-only R2 reship from the live manifest):** `…06.25-1859` remood
  (12-axis) → `…-2058` add_tempo → `…-2338` SemDeDup (290) → `…-2358` aesthetic → `…-0000` textgen
  (+200) → SigLIP 2 re-embed (768-d) → `…-0136` shots → `…-0246` entities → `…-0331` sprites →
  `…-0434` animated sprites → **`…06.29-2214` shots backfill (31/37) → `…-2221` entities backfill
  (280/281) → `…-2301` sprite deepen (62) → `…-2332` poetry (+100) + so400m re-embed (1152-d)**.
  Each tool fetches `latest.json`, edits, and re-uploads manifest-only (media untouched) — so they
  compose. New media (sprite PNGs) is uploaded via `upload_media`.

## The 6-round roadmap

| # | Work-stream | Status |
|---|-------------|--------|
| 6 | **Chaos engine + rare coherence** | ✅ merged |
| 3 | **Fluid dense layering** | ✅ folded into the chaos engine (LayerStack) |
| 2 | **Dream-filter catalog (not one old-TV look)** | ✅ merged |
| 1 | **Weirder/scarier corpus** | ✅ shipped to R2 (uncanny images) |
| 4 | **Moving image (video)** | ✅ shipped to R2 (40 PD film clips, content-aware frames) |
| — | **Wake pacing + restraint polish** | ✅ merged (PR #20, 2026-06-23) |
| 5 | **Sampled audio (music + voice + foley + film-clip native audio)** | ✅ shipped to R2 (CLAP walk, 44 audio clips, v2026.06.23-1515) |
| — | **Single-verb UX (new-dream-only; seed-derived surreality/tempo)** | ✅ merged (`main` `fc1af01`) |
| — | **Emotion taxonomy: 12 blendable axes (data+types+docs)** | ✅ done |
| — | **12-axis wiring through visuals/audio/text** | ✅ merged (`main` `2ff5ca9`); live R2 corpus remooded to 12 axes (`v2026.06.24-1859`) |
| — | **Musical pacing (librosa tempo/energy → bar-quantized audio)** | ✅ code merged + live (`v2026.06.24-2058`, 44/44 clips carry bpm/energy) |
| — | **Transition catalog expansion (21 → 29 shaders)** | ✅ 8 new original gl-transitions-spec shaders wired into mood families; all compile-checked in WebGL |
| — | **Organic film grain (Ashima webgl-noise, MIT)** | ✅ merged — simplex grain replaces hash noise in post-FX (`render/shaderNoise.ts`) |
| — | **SemDeDup visual corpus pruning** | ✅ tool merged + **live** (`embed/semdedup.py`, exact pairwise); pruned 36 near-dupes → `v2026.06.24-2338` (290 assets) |
| — | **Aesthetic-predictor quality bias** | ✅ merged + **live** (`embed/aesthetic.py` LAION head over OpenAI-CLIP; `dreamwalker.aestheticBoost`); 244 images scored |
| — | **Generative text engine** | ✅ merged + **live** (`embed/textgen.py`, deterministic DREAMREEL-voice grammar); +200 lines |
| — | **PD-poetry ingest** | ✅ merged (PR #52) + **live** (`embed/poetry.py`, +100 public-domain lines, Dickinson/Blake/Poe/Whitman/Rossetti, `license: "PD"`). Augment-then-reembed; the so400m pass set the real 1152-d embeddings. Augment tools' CLIP-512-vs-axes-dim crash fixed in PR #54 |
| — | **SigLIP 2 embedder upgrade** | ✅ merged + **live**: corpus first re-embedded to **768-d** SigLIP 2 base, then **upgraded to so400m `1152-d`** (`reembed_siglip --model google/siglip2-so400m-patch14-384`) on 2026-06-29, mood axes refit. so400m 4.5 GB checkpoint needed copy-mode download on Windows (`WinError 1314` symlink block, Dev Mode off). 0 media fell back to tag-embeddings on the so400m run |
| — | **Photosensitivity hardening** | ✅ runtime flash-rate governor shipped (`render/flashGuard.ts`, WCAG ≤3/sec, ≤1/sec reduced-motion); ⬜ offline content-flash (hard-cut) analysis still open |
| — | **Shot detection / montage grammar (PySceneDetect)** | ✅ merged + **live** (`embed/shots.py` + `render/VideoPool` shot-loop + `conductor.pickShot`); 22/37 films carry `shots[]` (`v2026.06.25-0136`). **Finding:** video `src` is the FULL archive.org film and the runtime played from t=0 (leaders/title cards) — `shots[]` makes it play a real interior shot. NeMo Curator rejected (Ray/GPU overkill; no NeMo dep) |
| — | **Memory system — dream recurrence (RAM++)** | ✅ Phase 1 **merged + LIVE** (`v2026.06.25-0246`, 270/281 visual assets carry `entities[]`, 501-entity vocab). `dream/memory.ts` DreamMemory (decaying weights) + `dreamwalker` recurrence bias + `conductor` per-beat observe — motifs recur, bounded + relaxing + deterministic; smoke-tested live. **Ops note:** RAM++ needs transformers **4.x** (we're on 5.x for SigLIP 2) — run in a `--system-site-packages` venv with `transformers==4.48.3` reusing global torch; the ~3 GB checkpoint must be pulled with a resumable downloader (`scratchpad/dl_ram.py` pattern) + passed via `embed.entities --checkpoint` (HF's fetch hangs on this throttled link). ✅ **Phase 2 code merged** — literal segmented-entity reuse: `embed/sprites.py` (Grounding DINO box → SAM 2 mask → RGBA cutout → R2; both Apache-2.0 via transformers 5.x), manifest `entitySprites[]`, `render/SpriteField.ts` + `conductor.maybeSummonSprite` (memory-triggered, seeded, bounded, reduced-motion-off, graceful no-op). ✅ **LIVE** (`v2026.06.25-0331`, 35 static cutouts — person/skeleton/face/woman/sculpture/muscle…). SAM 2 returns 3 candidate masks/box → keep largest-area. **Phase 3 LIVE** (`v2026.06.25-0434`, 44 entitySprites = 35 static + 9 ANIMATED: bagpipe/baseball-player/barge/car/bed/sign/letter… tracked across 11–12 frames). `embed/sprite_clips.py` (SAM 2 VIDEO: condition frame-0 box → `propagate_in_video_iterator` → union-box crop → grid sprite-SHEET PNG); `EntitySprite.frames/cols/fps`; `SpriteField` cycles sheet UVs so the figure MOVES as it recurs. Smoke-tested live. |

## Wake-mode tuning surface (where to nudge the live feel)

All wake-mode; all deterministic (constants/thresholds + dt/clock-driven, no new RNG draws). Current
values after the 2026-06-23 polish:

- **Pacing / cadence** — `dream/conductor.ts` `wakeTick` swap interval
  `(0.4 + (1 - intensity) * 1.6) / max(0.5, tempoMul)`, **×2 when `s.inTrough`** (lucid moments
  linger). Faster as intensity rises.
- **Lucid moments (coherence troughs)** — `dream/intensity.ts`: `TROUGH_MIN_GAP 14`,
  `TROUGH_MAX_GAP 30`, `TROUGH_DUR 4.0`, `TROUGH_RAMP 1.0` (more frequent + longer than the original
  22–46 s / 2 s). Trough kind split is 50% rhyme / 40% lucid / 10% phrase (`dream/coherence.ts`).
- **Video frequency** — `dream/dreamwalker.ts` `TYPE_WEIGHTS = { video: 7.0 }` (multiplies the
  pre-softmax weight; ~11% of the pool → majority of picks).
- **Video linger + visibility** — `conductor.ts` `swapWakeLayer` sets `slotHeldUntil[slot] =
  clock + (inTrough ? 13 : 9)`; `pickSwapSlot` (`dream/slotHold.ts`) skips held slots; held slots
  are **pinned visible** via `LayerStack.applyPlan(plan, pinnedSlots)` (pinned non-hero forced to
  ≥0.72 opacity). Concurrent decoders capped at 3 (`render/Compositor.ts` `VideoPool`).
- **Distortion** — `dream/filterDirector.ts` strength scale `(0.10 + 0.32 * intensity)`,
  `TROUGH_EASE 0.08`; `capDistortion` clamps the two geometry-manglers (`kaleidoscope ≤ 0.3`,
  `liquid ≤ 0.45`); film warp `conductor.ts` `min(1, intensity² * 0.3)`.
- **Feedback "breathing" echo-trail** — `render/LayerStack.ts` `fbMat.opacity = feedbackTrail * 0.55`.
- **Old-TV grade / flicker** — `conductor.ts` `baseWakeFilm()` (vignette 0.16, grain 0.06, sepia
  0.08, scanline 0.02, desat 0.08, halation 0.05, haze 0.03, **flicker 0.02**); `filmGrade
  0.38 - intensity*0.25`; `bloom 0.10 + intensity*0.18`. Flicker math is in `render/postfx.ts`.
- **Layer-swap blending** — swaps cross-fade over ~0.3 s via `LayerStack.update(dt)` +
  `fadeTarget`/`fadeOpacity` (no more hard cuts).
- **On-screen text frequency** — `dreamwalker.ts` `pCard = 0.02 + (lastLeaped ? 0.05 : 0) +
  surreality*0.03`; phrase-trough threshold `coherence.ts` `0.9`.
- **Curation cutoffs** — `dream`/pipeline: image `DEFAULT_CUTOFF 0.52`, **video `VIDEO_CUTOFF 0.45`**
  (`pipeline/embed/curate.py`).

## What's left to do

### Open at end of the 2026-06-25 session (start here)
- **Photosensitivity — content flashes** (the one safety gate still open): the runtime flash governor
  caps brightness/exposure strobing, but rapid hard CUTS between high-contrast *media* aren't caught.
  Fix: an offline FFmpeg `vf_photosensitivity` per-clip score baked into the manifest, and/or a runtime
  swap-rate cap at high intensity (determinism-safe). Details below under "Immediate".
- **Verify the memory system feels right in the live app** — recurrence (`dream/memory.ts` constants:
  `decay`/`cap`/`RECUR_COUPLING`) and sprite summoning (`conductor.ts` `SPRITE_SUMMON_PROB`/
  `SPRITE_MIN_WEIGHT`/`SPRITE_COOLDOWN_S`, `SpriteField` opacity/scale) are tuned blind; watch a few
  live dreams and adjust. All are pure constants — no reship needed.
- ✅ **Coverage backfill** (2026-06-29) — `embed.shots --only-missing` and `embed.entities --only-missing`
  recovered shots **22 → 31/37** and entities **270 → 280/281**; sprite deepen took the pool **44 → 62**.
  **Still unrecoverable** (dead / cut-less archive.org URLs): 6 videos lack `shots[]` (vid-0022/0026/
  0030/0031/0033/0036), 1 lacks `entities[]` (vid-0028). Re-source those media to close them.
- ✅ **PD-poetry ingest** (2026-06-29, `embed.poetry`) — +100 lines shipped. Extending it (more poets,
  more lines via `--count`) is a clean follow-up; the augment tools now tolerate any corpus dim (PR #54).
- ✅ **so400m SigLIP 2** (2026-06-29) — corpus is now 1152-d. Re-running needs the copy-mode download
  workaround on this Windows box (see the session headline's operational notes).
- **More animated sprites** — the deepen only added 3 (most videos' first entity is abstract and
  Grounding DINO can't box it). A smarter `_pick_video_targets` (try several entities per video, prefer
  concrete nouns) would raise the animated count.

### Immediate / decisions for the owner
- ✅ **Wake mode flipped default-ON** (2026-06-23). `app/src/state/url.ts` `readShareState` now
  defaults `wake` to `true` unless `?wake=0` / `?wake=false`. Unit test updated (`url.test.ts`); the
  smoke spec now covers classic via `?wake=0` and wake as the bare-`/` default.
- ✅ **Photosensitivity — runtime flash-rate governor** (`render/flashGuard.ts`, wired in `postfx.ts`).
  Caps rapid full-frame brightness oscillation on the (non-deterministic) brightness + exposure path
  to a WCAG 2.3.1-style rate: ≤3 flash onsets/sec generally, ≤1/sec + tight ceiling under
  prefers-reduced-motion (engaged via `Gate.tsx` matchMedia). A single dramatic flash still passes;
  only strobing is suppressed. Always-on (general cap is the constructor default). Pure + unit-tested
  (`tests/unit/flashGuard.test.ts`). Reduced-motion also already routes transitions to the gentle
  no-cut set and clamps intensity to 0.45.
  - ⬜ **Still open — content flashes:** rapid hard CUTS between high-contrast *media* frames during a
    frenzy aren't caught by the brightness governor (they're image content, not a brightness multiplier).
    Two complementary fixes remain: (a) an offline FFmpeg `vf_photosensitivity` pass baking a per-clip
    flash-risk score into the manifest (operational reship), and (b) optionally a runtime swap-rate cap
    during high intensity (determinism-safe — timing may vary, sequence preserved). A framebuffer
    luminance sampler (PEAT-style) is the robust-but-perf-costly alternative; deferred for the `readPixels` stall.

### Emotion taxonomy — status (✅ WIRED 2026-06-24)
The 12-axis mood vector exists end-to-end (offline → manifest → runtime types) AND now drives the
runtime: visuals, audio, and text all react to all twelve axes (see the TL;DR "12-axis wiring" bullet
for the per-file map). `FILTER_AXES` is now `MOOD_AXES` (all twelve), `bedParamsFor` reads all twelve,
the CLAP walk + text/card picks bias on `moodAffinity`, and whispers/title-cards tint by the blend.
Helpers in `dream/mood.ts`: `dominantAxes(mood, k)`, `blendMoods(moods, weights)`, `moodAffinity(a, b)`.

**Live R2 corpus remooded to 12 axes (✅ 2026-06-24, `v2026.06.24-1859`).** Every visual/text/audio
asset now carries moods on all twelve axes (re-projected from the existing CLIP/CLAP embeddings — no
media re-download), so the six new axes drive the live runtime, not just the dev seed. To re-run the
remood (e.g. after a corpus change) use the **remood tool** (no media re-download):
```bash
cd pipeline   # needs CLIP + CLAP backends; ffmpeg on PATH for the transformers CLAP path
python -m embed.remood_manifest --out out                 # fetch live manifest, re-project to 12 axes
cd ../app && npx tsx scripts/validate-manifest.ts ../pipeline/out/manifest.json
cd ../pipeline && R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… \
  R2_BUCKET=dreamreel-media R2_PUBLIC_BASE=https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev \
  python -m embed.remood_manifest --upload               # manifest-only upload; media URLs untouched
```
Real CLIP/CLAP projections are subtle (per-axis spread ≈ ±0.05–0.08 around 0.5, same scale as the
original six), which is what the `moodAffinity` / `d(axis)=mood-0.5` bias math expects.
(The committed dev seed `app/public/manifest.seed.json` is already 12-axis.)

### Round 4 — Video (✅ SHIPPED, content-aware frames)
Pipeline: a video is sourced by sampling several interior frames and using CLIP to pick the one
**least like a title card / studio logo / archival notice** (`pipeline/embed/frame_selector.py` —
`build_avoid_vector` + `select_best_frame`); that chosen timestamp drives BOTH the embedding poster
AND the clip start (threaded download → `fetched_videos.jsonl` `clip_start_seconds` → manifest
internal `_clipStart` → `publish/transcode_video` `-ss`, stripped before R2). Degrades gracefully to a
single ~30% frame (`pipeline/embed/clip_window.py` `clip_start_seconds`/`probe_duration`) when CLIP
text-scoring or ffprobe is unavailable. Renderer: `render/videoTexture.ts` (`loadVideoTexture`,
muted/looping/fail-safe) + `render/VideoPool.ts` (cap 3, restart-at-0, reduced-motion freeze, pauses
on dream-pause, dispose-driven teardown) + `Compositor.showVideo` + conductor `video` branch (wake
**and** classic). Muted/visual-only — film audio is round 5. **Live: v`2026.06.23-0359`, 40 clips**;
the 0.45 cutoff kept all 40. Specs/plans: `docs/superpowers/specs/2026-06-22-round4-video-design.md`,
`…/plans/2026-06-22-round4-video.md`, plus the polish round
`…/specs/2026-06-23-wake-pacing-restraint-design.md`, `…/plans/2026-06-23-wake-pacing-restraint.md`,
and `…/plans/2026-06-23-wake-polish-r4.md`.

### Round 5 — Sampled audio (✅ SHIPPED)
Sampled sound (music / voice / foley) is a first-class medium alongside the synth bed. A second
Infinite-Jukebox walk runs in **CLAP** embedding space (`dream/audioWalker.ts`, seeded `seed+":audio"`),
**text-bridge-coupled** to the on-screen visual: every visual asset carries a precomputed `claptext`
CLAP-text vector, and each audio pick's softmax is biased toward audio whose CLAP embedding aligns with
the current logical visual's `claptext` (so sound relates to image). Picks are mixed over the synth bed
by `audio/mixer.ts` — a Tone bus graph (music/foley/voice/film-clip buses) with pure ducking math
(`audio/ducking.ts`, voice ≈ film-clip > music > foley > bed) and a bounded `audio/AudioPool.ts`
(cap 3). The mixer is built lazily in `conductor.play()` (needs the engine's Tone master, which only
exists after `audio.start()`), gated on a non-empty `audio[]`. Film clips now ship **with** their
native soundtrack (`publish/transcode.transcode_video_with_audio`, no `-an`), ducked in when a clip is
the hero. **Determinism:** audio picks fire on **logical visual beats** via the pure
`dream/audioCadence.ts` accumulator (NOT wall-clock dt) — so the audio asset *sequence* is a pure
function of the seed (a unit test compares two dt chunkings). 141 vitest + e2e + 83 pytest green.

### Musical pacing — librosa tempo + energy (✅ code done 2026-06-24)
The decision after surveying a batch of candidate repos (PySceneDetect, TransNetV2, OpenTimelineIO,
OpenMontage, ImageBind, ink, Harlowe, Hydra, gl-transitions, allmaps, MapLibre, librosa). **Rejected
on the hard license rule:** ImageBind (CC-BY-**NC** weights) and Hydra (**AGPL** — CLAUDE.md already
flags it "inspiration only"). Deferred the clean-but-lower-leverage ones (clip-quality detectors,
narrative engines, live maps). **Chose librosa (ISC)** — pipeline-only, zero runtime bundle weight,
and it closes the loop where the visuals drove the audio but the audio never shaped the dream's timing.
- **Offline:** `pipeline/audio/tempo.py` `analyze_audio(path)` → `{bpm?, energy}` (tempo via
  `librosa.beat.beat_track`, octave-folded into a 50–200 musical band; energy = normalized mean RMS
  0..1). librosa is **lazy-imported** and lives behind the optional `audio` extra, so CI (core deps
  only) and the license/manifest tests never need it. Wired into `audio/build_audio.build_audio_assets`
  for fresh builds; standalone `audio/add_tempo.py` enriches an already-shipped manifest by downloading
  each clip (no media re-transcode) and can upload **manifest-only** to R2 (mirrors `embed.remood_manifest`).
- **Manifest:** `AudioAsset` gains optional `bpm?`/`energy?` (`types.ts` + zod `schema.ts`). Absent on
  legacy manifests → graceful no-op.
- **Runtime (all in `dream/audioWalker.ts`, pure + seed-deterministic):** `musicalDwellMs(baseMs, bpm)`
  snaps each clip's dwell to a whole number of bars (4 beats), so clip swaps land on a musical boundary
  (the dwell feeds `audioCadence.commitPick`, which sets WHEN the next clip swaps); an `energy×arousal`
  pre-softmax term (`audioArousal(mood)` = high-arousal axes minus calm ones) leans selection toward
  louder clips in excited moods, gentler ones when calm. Both vanish when the field/mood is absent, so
  existing determinism tests are byte-identical. Tests: `audioWalker.test.ts` (+4), `tests/test_tempo.py`.
- **⬜ Live reship needed:** the R2 audio (`v2026.06.24-1859`) has no bpm/energy yet, so the feature is
  dormant in prod until an `add_tempo` reship (`python -m audio.add_tempo --out out_tempo`, then
  `--upload` with R2 env). Needs the `audio` extra (`pip install librosa soundfile`) + ffmpeg on PATH.

**CLAP embedding reality:** `laion_clap` won't build on Python 3.13, so the corpus pass uses
HuggingFace **`transformers`** CLAP (`laion/clap-htsat-unfused`, 512-d) via the operational-only
`pipeline/audio/clap_transformers.py` (audio decoded ffmpeg→48 kHz wav→soundfile; verified semantic).
The unit-tested `pipeline/audio/clap_backend.py` stays `laion_clap`-or-hash so CI needs no model.

**Corpus build/reship (operational, from `pipeline/`, ffmpeg on PATH):**
```bash
# 1. fetch PD audio (Archive.org: Great 78 / LibriVox / NASA), trim per-kind w/ intro-skip,
#    real-CLAP embed audio + claptext for every visual asset, AUGMENT the live manifest in place
python -m audio.build_corpus --manifest out/manifest.json --out out --music 20 --voice 15 --foley 15
# (review out/manifest.json — drop any objectionable PD items; a Nazi-anthem 78 was removed by hand)
# 2. validate against the app's zod loader
cd ../app && npx tsx scripts/validate-manifest.ts ../pipeline/out/manifest.json
# 3. upload ONLY the new audio + the augmented manifest (visual media on R2 untouched)
cd ../pipeline && R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… \
  R2_BUCKET=dreamreel-media R2_PUBLIC_BASE=https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev \
  python -m audio.ship_corpus --manifest out/manifest.json --out out
```
`build_corpus.py` augments the existing manifest (keeps every visual asset's exact embedding + R2 src,
only adds `audio[]` + `audioEmbeddingDim` + per-asset `claptext`); `ship_corpus.py` uploads just the
44 audio `.m4a` (content-type `audio/mp4`) and pushes `manifest.<version>.json` + `latest.json`,
popping internal `_local`.

**Deferred (non-blocking):** *bed-under-samples ducking is a documented no-op* — the mixer's `bed`
bus carries no source (the synth engine's bed isn't rerouted through it), so `busGainsDb`'s bed trim is
inert. Wiring it needs an engine bed sub-bus; voice/film-clip-over-music/foley ducking + the master
sound mute all work. Per-kind UI toggles, beat-sync, and a coupling-strength URL knob were YAGNI'd.

### Known deferred Minors (non-blocking, from reviews)
- ✅ **Held-clip swap-frame lag** — FIXED (2026-06-23). `wakeTick` now runs the discrete events
  (coherence trough + layer swap) BEFORE `stack.update(dt)`/`captureFeedback`, so a freshly-set fade
  target eases the same frame instead of one late. The two `walker.next()` calls (coherence text →
  swap image) keep their order, so the deterministic sequence is unchanged.
- ✅ **`LayerStack.resize()` not wired** — FIXED (2026-06-23). `Compositor` now exposes
  `addResizeListener()` (a multi-listener mirror of `addFrameListener`, alongside the single-slot
  `onResize` held by post-FX); `LayerStack` registers in its constructor and unsubscribes on dispose,
  so its feedback render targets track window resize. Covered by a new vitest in `layerFade.test.ts`.
- ✅ **Stale "Task N" / "prompt N" comments** — FIXED (2026-06-23): scrubbed the build-order
  references in `render/LayerStack.ts`, `render/Compositor.ts`, `render/filmParams.ts`, `audio/engine.ts`.
- `frame_selector` leaves candidate frames in `out/posters/_cand` (one-shot offline pipeline; harmless).

## Architecture pointers

- **The brain (pure, seeded, unit-tested):** `dream/intensity.ts` (heartbeat + troughs),
  `dream/coherence.ts` (trough kinds), `dream/layerPlan.ts` (density bands), `dream/filterDirector.ts`
  (mood→filter strengths + `capDistortion`; reacts to `FILTER_AXES` = the original six),
  `dream/mood.ts` (12-axis `projectMood`/`blankMood` + `dominantAxes`/`blendMoods` helpers),
  `dream/seedParams.ts` (seed→surreality/tempo), `dream/dreamwalker.ts` (embedding walk +
  `TYPE_WEIGHTS`), `dream/slotHold.ts` (`pickSwapSlot`). No `Math.random` in the dream path.
- **The renderer:** `render/LayerStack.ts` (N-layer feedback compositor; cross-fade `update(dt)` +
  pinned-slot visibility), `render/videoTexture.ts` + `render/VideoPool.ts` (video), `render/DreamFilter.ts`
  (5 fragment filters), `render/postfx.ts` (EffectComposer: DreamFilter → FilmEffect grade → bloom →
  chroma; flicker), `render/filmParams.ts` (FilmParams), `render/Compositor.ts` (single rAF loop).
- **The audio medium (round 5):** `dream/audioWalker.ts` (CLAP jukebox walk + text-bridge bias +
  per-kind `TYPE_WEIGHTS`, pure/seeded), `dream/audioCadence.ts` (pure logical-beat pick cadence —
  the determinism guard), `audio/mixer.ts` (Tone bus graph + ducking + film-clip routing, built lazily
  in `play()`), `audio/ducking.ts` (pure dB policy), `audio/AudioPool.ts` (bounded decoders), over the
  existing `audio/engine.ts` synth bed. Conductor advances the walk in both `imageBeat()` (classic) and
  `swapWakeLayer()` (wake), reading that beat's `claptext`.
- **The integration:** `dream/conductor.ts` — `wakeTick(dt)` drives everything each frame from the
  intensity sample + mood; `swapWakeLayer` does the layer swaps + video holds; the classic 3-clock
  path is untouched and runs when `wake` is off.
- **The pipeline:** `pipeline/ingest/` (Openverse + Wellcome + Met/Smithsonian + Archive.org, license
  gate), `pipeline/embed/` (CLIP via `clip_backend`, `download` images+videos, `frame_selector` +
  `clip_window` for video frames, `curate`, `build_manifest`), `pipeline/audio/` (CLAP backend +
  hash-fallback `clap_backend` / transformers `clap_transformers`, `transcode_audio`, license-gated
  `ingest`, `build_audio` + `claptext`, operational `build_corpus`/`ship_corpus`), `pipeline/publish/`
  (transcode webp/mp4 + film-clip-with-audio mp4, upload to R2, strip internal `_local`/`_clipStart`,
  rewrite `src` to CDN).
- **Determinism contract:** same `?seed` → same asset/text/coherence **sequence** (timing + cosmetic
  recipe may vary). The video weight is a deterministic scalar; holds/fades are clock/dt-driven.
- Specs + plans: `docs/superpowers/specs/` and `docs/superpowers/plans/` (one pair per round).

## How to run / verify

- **See wake mode (deployed):** `https://dreamreel.pages.dev/?wake=1`, or a branch preview like
  `https://<branch-with-dashes>.dreamreel.pages.dev/?wake=1`.
- **Local with real media:**
  ```bash
  cd app
  npm run dev:proxy  # second terminal when manifests include archive.org video URLs
  VITE_MANIFEST_URL="https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json" npm run build
  npm run preview -- --port 4173 --strictPort
  # open http://localhost:4173/?wake=1
  ```
- **Local dev video CORS gotcha:** archive.org does not provide the CORS headers WebGL needs for
  `crossOrigin="anonymous"` video/image textures. Vite dev rewrites archive.org `src` values through
  `app/src/manifest/archiveProxy.ts`; run `.devproxy/proxy.mjs` via `npm run dev:proxy` before
  deciding video is broken locally. Preview/production builds do not use this local proxy, so shipped
  manifests should point at CORS-clean R2/CDN media or a deployed equivalent proxy/worker.
- **Tests:** `cd app && npm run test` (vitest, ~141), `npm run typecheck` (**`tsc -b --noEmit`** — the
  build-mode typecheck; plain `tsc -p` misses project-reference errors), `npm run lint`,
  `npm run test:e2e` (Playwright smoke; covers `?wake=1` and now constructs the audio mixer via a silent
  data-URI foley in the dev seed). Pipeline: `cd pipeline && python -m pytest -q` (~83).
- **⚠️ Smoke gotcha:** Playwright's `reuseExistingServer` will reuse a stale `npm run preview` on
  **port 4173** and silently test an OLD build (false-green). Kill any process on 4173 before
  `npm run test:e2e` (a real run rebuilds and takes ~60s; a <15s run reused a stale server).
- **⚠️ Pipeline test:** `pipeline/tests/test_carry_through.py` fails LOCALLY if `torch` is installed
  (the real CLIP embedder can't decode the test's fake jpg). CI's torch-less venv passes. Run the
  suite as `python -m pytest -q -k "not carry_through"` locally. Not a bug.
- **⚠️ ffmpeg/ffprobe required** for the video AND audio pipeline (poster frames + transcode + audio
  trim/decode). Not always on PATH; on Windows it was installed via `winget install Gyan.FFmpeg` and
  lives under `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-*\bin` — prepend to PATH.
- **⚠️ Audio corpus deps:** `audio.build_corpus` needs `transformers` + `soundfile` (real CLAP) and
  `audio.ship_corpus` needs `boto3`. `pip install transformers soundfile boto3`. First CLAP use
  downloads the `laion/clap-htsat-unfused` checkpoint (~600 MB). Runtime needs none of this — all
  embeddings ship precomputed in the manifest.
- Round 5 spec/plan: `docs/superpowers/specs/2026-06-22-round5-audio-design.md`,
  `docs/superpowers/plans/2026-06-22-round5-audio.md`.

## Rebuild the corpus + re-upload to R2

The downloaded films/images are cached under `pipeline/out/` (and `out/candidates.jsonl` from ingest),
so a re-pick/re-embed/re-ship does NOT need to re-ingest:

```bash
cd pipeline
export PATH="<ffmpeg-bin>:$PATH"
# R2 env: R2_ACCOUNT_ID, R2_BUCKET, R2_PUBLIC_BASE (non-secret, below) + R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
python -m embed.download --candidates out/candidates.jsonl --out out   # re-pick video frames; images/films cached
python -m embed.build_manifest --out out                              # re-embed (images stable, videos from new frames)
python -m publish.run --out out --upload                              # transcode + upload + rewrite src + strip internal keys
```

A full fresh build (re-ingest included) is `make corpus` then `make corpus UPLOAD=1` with the R2 env.
The R2 endpoint is derived from `R2_ACCOUNT_ID` (there is no `R2_ENDPOINT_URL`). Non-secret vars:
`R2_ACCOUNT_ID=e1377b90aa5f91b18522fc40df57afc3`, `R2_BUCKET=dreamreel-media`,
`R2_PUBLIC_BASE=https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev`. The two API keys are secret
(create an R2 API token with Object Read & Write in the Cloudflare dashboard; the secret is shown once).

## Infra / accounts

- GitHub: `zgbrenner/dreamreel`. CI = `.github/workflows/ci.yml` (app typecheck/lint/vitest/build/
  license-scan; pipeline pytest + license gate; manifest-contract validates pipeline output against the
  app's zod loader). Cloudflare Pages deploys via Git integration (production on `main` + per-PR
  previews); NO deploy GitHub Action. Playwright smoke runs in CI on `main`.
- Cloudflare: Pages project `dreamreel`; R2 bucket `dreamreel-media` (public r2.dev URL, CORS allow
  GET `*`, not publicly writable; custom domain not set up — swap `R2_PUBLIC_BASE` if one is added).

---

## Appendix — earlier-round history

### Rounds 1 & 2 build notes (history)
1. **Media → R2 publish pipeline** (PR #13): builds web derivatives, correlates `asset.id`→local file,
   uploads to R2, rewrites `asset.src` to CDN URLs. Offline tests with mocked boto3.
2. **Round 6/3 — Wake chaos engine** (PR #14): the seeded intensity signal + `LayerStack` compositor +
   coherence troughs. Behind `?wake=1`.
3. **Round 2 — Mood-mapped filter catalog** (PR #15): 6 filters by dominant CLIP mood axis, strength
   scaled by the intensity heartbeat, eased at coherence. Identity (no filter) by default.

### Round 1 corpus — uncanny re-curation (shipped 2026-06-18, PR #16)
Retargeted the offline pipeline at a genuinely uncanny corpus. Shared theme catalog
(`pipeline/ingest/themes.py`): `CLINICAL` / `OCCULT` / `LIMINAL` veins + `ANCHOR_THEMES` (always
kept). New **Wellcome Collection** ingester (`pipeline/ingest/wellcome.py`); Met + Smithsonian +
Wellcome on by default. Mood-score curation (`pipeline/embed/curate.py`) drops images whose
`max(uncanny, ominous) < 0.52` (anchors exempt). First uncanny corpus shipped as v`2026.06.18-2208`
(223 images); superseded by the current v`2026.06.23-0359` build (277 images + 40 video clips).
Under-returning veins to deepen later (optional): alchemical diagram, spirit photography, specimen,
deep-sea creature — thin in Openverse/museum APIs; add synonyms or target an Archive.org collection.
