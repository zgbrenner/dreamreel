# DREAMREEL — Handoff / Pick-Up Doc

_Last updated: 2026-06-23. Read this first when resuming._

## TL;DR — where we are

DREAMREEL is being redesigned from a tasteful old-film reel into a **chaotic, fluid, multi-modal,
Finnegans-Wake-style stream of consciousness**, reachable via **`?wake=1`** (the classic reel is
still the default until wake is flipped default-on). The redesign is well advanced — all merged to
`main`:

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

- Live app: **https://dreamreel.pages.dev** (classic by default; add **`?wake=1`** for the new
  engine). **Production deploys from `main`** via Cloudflare Pages Git integration.
- Production manifest: `VITE_MANIFEST_URL` on Cloudflare Pages (prod **and** preview) →
  `https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json`. **Now serving
  v`2026.06.23-0359`: 326 assets — 277 public-domain images + 40 public-domain film clips + 9
  procedural — plus 42 texts.**

## The 6-round roadmap

| # | Work-stream | Status |
|---|-------------|--------|
| 6 | **Chaos engine + rare coherence** | ✅ merged |
| 3 | **Fluid dense layering** | ✅ folded into the chaos engine (LayerStack) |
| 2 | **Dream-filter catalog (not one old-TV look)** | ✅ merged |
| 1 | **Weirder/scarier corpus** | ✅ shipped to R2 (uncanny images) |
| 4 | **Moving image (video)** | ✅ shipped to R2 (40 PD film clips, content-aware frames) |
| — | **Wake pacing + restraint polish** | ✅ merged (PR #20, 2026-06-23) |
| 5 | **Spoken-word / "audiobook" voices** | ⬜ not started |
| — | **Photosensitivity hardening** | ⬜ deferred (clamp seam exists in `IntensityEngine`) |

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

### Immediate / decisions for the owner
- **Flip wake mode default-ON** once happy with the look. One line in `app/src/state/url.ts`
  (`readShareState`): default `wake` to `true` unless `?wake=0`. Add a test. Still opt-in pending the
  owner's sign-off as the production default (the look has been iterated against the live reel but not
  formally flipped).
- **Photosensitivity hardening** before going default-on publicly: `IntensityEngine` has a single
  `setMaxIntensity` clamp (reduced-motion already clamps to 0.45) — needs a proper strobe/flash-rate
  cap + possibly a warning gate. Flicker is now low (0.02 in wake) but this is the remaining safety gate.

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

### Round 5 — Spoken-word voices (⬜ not started)
A new sampled-audio subsystem (`Tone.Player`) layered over the generative bed in `audio/`, + audio
ingest + determinism handling. Today `audio/engine.ts` is 100% synth with no sampled-playback path.
The ~40 Archive.org films already carry soundtracks (currently transcoded muted with `-an`).

### Known deferred Minors (non-blocking, from reviews)
- **Held-clip swap-frame lag**: a swap fires its `applyPlan` after `wakeTick`'s `update(dt)`, so the
  newly-set fade target is eased a frame late (~16 ms, imperceptible). Optional: move the swap check
  above `update(dt)` in `wakeTick`.
- `frame_selector` leaves candidate frames in `out/posters/_cand` (one-shot offline pipeline; harmless).
- `LayerStack.resize()` is not wired to window resize (feedback targets stay at initial size).
- A couple of stale "Task N" comments may remain in `render/*` — cosmetic.

## Architecture pointers

- **The brain (pure, seeded, unit-tested):** `dream/intensity.ts` (heartbeat + troughs),
  `dream/coherence.ts` (trough kinds), `dream/layerPlan.ts` (density bands), `dream/filterDirector.ts`
  (mood→filter strengths + `capDistortion`), `dream/dreamwalker.ts` (embedding walk + `TYPE_WEIGHTS`),
  `dream/slotHold.ts` (`pickSwapSlot`). No `Math.random` in the dream path.
- **The renderer:** `render/LayerStack.ts` (N-layer feedback compositor; cross-fade `update(dt)` +
  pinned-slot visibility), `render/videoTexture.ts` + `render/VideoPool.ts` (video), `render/DreamFilter.ts`
  (5 fragment filters), `render/postfx.ts` (EffectComposer: DreamFilter → FilmEffect grade → bloom →
  chroma; flicker), `render/filmParams.ts` (FilmParams), `render/Compositor.ts` (single rAF loop).
- **The integration:** `dream/conductor.ts` — `wakeTick(dt)` drives everything each frame from the
  intensity sample + mood; `swapWakeLayer` does the layer swaps + video holds; the classic 3-clock
  path is untouched and runs when `wake` is off.
- **The pipeline:** `pipeline/ingest/` (Openverse + Wellcome + Met/Smithsonian + Archive.org, license
  gate), `pipeline/embed/` (CLIP via `clip_backend`, `download` images+videos, `frame_selector` +
  `clip_window` for video frames, `curate`, `build_manifest`), `pipeline/publish/` (transcode webp/mp4,
  upload to R2, strip internal `_local`/`_clipStart`, rewrite `src` to CDN).
- **Determinism contract:** same `?seed` → same asset/text/coherence **sequence** (timing + cosmetic
  recipe may vary). The video weight is a deterministic scalar; holds/fades are clock/dt-driven.
- Specs + plans: `docs/superpowers/specs/` and `docs/superpowers/plans/` (one pair per round).

## How to run / verify

- **See wake mode (deployed):** `https://dreamreel.pages.dev/?wake=1`, or a branch preview like
  `https://<branch-with-dashes>.dreamreel.pages.dev/?wake=1`.
- **Local with real media:**
  ```bash
  cd app
  VITE_MANIFEST_URL="https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json" npm run build
  npm run preview -- --port 4173 --strictPort
  # open http://localhost:4173/?wake=1
  ```
- **Tests:** `cd app && npm run test` (vitest, ~117), `npm run typecheck`, `npm run lint`,
  `npm run test:e2e` (Playwright smoke; covers `?wake=1`).
- **⚠️ Smoke gotcha:** Playwright's `reuseExistingServer` will reuse a stale `npm run preview` on
  **port 4173** and silently test an OLD build (false-green). Kill any process on 4173 before
  `npm run test:e2e` (a real run rebuilds and takes ~60s; a <15s run reused a stale server).
- **⚠️ Pipeline test:** `pipeline/tests/test_carry_through.py` fails LOCALLY if `torch` is installed
  (the real CLIP embedder can't decode the test's fake jpg). CI's torch-less venv passes. Run the
  suite as `python -m pytest -q -k "not carry_through"` locally. Not a bug.
- **⚠️ ffmpeg/ffprobe required** for the video pipeline (poster frames + transcode). Not always on
  PATH; on Windows it was installed via `winget install Gyan.FFmpeg` and lives under
  `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-*\bin` — prepend to PATH for builds.

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
