# Round 4 — Moving Image (Video) — Design

_Date: 2026-06-22. Status: approved, ready for implementation plan._

## Goal

Add moving image (short, muted, looping public-domain video) to DREAMREEL as a first-class
visual asset, played through the same renderer paths as images and selected by the same
embedding-driven dreamwalker. This is round 4 of the 6-round redesign. End state: a rebuilt
corpus containing transcoded film clips is shipped to R2 and visible at
`dreamreel.pages.dev` (classic crossfade and `?wake=1`).

## Decisions (locked during brainstorm)

- **Definition of done:** full end-to-end, shipped to R2 this round (not capability-only).
- **Audio:** muted / visual-only. Film soundtracks are out of scope; sampled audio is round 5.
  Muted also satisfies browser autoplay policy (no user gesture required).
- **Compositing modes:** both classic crossfade **and** wake mode play video.
- **Playback:** on selection, seek to frame 0 and loop while the asset dwells; pause + dispose
  on layer recycle. Start-point is deterministic; intra-clip phase may vary with frame timing.
- **Curation:** videos use a **separate, lower cutoff** (`VIDEO_CUTOFF = 0.45`) distinct from the
  0.52 image cutoff, so the scarce ~46 candidate films are not over-pruned.
- **Approach:** "A — parallel pipeline path + pooled decoders" (see Approaches Considered).

## Non-goals (YAGNI)

- No film audio / soundtrack mixing (round 5).
- No per-frame or temporal-pooled video embedding — a single poster frame supplies the embedding.
- No video in title cards / text pool.
- No new Zustand store fields or URL params.
- No classic-vs-wake behavioral divergence beyond what already exists.

## Context: what already supports video (no changes needed)

- `app/src/manifest/types.ts:22` — `AssetType` already includes `'video'`; `src?: string` already
  documented as "R2 URL for image/video". Field names are frozen (CLAUDE.md); we add no fields to
  the public `Asset` contract.
- `app/src/manifest/schema.ts` — zod schema already accepts `type:'video'` with optional URL `src`
  and a non-empty, dimension-checked `embedding`. No schema change.
- `app/src/dream/dreamwalker.ts` — selection is purely cosine-similarity over `embedding`; it is
  media-agnostic. No change.
- `app/src/state/store.ts` — no per-asset state; no change.
- `.github/workflows/ci.yml` `manifest-contract` job + `app/scripts/validate-manifest.ts` — already
  validate any asset type; video assets must pass the same L2-normalized-embedding check.
- `pipeline/ingest/archive_org.py:56-92` — already yields `Candidate(type="video")` for ~46 films.
- `pipeline/publish/transcode.py:34` `transcode_video()` exists (clips to 12s, downscale to 1600,
  `libx264 crf26`, `-an` muted, `+faststart`); `publish/run.py:42-70` `build_derivatives()` already
  calls it for assets carrying `_local`; `publish/upload_r2.py` already dispatches `.mp4 → video/mp4`.

The only true gaps: (1) `download.py` skips videos and there is no poster-frame extraction/embedding,
and (2) the renderer has no video→texture path or conductor video branch.

## Architecture overview

Two seams, no contract change:

1. **Offline pipeline** learns to fetch a film, extract one poster frame, embed that frame via the
   existing image embedder, emit a `video` asset with an internal `_local` source path, and (already
   wired) transcode + upload a short muted clip.
2. **Renderer** learns to turn a video `src` into a pooled, looping, muted `THREE.VideoTexture` and
   hand it to the existing `setLayerTexture` / stage-bind seam, in both compositing modes.

## Pipeline components (Python)

### `pipeline/embed/download.py`
- Replace the `if c.type != "image": continue` skip (currently ~line 56) with a `video` branch:
  - Fetch the source film to the work dir (same HTTP/streaming approach as images; size guard).
  - Call new helper `extract_poster(video_path) -> Path | None` which shells
    `ffmpeg -ss <t> -i <in> -frames:v 1 -q:v 2 <poster>.jpg` with `t = min(1.0, near_start)`.
  - On success, append a `fetched.jsonl` row with `type:"video"`, the local **video** path, and the
    **poster** path. On ffmpeg/download failure, skip the candidate with a logged reason (non-fatal).
- Images keep their existing behavior unchanged.

### `pipeline/embed/` (embedding)
- Video embedding reuses `embed_images.py` `embed_image_paths()` applied to the **poster** frame.
  No new embedder, no torch-path changes. Result is a normal L2-normalized 512-d vector.

