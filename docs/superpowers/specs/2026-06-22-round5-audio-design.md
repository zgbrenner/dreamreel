# Round 5 — Sampled Audio as a First-Class Medium — Design

_Date: 2026-06-22. Status: approved, ready for implementation plan._

## Goal

Make **sampled sound** a first-class dream medium, parallel to what Round 4 did for video.
Today `app/src/audio/engine.ts` is a 100%-synth ambient bed (drone + tape hiss + bells +
projector ticks) driven by the visual walk's projected mood; there is **no sampled-audio
playback path at all**, and the ~40 Archive.org film clips are transcoded muted (`-an`). This
round adds real recorded audio — **music, voices, foley** — plus the film clips' own
soundtracks, selected by a **second Infinite-Jukebox walk in CLAP space** that is coupled to
what is on screen, and mixed over the existing synth bed.

This is **one spec covering all four flavors** (music / voice / foley / film-clip native audio),
built on one shared core: a sampled-audio playback + mixing path and a CLAP audio walk.

## Core decisions (locked during brainstorming)

1. **One subsystem, three corpus kinds + one adjacent path.** `music`, `voice`, and `foley` are
   one pooled audio corpus distinguished by a `kind` tag, walked and mixed the same way.
   Film-clip native audio reuses the existing video pipeline (stop passing `-an`, duck the clip's
   own track in). One spec, one (large, well-decomposed) plan.
2. **True audio-space walk (CLAP).** Audio gets real **CLAP** (Contrastive Language-Audio
   Pretraining, laion) embeddings, dim 512, and a second Infinite-Jukebox walk runs in that space —
   parallel to, and independent in seed from, the visual CLIP walk. The synth bed is unchanged and
   remains the always-on foundation.
3. **Coupled via a text bridge.** CLIP and CLAP are different spaces but both share a **text**
   anchor. The audio walk roams CLAP space on its own seed but each step is nudged toward audio
   whose CLAP embedding aligns with the current on-screen concept. Sound and image relate.

## Constraints (inherited from the project — CLAUDE.md)

- **Determinism preserved.** Same `seed` (+ `surreality`/`tempo`) → identical **sequence** of
  audio assets, even if frame/playback timing varies. No `Math.random` and no new RNG draws in the
  audio dream path; the audio walk uses the seeded PRNG. Audio decode/network latency affects only
  timing, never the sequence — exactly the existing video contract.
- **Zero runtime inference.** No CLAP (or any ML) at runtime. All embeddings — including the text
  bridge — are precomputed offline and shipped in the static manifest.
- **License gate (commercial product).** Audio may ship only if PD / CC0 / CC-BY (CC-BY only with
  rendered attribution). Reject CC-BY-NC and unknown-license audio in the pipeline, reusing
  `pipeline/ingest/licenses.py`.
- TypeScript strict, no `any`. Tone.js for audio (already a dependency). Vitest for `dream/` and
  `audio/` pure logic; Playwright smoke for the app. Pytest for the pipeline.
- No new browser storage for shareable state; the audio walk is seeded from the existing `?seed`.

## Architecture

### The two-walk model

```
?seed ──┬─► Dreamwalker (CLIP space)   ─► visual sequence (unchanged)
        │        │
        │        └─ current LOGICAL visual asset ─► claptext vector ─┐  (text bridge)
        │                                                            ▼
        └─► AudioWalker (CLAP space, seed+":audio") ─► sampled-audio sequence
                                                            │
   synth bed (existing AudioEngine) ───────────────────────┼─► Mixer (buses + ducking)
   film-clip native audio (hero video) ────────────────────┘
```

- The visual `Dreamwalker` (CLIP) is **untouched**.
- The synth bed (`AudioEngine`) is **untouched** and remains the always-on foundation.
- A new `AudioWalker` selects *sampled* sound to layer on top, biased by the text bridge.
- A new `Mixer` hangs sampled buses off the **existing** Tone master/reverb so the bed and samples
  share one AudioContext and one mute.

