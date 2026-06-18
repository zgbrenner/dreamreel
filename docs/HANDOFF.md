# DREAMREEL — Handoff / Pick-Up Doc

_Last updated: 2026-06-17. Read this first when resuming._

## TL;DR — where we are

DREAMREEL is being redesigned from a tasteful old-film reel into a **chaotic, fluid, multi-modal,
Finnegans-Wake-style stream of consciousness**. The redesign is a 6-round roadmap. **Rounds 1 and 2
are built, reviewed, and merged to `main`** (default-OFF, opt-in via `?wake=1`, so the live default
experience is unchanged). The media pipeline now uploads a real corpus to Cloudflare R2 and the app
is wired to it.

- Live app: **https://dreamreel.pages.dev** (classic reel by default; add **`?wake=1`** to see the
  new engine).
- Production manifest: `VITE_MANIFEST_URL` on Cloudflare Pages (prod **and** preview) →
  `https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json` (135 real CLIP-embedded
  public-domain images on R2).

## What's been done this session

1. **Media → R2 publish pipeline** (PR #13, merged to main earlier): closed the stubbed
   `publish/run.py` upload — builds web derivatives, correlates `asset.id`→local file, uploads to R2,
   rewrites `asset.src` to CDN URLs. Offline tests with mocked boto3.
2. **Real corpus shipped to R2**: ran the first real ingest (Openverse + Archive.org, 135 ship-safe
   CC0/PD/CC-BY images), CLIP-embedded (ViT-B/32, dim 512), uploaded the `.webp` derivatives +
   `manifest/latest.json` to the `dreamreel-media` bucket (public r2.dev URL, CORS `*`, not publicly
   writable). Set `VITE_MANIFEST_URL` on Pages (prod + preview) and verified load/play.
3. **Round 1 — Wake chaos engine** (`feat/wake-chaos-engine`, PR #14): a single seeded **intensity**
   signal drives sporadic-fast layer-swaps, breathing N-layer density (the `LayerStack` compositor),
   and rare **coherence troughs** (50% thematic-rhyme / 35% lucid-image / 15% legible-phrase).
   Deterministic per `?seed`. Behind `?wake=1`, default-off.
4. **Round 2 — Mood-mapped filter catalog** (`feat/dream-filters`, this round): 6 filters chosen by
   the dominant CLIP **mood axis**, strength scaled by the intensity heartbeat, eased off at coherence.
   Filters: kaleidoscope, liquid warp, solarize, melt, posterize, and feedback echo-trails (which
   completes round 1's deferred render-to-target). Default-0 = identity, so classic is unchanged.

## Round 1 corpus — uncanny re-curation (machinery done, owner runs rebuild+upload)

Tasks 1–7 (branch `feat/uncanny-corpus`) re-targeted the offline pipeline toward a genuinely
uncanny corpus. **The pipeline code is complete and merged; the owner must run the rebuild+upload
once torch + R2 credentials are available.**

### What was built

- **Shared uncanny theme catalog** (`pipeline/ingest/themes.py`): 3 veins — `CLINICAL`
  (anatomical, dissection, skeleton, x-ray, specimen, phrenology, taxidermy), `OCCULT` (death
  mask, memento mori, occult symbol, alchemical, spirit photography, ritual mask), `LIMINAL`
  (deep sea, fungus, cave, decay, moth, abandoned) — plus 3 `ANCHOR_THEMES` (ruins, faces,
  antique photograph) kept for dream-logic contrast.
- **Retargeted ingesters**: Openverse + museums now query the uncanny theme list. A new **Wellcome
  Collection** ingester (`pipeline/ingest/wellcome.py`) pulls from the IIIF/search API. Museums
  (Met + Smithsonian) and Wellcome are **on by default** in `ingest/run.py`.
- **Mood-score curation filter** (`pipeline/embed/curate.py`): drops image assets whose
  `max(uncanny, ominous) < DEFAULT_CUTOFF` (0.55). Anchors are always kept regardless of score.
  The cutoff is a tuning knob — lower it to widen the net; raise it to tighten.
- **Live-ingest verification** (Task 7, 2026-06-18): ran
  `python -m ingest.run --out /tmp/uncanny-check --no-archive --per-theme 6`.
  Result: **713 candidates kept, 65 rejected** (30 non-commercial/restricted inc, 19 CC-BY without
  attribution, 16 CC-BY-NC). Source mix: Wellcome 439 / Openverse 209 / Met 65. All licenses are
  in {CC0, PD, CC-BY, CC-BY-2.0, CC-BY-3.0, CC-BY-4.0} — ship-safe. Spot-checked Flickr,
  Wikipedia, Wellcome IIIF, and Met image URLs: all returned HTTP 200.

### Under-returning veins (query-tuning follow-up)

With `--per-theme 6`, the weakest themes were: **alchemical diagram** (5), **spirit photography**
(6), **specimen** (7), **deep sea creature** (9). These are thin in Openverse and the museums'
search APIs. Consider: adding synonyms (`alchemical manuscript`, `ghost photograph`, `marine
specimen`, `deep-sea fish`) or targeting an Archive.org collection directly. Not a blocker —
the three anchor themes and the high-returning CLINICAL veins provide a solid core.

### To ship — owner runs rebuild+upload

```bash
# 1. Install embed + publish extras (requires torch + open_clip + boto3)
cd pipeline && pip install -e '.[embed,publish]'

# 2. Run the full build + upload (set R2_* env vars first)
export R2_BUCKET=dreamreel-media
export R2_ACCESS_KEY_ID=<your-key>
export R2_SECRET_ACCESS_KEY=<your-secret>
export R2_ENDPOINT_URL=https://<account-id>.r2.cloudflarestorage.com
make corpus UPLOAD=1

# Or, if using wrangler instead of boto3:
#   wrangler r2 object put dreamreel-media/media/<name>.webp --file ... --remote
#   wrangler r2 object put dreamreel-media/manifest/latest.json --file ... --remote

# 3. Verify: open https://dreamreel.pages.dev/?wake=1 and confirm new uncanny imagery loads.
```

The curation log line in `embed/build_manifest.py` will report kept/dropped counts (no silent
truncation). Adjust `DEFAULT_CUTOFF` in `embed/curate.py` (currently 0.55) if the resulting
corpus is too sparse or too broad.

## The 6-round roadmap

| # | Work-stream | Status |
|---|-------------|--------|
| 6 | **Chaos engine + rare coherence** | ✅ Round 1 (merged) |
| 3 | **Fluid dense layering** | ✅ folded into Round 1 (LayerStack) |
| 2 | **Dream-filter catalog (not one old-TV look)** | ✅ Round 2 (merged) |
| 4 | **Moving image (video)** | ⬜ not started |
| 5 | **Spoken-word / "audiobook" voices** | ⬜ not started |
| 1 | **Weirder/scarier corpus** | ✅ machinery built (owner runs rebuild+upload) |
| — | **Photosensitivity hardening** | ⬜ deferred (clamp seam exists in `IntensityEngine`) |

## What's left to do

### Immediate / decisions for the owner
- **Flip wake mode default-ON** once happy with the look. One line in `app/src/state/url.ts`
  (`readShareState`): default `wake` to `true` unless `?wake=0`. Add a test. We kept it opt-in
  pending a human visual + tuning pass — it has NOT been formally signed off as the production default.
- **Tuning** (all against the live `?wake=1` reel): intensity cadence/spikiness (`dream/intensity.ts`
  `TROUGH_*`), layer density caps (`dream/layerPlan.ts`), filter strength + crossfade sharpness
  (`dream/filterDirector.ts` `SHARPEN`, `TROUGH_EASE`), feedback trail opacity
  (`render/LayerStack.ts` `feedbackTrail * 0.85`), and the wake film floor (`conductor.ts`
  `baseWakeFilm`, `wakeTick` filmGrade/bloom/chroma).
- **New dream-text → production**: round-2 added ~16 drift lines + 4 intertitles to
  `pipeline/embed/embed_texts.py`. They reach production only after a corpus rebuild + R2 re-upload
  (see "Rebuild the corpus" below).

### Remaining rounds (each = its own brainstorm → spec → plan → build)
- **Round 4 — Video**: build a `THREE.VideoTexture` path in the renderer (the LayerStack can host it)
  + a video transcode/upload path in `pipeline/publish` (`transcode_video` exists but nothing fetches
  videos yet; **ffmpeg required**, not currently on PATH). ~46 Archive.org films are already in the
  ingest candidates but were skipped (download fetches images only).
- **Round 5 — Spoken-word voices**: a new sampled-audio subsystem (`Tone.Player`) layered over the
  generative bed in `audio/`, + audio ingest + determinism handling. Today `audio/engine.ts` is 100%
  synth with no sampled-playback path.
- **Round 1 (corpus) — Weirder/scarier**: re-ingest a genuinely uncanny public-domain corpus
  (anatomical plates, masks, decay, deep-sea, occult ephemera) instead of pretty scenery. Mostly
  `pipeline/ingest` curation; no app changes.
- **Photosensitivity hardening**: a real safety pass. The seam is already there — `IntensityEngine`
  has a single `setMaxIntensity` clamp point; reduced-motion already clamps to 0.45. Needs a proper
  strobe/flash-rate cap + possibly a warning gate before going default-on publicly.

### Known deferred Minors (non-blocking, from reviews)
- Feedback trail uses the previous frame's strength (1-frame sub-frame lag) — reorder the
  `filterStrengths` block above `captureFeedback` in `conductor.wakeTick` to fix.
- `LayerStack.resize()` is never wired to window resize (feedback targets stay at initial size).
- Wake-mode title cards reuse a single `textCardTex` (benign re-upload if two card slots coincide).
- A couple of stale "Task N" comments may remain in `render/*` — cosmetic.

## Architecture pointers (round 1 + 2)

- **The brain (pure, seeded, unit-tested):** `dream/intensity.ts` (heartbeat + troughs),
  `dream/coherence.ts` (50/35/15), `dream/layerPlan.ts` (density bands), `dream/filterDirector.ts`
  (mood→filter strengths). All deterministic functions; no `Math.random` in the dream path.
- **The renderer:** `render/LayerStack.ts` (N-layer feedback compositor), `render/DreamFilter.ts`
  (5 fragment filters by strength), `render/postfx.ts` (EffectComposer: DreamFilter → FilmEffect grade
  → bloom → chroma), `render/Compositor.ts` (single rAF loop).
- **The integration:** `dream/conductor.ts` — `wakeTick()` drives everything each frame from the
  intensity sample + mood; the classic 3-clock path is untouched and runs when `wake` is off.
- **Determinism contract:** same `?seed` → same asset/text/coherence sequence (timing + cosmetic
  recipe may vary). Mood drives filters; intensity drives density/strength; both are seeded.
- Specs + plans: `docs/superpowers/specs/` and `docs/superpowers/plans/` (one pair per round).

## How to run / verify

- **See wake mode (deployed):** `https://dreamreel.pages.dev/?wake=1`, or a branch preview like
  `https://feat-dream-filters.dreamreel.pages.dev/?wake=1`.
- **Local with real media:**
  ```bash
  cd app
  VITE_MANIFEST_URL="https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json" npm run build
  npm run preview -- --port 4173 --strictPort
  # open http://localhost:4173/?wake=1
  ```
- **Tests:** `cd app && npm run test` (vitest, ~92), `npm run typecheck`, `npm run lint`,
  `npm run test:e2e` (Playwright smoke; covers `?wake=1`).
- **⚠️ Smoke gotcha:** Playwright's `reuseExistingServer` will reuse a stale `npm run preview` on
  **port 4173** and silently test an OLD build (false-green). Kill any process on 4173 before
  `npm run test:e2e` (a real run rebuilds and takes ~60s; a <15s run reused a stale server).
- **⚠️ Pipeline test:** `pipeline/tests/test_carry_through.py` fails LOCALLY if `torch` is installed
  (the real CLIP embedder can't decode the test's fake jpg). CI's torch-less venv passes. Not a bug.

## Rebuild the corpus + re-upload to R2

```bash
cd pipeline && pip install -e '.[embed,publish]'   # torch + open_clip + boto3
make corpus                                          # ingest -> download -> embed(CLIP) -> manifest
# Upload: either `make corpus UPLOAD=1` with R2_* env (boto3), OR the wrangler path used this session:
#   wrangler r2 object put dreamreel-media/media/<name>.webp --file ... --remote
#   wrangler r2 object put dreamreel-media/manifest/latest.json --file ... --remote
```
R2 details: account `e1377b90aa5f91b18522fc40df57afc3`, bucket `dreamreel-media`, public base
`https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev`, CORS = allow GET `*`. Creds via env only.

## Infra / accounts

- GitHub: `zgbrenner/dreamreel`. CI = `.github/workflows/ci.yml` (app typecheck/lint/vitest/build/
  license-scan; pipeline pytest + license gate; manifest-contract). Cloudflare Pages deploys via Git
  integration (production on `main` + per-PR previews); NO deploy GitHub Action.
- Cloudflare: Pages project `dreamreel`; R2 bucket `dreamreel-media` (public r2.dev URL, custom domain
  not set up — fine for now, swap `R2_PUBLIC_BASE` if a domain is added later).