### `pipeline/embed/build_manifest.py`
- Emit video assets: `id = f"vid-{i:04d}"`, `type:"video"`, `dwellBase: 7.5` (already the video
  default in this file), `mood` from the poster embedding, `source`/`license`/`attribution` carried
  from the candidate, and an internal `_local` field → the downloaded source video path (consumed by
  publish, stripped before R2 per existing `_local` convention).
- Curation log line reports kept/dropped counts for video **separately** (no silent truncation),
  mirroring the existing image log.

### `pipeline/embed/curate.py`
- Add `VIDEO_CUTOFF = 0.45` as a distinct module constant next to the image `DEFAULT_CUTOFF = 0.52`.
- Apply `VIDEO_CUTOFF` to `type:"video"` assets (drop if `max(uncanny, ominous) < VIDEO_CUTOFF`),
  preserving the existing anchor-exemption shape. Document it as a tuning knob.

### `pipeline/publish/`
- No new code expected — verify and round out the existing wiring:
  `build_derivatives()` → `transcode_video()` for `_local` videos → `.mp4` derivative →
  `upload_r2.py` uploads as `video/mp4` and rewrites `asset.src` to the CDN URL.
- Transcode stays `-an` (muted). QC: extend `publish/qc.py` to count video derivatives (existence +
  non-zero size) rather than pixel-checking them as images.

## Renderer components (TypeScript)

### `app/src/render/videoTexture.ts` (new)
- `loadVideoTexture(url: string): Promise<TextureLoadResult>` — same ok/fail union as
  `loadImageTexture`, so callers are unchanged.
- Creates an `HTMLVideoElement` with `muted = true`, `loop = true`, `playsInline = true`,
  `preload = "auto"`, `crossOrigin = "anonymous"`. Waits for `canplay` (with a timeout → fail).
- Wraps in `THREE.VideoTexture` using the same colorspace / min-mag filter / `generateMipmaps=false`
  setup as `textureFromImage`. Sets `userData.ownedByCompositor = true` and `userData.kind = "video"`.

### `app/src/render/VideoPool.ts` (new)
- Bounds concurrent decoders. Caps: **classic = 1**, **wake = 2** simultaneous active videos.
- `acquire(url)` returns a managed video texture (creating via `loadVideoTexture`, evicting the
  least-recently-used active video if at cap). On show: `currentTime = 0; play()`.
- `release(texture)` / recycle: `pause()`, detach element, dispose the `THREE.VideoTexture` and the
  `HTMLVideoElement` (free decoder).
- **Reduced motion:** when `matchMedia('(prefers-reduced-motion: reduce)')` matches, do **not**
  `play()` — leave the element on its poster/first frame (static), consistent with existing weave/
  flicker/dust clamps. The texture still binds; it just does not advance.

### `app/src/render/Compositor.ts`
- Keep `showImage`. Add `showVideo(url, grade?): Promise<TextureLoadResult>` routing through
  `VideoPool` + `loadVideoTexture` (or a `showVisual(asset)` dispatcher that branches on `type`).
  Returns the same `TextureLoadResult` so downstream binding is unchanged.

### `app/src/dream/conductor.ts`
- Add a `type === 'video'` branch alongside the existing `'image'` branch in **both**:
  - the wake-mode layer swap (~line 322), and
  - the classic `resolveVisual` path (~line 423).
- Both branches end in the existing `stack.setLayerTexture(slot, tex)` / stage bind; the new code is
  small. On a `fail` result, fall back to the procedural texture exactly as image failures do today.

## Data flow

```
ingest (Archive.org film -> Candidate type:video)
  -> download (fetch film + ffmpeg extract poster frame)
  -> embed   (poster frame -> existing CLIP image embedder -> 512-d L2 vector)
  -> build_manifest (vid-NNNN asset; mood from poster; _local = source video)
  -> curate  (VIDEO_CUTOFF 0.45 drop test; anchors exempt)
  -> publish (transcode_video -> 12s muted mp4 -> R2 upload -> rewrite asset.src to CDN)
RUNTIME:
  dreamwalker selects by embedding (media-agnostic)
  -> conductor video branch (classic + wake)
  -> Compositor.showVideo -> VideoPool.acquire -> loadVideoTexture -> THREE.VideoTexture
  -> setLayerTexture / stage bind
  -> existing single rAF loop + EffectComposer postFX (VideoTexture auto-updates each frame)
```

## Error handling & determinism