### The text bridge (coupling)

Offline, each **visual** asset gains a `claptext` vector: the CLAP-**text** embedding of its
dominant tags. At runtime (no inference), the `AudioWalker`'s next-pick softmax is biased toward
audio whose CLAP-**audio** embedding aligns with the **current logical** visual asset's `claptext`,
scaled by a fixed coupling constant. A train image tilts audio mechanical/rhythmic; a face tilts
toward voice.

### Determinism reconciliation

The `AudioWalker` advances on its **own logical clock** (kind-specific dwell), seeded
`seed+":audio"`. The text-bridge bias reads the visual walk's **current logical asset** — a pure
function of the seed — **not** the wall-clock-current frame. Therefore the audio sequence is a pure
function of the seed: `same seed → same audio sequence`, timing-independent. CLIP and CLAP are kept
strictly separate (separate fields, separate dim constant); the two 512-d spaces are never mixed.

## Offline pipeline (new `pipeline/audio/`)

| Stage | File (new unless noted) | Behavior |
|-------|------|----------|
| Ingest + license gate | `pipeline/audio/ingest.py` (reuses `ingest/licenses.py`) | music ← Archive.org 78rpm / Musopen; voice ← LibriVox + Archive.org speeches/radio; foley ← Freesound CC0 + Archive.org field recordings. PD/CC0/CC-BY only; reject CC-BY-NC/unknown. |
| Transcode / trim | `pipeline/audio/transcode_audio.py` (parallels `publish/transcode.py`) | ffmpeg, loudness-normalized: music → 30–90s window; voice → 3–10s fragment; foley → 5–20s loopable. Web audio output (`.m4a`/`.opus`). |
| CLAP embed | `pipeline/audio/clap_backend.py` | laion CLAP, dim 512, deterministic **hash-fallback** when the model is absent (mirrors `embed/clip_backend.py`), so CI needs no model download. Audio-embed every audio asset; text-embed each visual asset's dominant tags → `claptext`. |
| Mood projection | reuse `embed/mood_axes.py` pattern | project CLAP audio embedding onto the 6 mood axes for the bed-ducking/QC, same shape as visual `mood`. |
| Manifest assembly | extend `embed/build_manifest.py` | emit `audio[]`, `audioEmbeddingDim`, and visual `claptext`. |
| Film-clip audio | extend `publish/transcode.py` | re-transcode the existing ~40 clips **without** `-an` (keep a separate muted poster path). The clip's own soundtrack becomes a duckable runtime source — no new corpus. |
| Ship to R2 | reuse `publish/upload_r2.py` | upload audio media + manifest; strip internal `_local`/`_clipStart`-style fields as today. |

### Manifest schema changes (additive — no renames; field names stay frozen)

`app/src/manifest/types.ts`:

```ts
export type AudioKind = 'music' | 'voice' | 'foley';

export interface AudioAsset {
  id: string;
  kind: AudioKind;
  src: string;                       // R2 URL
  embedding: number[];               // L2-normalized CLAP audio embedding (audioEmbeddingDim)
  mood: Record<MoodAxis, number>;    // projection onto the 6 axes (for ducking/QC)
  tags: string[];
  durationSec: number;
  loopable: boolean;                 // foley/short beds may loop
  dwellBase: number;                 // seconds this asset wants to hold focus
  source: string;
  license: string;                   // "PD" | "CC0" | "CC-BY-4.0" | ...
  attribution?: string;              // required when license starts with "CC-BY"
  attributionUrl?: string;
}

export interface Manifest {
  // ...existing fields unchanged...
  audioEmbeddingDim: number;         // e.g. 512 (CLAP space — distinct from embeddingDim)
  audio: AudioAsset[];               // sampled-audio pool
}

export interface Asset {
  // ...existing fields unchanged...
  claptext?: number[];               // CLAP-text embedding of dominant tags (text bridge); optional
}
```

Both embedding dims happen to be 512 but index **different** spaces; they must never be compared.

## Runtime

### `AudioWalker` (`app/src/dream/audioWalker.ts`)

Mirrors `Dreamwalker` over the CLAP pool, seeded `seed+":audio"`. Same trusted primitives:
Brownian drift + occasional leap + cosine-similarity softmax (temperature = surreality). Each step:

- Applies the **text-bridge bias**: adds `COUPLING * cos(candidate.embedding, currentVisual.claptext)`
  to each candidate's pre-softmax weight (visual asset with no `claptext` → zero bias, walk unbiased).
- Applies a per-kind weight so kinds surface at the right rate — `TYPE_WEIGHTS` exactly like video:
  `{ music: 1.0, voice: 0.5, foley: 0.8 }` (tuned constants).

Pure and unit-testable; no Tone/DOM imports; no `Math.random`.

### Mixer (`app/src/audio/mixer.ts`) + `AudioPool` (`app/src/audio/AudioPool.ts`)

A small bus graph hung off the **existing** Tone master/reverb (one context, one mute):

| Bus | Source | Behavior |
|-----|--------|----------|
| **Bed** (exists) | synth `AudioEngine` | always on; ducks ~4 dB under any sampled content |
| **Music** | 1 track | long dwell, crossfade on swap; **streamed** (HTMLAudio → `MediaElementAudioSourceNode`) since tracks are long |
| **Foley** | 1 texture | concurrent atmosphere; **buffered** (`Tone.Player`); loops if `loopable` |
| **Voice** | 1 fragment | surfaces occasionally like drifting text; ducks music/foley while speaking |
| **Film-clip** | clip's own track | when a video clip is a **hero** layer, its native audio ducks in; ducks music/foley |

- **Ducking priority** (sidechain, loudest focus wins): `voice ≈ film-clip > music > foley > bed`.
  One `duckBus(target, amountDb, ramp)` helper; pure level math in `app/src/audio/ducking.ts`
  (unit-tested); all gain changes ramped (no clicks).
- **`AudioPool`** — bounded decoders, cap ~3 (mirrors `VideoPool`): freezes/evicts the oldest beyond
  cap; pauses on tab-hidden, resumes on visible.
- **Cadence/wiring** — sampled swaps are driven by the `AudioWalker`'s logical cadence (kind-specific
  dwell: music longest, voice shortest), wired through the conductor next to the existing
  `wakeTick`/mood updates. Runs in **both classic and wake modes**.
- **Failure handling** — a sample that 404s or fails to decode is skipped (walk advances to the next
  pick), never throwing into the render loop — same resilience as `videoTexture`/`VideoPool`.

### Controls & defaults

- **No new URL params.** Audio walk seeds off the existing `?seed`; surreality drives its softmax
  temperature. Coupling strength and per-kind weights are tuned constants (like the video weight and
  filter scales), not user knobs — keeps the determinism surface small.
- **Gating.** Everything stays behind the existing single **sound toggle** (`DreamRuntime.setSound`)
  and the user-gesture `start()`. Sound on → bed + samples; sound off → full silence. One mute
  governs all buses.
- **`setArchive`** also governs film-clip **native audio**, consistent with how it already governs
  clips visually.
- **Default:** sampled audio is **on whenever sound is on**, in both classic and wake modes. No
  per-kind toggles (YAGNI; revisit only if a kind proves intrusive in live tuning).
- **Reduced-motion** is unaffected (it governs visual motion, not audio).

## Components touched