- **Failures are non-fatal and uniform.** Download error, ffmpeg missing/non-zero, `canplay`
  timeout, or decode error → return the `fail` union → conductor falls back to a procedural texture,
  identical to today's image-failure behavior. No crash, no blank layer.
- **Pipeline ffmpeg absence** is non-fatal: `transcode_video` already returns `None` on
  `FileNotFoundError`; `extract_poster` follows the same try/except contract. The affected candidate
  is dropped with a logged reason (no silent truncation).
- **Determinism contract preserved.** Asset/text selection is embedding-driven and unchanged.
  Clip **start-point is deterministic** (seek 0 on show); intra-clip phase varies with frame timing,
  which is within the existing "timing may vary" contract. No `Math.random` enters the dream path.

## Testing strategy

### Pipeline (pytest; ffmpeg and boto3 mocked, mirroring existing tests)
- `extract_poster` invokes ffmpeg with the expected args and returns the poster path; returns `None`
  (and the video is skipped) when ffmpeg is missing/fails.
- `download.py` video branch records both poster and video paths in `fetched.jsonl`.
- `build_manifest` emits a valid `vid-NNNN` asset with `type:"video"`, `_local`, `dwellBase 7.5`, and
  a poster-derived L2-normalized embedding.
- `curate.py` `VIDEO_CUTOFF` keeps/drops video assets correctly and respects anchor exemption.
- `publish` transcodes a `_local` video and uploads the `.mp4` as `video/mp4`; manifest `src` rewritten.
- `manifest-contract` validation passes with a video asset present.
- Note the existing local gotcha: `pipeline/tests/test_carry_through.py` fails locally if torch is
  installed (real CLIP can't decode the fake jpg) — not a regression.

### Renderer (vitest)
- `loadVideoTexture` returns `ok` with a stubbed video element reaching `canplay`; returns `fail` on
  error/timeout.
- `VideoPool` respects the concurrency cap (evicts LRU at cap), pauses + disposes on release, and
  under stubbed reduced-motion does **not** call `play()`.
- Conductor video branch binds a texture via a stubbed pool and falls back to procedural on `fail`.

### E2e (Playwright smoke)
- `?wake=1` still renders with a video asset present in the seed manifest.
- ⚠️ Kill any process on port 4173 before `npm run test:e2e` (handoff's stale-`reuseExistingServer`
  false-green gotcha; a real run rebuilds and takes ~60s).

## Ship steps (this round)

1. `winget install ffmpeg` (or Gyan build); confirm `ffmpeg -version` on PATH.
2. Run the pipeline end-to-end over the ~46 Archive.org films: `cd pipeline && make corpus`.
   Review kept-video count and QC output.
3. Provide the 2 secret R2 API keys (into `pipeline/.env`, gitignored — the 3 non-secret R2 vars are
   in `docs/HANDOFF.md`) **or** run the upload manually; then `make corpus UPLOAD=1` (boto3 path —
   `wrangler` is not installed in this environment).
4. Verify: `latest.json` serves the new version including `vid-*` assets, and a sampled `.mp4`
   returns HTTP `200 video/mp4`; spot-check `dreamreel.pages.dev/?wake=1`.
5. Update `docs/HANDOFF.md` (mark round 4 shipped, bump the roadmap row) and record the corpus version.

## Approaches considered

- **A — parallel pipeline path + pooled decoders (chosen).** Fetch + poster-extract + embed in the
  pipeline; new `loadVideoTexture` + `VideoPool` in the renderer; conductor branch in both modes.
  Confines ffmpeg to two well-defined spots, reuses the image embedder, bounds decoder cost.
- **B — defer fetch to publish.** Transcode from remote URLs at publish without downloading.
  Rejected: poster-frame embedding still needs a fetched frame at embed time, so it just splits
  fetching across stages and complicates `id→file` correlation for no real saving.
- **C — renderer-minimal, no pool.** Create `VideoTexture` inline, dispose on recycle, no cap.
  Rejected: the wake LayerStack can fan out to many layers; without a cap, multiple simultaneous
  H.264 decoders risk frame drops. The pool would be retrofitted anyway.

## Open risks

- **ffmpeg installability** in this environment (mitigated: `winget` is available).
- **R2 credentials** for the final upload are not in the fresh clone (`pipeline/.env` absent) — needs
  the user's keys or a manual upload step. All earlier stages run without them.
- **Decoder performance** on the live site with 2 concurrent wake-mode videos — validate during the
  visual/tuning pass; the cap is a single tunable constant.