| File | Change | Testable unit |
|------|--------|---------------|
| `pipeline/audio/ingest.py` (new) | PD/CC0 audio ingest + license gate | reject non-PD/CC0; accept PD/CC0/CC-BY |
| `pipeline/audio/transcode_audio.py` (new) | per-kind trim + loudness normalize | window bounds per kind; normalization invoked |
| `pipeline/audio/clap_backend.py` (new) | CLAP audio + text embed, hash-fallback | deterministic fallback; dim 512; same vector for same input |
| `pipeline/embed/build_manifest.py` (mod) | emit `audio[]`, `audioEmbeddingDim`, `claptext` | manifest shape includes new fields |
| `pipeline/publish/transcode.py` (mod) | clip re-transcode without `-an` (+ muted poster) | audio stream present; poster still muted |
| `pipeline/publish/upload_r2.py` (mod) | upload audio media; strip internal fields | no internal fields leak |
| `app/src/manifest/types.ts` (mod) | `AudioAsset`, `AudioKind`, `audio[]`, `audioEmbeddingDim`, `claptext` | typecheck |
| `app/src/dream/audioWalker.ts` (new) | CLAP walk + text-bridge bias + `TYPE_WEIGHTS` | bias shifts selection; zero coupling = unbiased; weights shift rates; seed determinism; salt differs from visual |
| `app/src/audio/ducking.ts` (new) | pure ducking level math | priority order; ramp targets |
| `app/src/audio/AudioPool.ts` (new) | bounded decoders | cap/evict/pause-resume |
| `app/src/audio/mixer.ts` (new) | bus graph + duck wiring + pool | verified via typecheck/lint + suite + manual (Web Audio not unit-harnessed) |
| `app/src/dream/conductor.ts` (mod) | drive `AudioWalker` cadence + mixer swaps | full suite green; manual `?wake=1` + classic |
| `app/src/state/store.ts` / `runtime.ts` (mod) | thread audio through `setSound`/`setArchive` | existing toggle tests + manual |
| `tests/e2e/smoke.spec.ts` (mod) | audio starts, no console errors, bounded heap | Playwright |

## Testing strategy

- **Pipeline (pytest):** `clap_backend` hash-fallback determinism (no model download in CI);
  license gate rejects non-PD/CC0 audio; transcode trims to the right per-kind window and normalizes
  loudness; manifest shape includes `audio[]` + `audioEmbeddingDim` + visual `claptext`; `upload_r2`
  strips internal fields.
- **Runtime (vitest):** `audioWalker` — text-bridge bias shifts selection toward concept-aligned
  audio and zero coupling reproduces the unbiased walk (regression guard); per-kind `TYPE_WEIGHTS`
  shift surface rates; **same seed → identical audio sequence**, and `seed+":audio"` differs from the
  visual sequence. `ducking.ts` level math (priority order, ramp targets). `AudioPool`
  cap/evict/pause-resume. Pure helpers only — no Web Audio context in unit tests.
- **Integration:** `npm run typecheck && npm run lint && npx vitest run` green; conductor/mixer wiring
  verified by the full suite not regressing.
- **Manual:** rebuild a small audio corpus, `npm run preview`, open `?wake=1` and classic — confirm
  sampled sound layers over the bed, voices duck music, a hero clip's soundtrack ducks in, and the
  same seed replays the same audio sequence. Playwright smoke still passes.

## Out of scope (YAGNI)

- Beat-sync / tempo-matching of music to cuts.
- Per-kind UI toggles or a coupling-strength URL knob (coupling is a fixed constant).
- Spatial/stereo positioning of audio sources.
- User-uploaded audio.
- Re-embedding or altering the existing visual CLIP pool beyond adding `claptext`.

## Approaches considered

- **Selection model:** mood-tag-follow (reuse the 6 axes) vs. **true CLAP audio walk** (chosen —
  most faithful to the Infinite-Jukebox core) vs. hybrid.
- **Walk coupling:** fully independent vs. **text-bridge coupled** (chosen — sound and image relate,
  still deterministic) vs. coupling-strength as a URL knob (rejected — extra tunable surface).
- **Sequencing:** phased rollout vs. **one spec, all four flavors** (chosen) vs. core-mixer-only first.
