# DREAMREEL — Project Context (single source of truth)

## Mission

DREAMREEL is a surreal "dream sequence generator": press play and watch a seamless,
ever-changing flow of public-domain **moving image** (vintage film first; photos, art,
maps, and title cards appear only as rare flash-frames and ghost-layer texture) with
drifting stream-of-consciousness text and a generative ambient audio bed. The governing
feel is **bizarre but familiar** — mostly recognizable, near-realistic dream scenes with
something quietly *off* — not a constant filter wash. The old-cinema treatment (grain,
gate-weave, flicker, dust, vignette) is one available mode, not the permanent grade. See
**Content & aesthetic direction** below, which governs.

The heavy lifting is offline. A pre-built, tagged asset pool plus embeddings ships as a
static manifest. At runtime the app generates sequences procedurally by walking the
embedding space. There are zero LLM/network inference calls at runtime. The only AI
spend is the one-time offline tagging pass.

## Content & aesthetic direction (2026 revision — governs everything below)

DREAMREEL renders **dreams, not a film-grain montage**. The governing feel is **bizarre but
familiar**: most of the time the screen shows a *recognizable, largely realistic scene* with
**something subtly off** — an object that doesn't belong, a familiar place reconfigured, motion or
physics slightly wrong, a face that won't resolve — the dream-logic "wrongness" coming from
**juxtaposition and recombination**, not from a heavy filter wash. The surreal, densely-layered,
kaleidoscopic look is the **occasional escalation** (peaks of wake intensity, and nightmare arcs),
which then **relaxes back** to the coherent baseline. This **inverts** the older "chaotic, densely
layered, always-filtered" default and the wake-mode framing where coherence was the rare *trough*:
coherence-realism is now the **baseline texture**, dissolution the departure. (Inspiration: Adult
Swim's *Ambient Swim* as a craft/visual north-star — distinct, artful, unique — **not** a chill-out
generator and **not** a clone; DREAMREEL keeps its full emotional range and its per-seed
surreality/tempo.)

Three concrete consequences (target-state where noted; sequence the code to reach them):

- **Video-first; photos demoted to flash-frames.** Dreams are *moving*, and real dreams almost never
  contain still photographs. The primary walk should surface **`video` overwhelmingly**; `image`
  assets are kept only as **rare flash-frames / ghost-layer texture** (a quick subliminal cut or a
  double-exposure ghost), never a held primary beat. Two layers: the **corpus** must shift heavily
  toward public-domain film (Archive.org), demoting Openverse stills — the bigger lift, and mind
  video's R2 storage/bandwidth/decode cost; and the **runtime** (`dream/visualPool.ts`) must weight
  `video` up and route `image` to the flash-frame/ghost path rather than the held primary slot.
  *(Runtime DONE: `visualPool` is video-first — when archive is on and the corpus has video, the
  held-primary pool is `video` + title cards and `image` is demoted to the rare flash-frame /
  ghost-layer path via `flashFramePool` + `conductor.maybeFlashFrame`; a video-less corpus keeps
  images primary as a graceful fallback. The CORPUS shift toward film is the remaining lift.)*

- **Gentle by default, nightmares as an arc.** Like real dreams, the *distribution* of dream
  emotional identities should lean toward the warm/strange end — **tender, nostalgic, love, joy,
  absurdity, the uncanny-but-benign** — with **fear/ominous/dread a minority** of dreams, plus the
  classic **mid-dream turn**: a coherent dream drifting *into* nightmare and (sometimes) back out.
  Today nothing at the seed level biases emotional identity — `dream/seedParams.ts` derives only
  `surreality`+`tempo`, and mood emerges roughly uniformly from wherever the walk wanders. The fix is
  a **seed-level emotional-identity / mood-bias distribution** layered onto the seed (most seeds drawn
  toward the gentle region, a minority toward fear; an optional intra-dream drift toward an axis),
  expressed through the existing 12-axis taxonomy and the seeded-spine model. *(DONE — `dream/moodBias.ts`
  `deriveMoodIdentity` draws a per-seed identity from a ≈68% gentle / 20% neutral / 12% nightmare
  distribution, each with an optional mid-dream arc; the Dreamwalker leans its START point and image/ghost
  picks toward it, deterministic per seed.)* Scary still happens, deliberately; it is just no longer the
  ambient default.

- **Artful, not generic.** The "unique and artistic" quality comes from the **corpus** (favor
  experimental / animated / art film and visually distinctive footage over generic archival clips)
  and from the look brain committing to **distinctive per-seed treatments** rather than a uniform
  grade — `dream/filterDirector.ts` stays the single source of truth for that.

The look catalog, mood→filter mapping, transitions, procedural fallback, determinism/steering, and
memory/recurrence machinery below are all **unchanged in mechanism** — this section only re-aims their
*defaults and balance* (coherent-realistic baseline, video-first, gentle-leaning distribution). Where
older language below conflicts (the "chaotic… densely layered" intended look, "photos" as a core
medium, coherence-as-rare-trough), **this section wins**.

## Core architecture (do not violate without flagging)

- **Tagged pool plus runtime sequencer**, never pre-baked fixed sequences. Variation
  comes from a seeded walk over the pool, not from playback of stored reels.
- **The Dreamwalker** is the Infinite-Jukebox model applied to mixed media: maintain a
  current point in CLIP embedding space, drift it (Brownian) and occasionally leap
  (non-sequitur), select the next asset by cosine similarity with a softmax temperature.
  Surreality is that temperature plus the leap probability — **derived from the seed, not a
  user control** (see `dream/seedParams.ts`). Reference: the Infinite Jukebox / Remixatron
  family. Reimplement the algorithm; do not copy code.
- **Emotion taxonomy (a blendable vector, not a label).** Every asset (and the live walk point)
  carries a **continuous mood vector over twelve axes**, each 0..1: the original six —
  melancholy, uncanny, nostalgic, ominous, tender, mechanical — plus **love, loss, joy, fear,
  absurdity, strange**. Mood is **never reduced to a single dominant axis** in the data: the axes
  blend, so the runtime can express combinations — tender+loss = bittersweet, joy+uncanny = manic.
  The intended emotional range is love, loss, joy, absurdity, fear, nostalgia, the strange — and
  their combinations. Each axis is a CLIP text-prompt anchor (a contrast of descriptive prompts,
  L2-normalized — see `pipeline/embed/mood_axes.py`); an asset's mood is the projection of its
  embedding onto each axis (`dream/mood.ts` `projectMood`, with blend/query helpers `dominantAxes`,
  `blendMoods`, and `moodAffinity`). Axis order is frozen and shared by `manifest/types.ts`, the
  pipeline, and the seed generator. The full 12-axis blend drives **post-FX filter strengths**,
  **transition choice**, **procedural-source variation**, **audio bed params** (`audio/params.ts`),
  **CLAP audio-walk bias** (`dream/audioWalker.ts`), **text pick bias + tint**
  (`dream/textDirector.ts`, `dream/dreamwalker.ts`, `ui/Captions.tsx`), and classic-mode film grade
  (`conductor.applyMoodToFilm`). See `dream/filterDirector.ts` for the look brain.
- **Single-verb UX.** The viewer can only summon a **new dream** (a fresh seed) — they can
  never tune or edit the one they're given. There are no dream-shaping sliders, toggles, or
  switches: surreality and tempo are derived deterministically from the seed, so each dream has
  its own character (one seed calm, another frenzied) and variety lives *across* dreams. The only
  controls are **New dream**, play/pause, and a sound on/off output toggle. (The behavioral bend
  below is **not a control** and does not violate this: it reads *ambient, passive* signals — never
  a slider, toggle, or dream-shaping knob — and any steering is bounded and relaxes back to the
  seeded dream, so the viewer still can't tune or pin the dream they're given.)
- **Determinism — a seeded spine that bends to behavior and relaxes back.** The seed defines a
  pure **spine** (the deterministic "ghost track"): given the same seed, the *sequence of assets
  and text* (the "dream script") — and, in wake mode, the sequence of coherence troughs and
  layer-swap events — is identical, even if frame timing varies. A **PASSIVE viewer** (no
  interaction) gets exactly this seeded dream, in the same order, bit-for-bit — `?seed=` stays
  reproducible. On top of the spine, **ambient behavioral signals** (pointer attention, idle,
  document focus/blur, device tilt, time-of-day — native APIs only, **no webcam**) apply
  **bounded** nudges: an engaged viewer gets a *steered variant of the same dream identity*, never
  a different dream. The bend is **capped** (max deviation from the spine is bounded) and
  **relaxes** — when signals fade it decays back to the spine on a time constant, snapping to
  exactly the seeded sequence once spent. Determinism holds given **(seed + the recorded steering
  signal)**; with zero signal it equals the pure seeded sequence bit-for-bit. The spine is kept
  explicit and queryable so the bend can measure its own deviation and pull back (see
  `dream/dreamwalker.ts` spine/`bend`/`setSteering` and `dream/steering.ts`). Two paths stay
  strictly separate: the **content bend** can change *which* assets/text/events occur (pointer
  attention leans the next pick within the cap; blur eases toward a coherence trough; idle only
  *lengthens dwell*, never reordering the script), while **presentation shimmer** (pointer/tilt →
  subtle parallax/breathing in `render/Compositor.ts`) only reframes the picture and can never
  alter the dream script. A given seed therefore still yields a given **emotional identity** (its
  surreality/tempo and the mood vectors of the assets its walk surfaces). The seed remains the
  **only** shareable dream param: `?seed=...` (surreality/tempo fold into what the seed produces;
  steering is live/ambient and never serialized; `?wake=0` is a non-UI engine-mode opt-out).
- **Two compositing modes, both seeded and deterministic.**
  - *Classic clocks:* three desynced layer clocks (image, ghost/double-exposure, text)
    advance independently so layers recombine.
  - *Wake mode (the new default-intended experience):* a single seeded **intensity**
    signal drives the reel instead of independent clocks — sporadic fast layer-swaps,
    breathing N-layer density (the LayerStack compositor fanning out and collapsing), and
    rare **coherence troughs** where the walk briefly converges before dissolving again.
    The per-seed sequence of assets, text, layer events, and coherence troughs is preserved
    (timing may vary). **Now the default** experience; the classic reel is opt-out via `?wake=0`.
    *(DONE — per **Content & aesthetic direction**, the 2026 balance is now inverted in
    `dream/intensity.ts`: the resting intensity is a LOW, coherent baseline and the rare events are
    occasional **escalation surges** (sustained high-intensity peaks / nightmare arcs) that relax
    back; troughs are kept as even-deeper-coherence moments. Same mechanism, defaults flipped — the
    whole look brain follows since filter strength / swap cadence / Butterchurn all scale off
    intensity. The seeded trough schedule is unchanged.)*
- **Live WebGL compositing** is the primary renderer. Offline pre-render (editly) is an
  optional secondary path, behind a flag, not the default.
- **Dream memory — recurrence, not just selection.** Every visual asset carries open-set ENTITY tags
  (RAM++, `entities[]`). The runtime keeps a **decaying weighted memory** of the entities it has
  surfaced (`dream/memory.ts` `DreamMemory`, updated each logical beat). This drives recurrence at
  three depths, all **bounded + relaxing + deterministic per seed** (the same seeded-spine-that-bends
  model as steering): (1) the Dreamwalker leans toward candidates whose entities **echo** memory, so
  motifs return; (2) the conductor occasionally summons a **segmented cutout** of a strongly-remembered
  entity (Grounding DINO + SAM 2 → `entitySprites[]`) as a drifting ghost (`render/SpriteField.ts`);
  (3) SAM 2 *video* tracking makes some cutouts **animated** sprite sheets, so the recurring figure
  moves. All extraction is offline (zero runtime inference); cutouts are pre-made PNGs on R2.

## Stack (committed)

- **Frontend:** Vite + React + TypeScript + Tailwind. State via **Zustand**. No
  react-three-fiber: the compositor is an imperative three.js renderer wrapped by a React
  component, because we want an explicit single render loop.
- **Rendering:** **three.js** core; transitions via the **gl-transitions** spec
  implemented as a custom three.js `ShaderMaterial`; post-FX via **pmndrs/postprocessing**
  (`EffectComposer`).
- **Audio:** **Tone.js**. Sampled clips also carry optional offline **rhythmic analysis**
  (tempo + energy via **librosa**, ISC) so the audio walk swaps clips on musical-bar boundaries
  and leans toward louder clips in high-arousal moods — both pure, seed-deterministic, and a
  graceful no-op on legacy manifests (`dream/audioWalker.ts` `musicalDwellMs`/`audioArousal`).
- **Offline pipeline:** Python. Ingest via the **Openverse API** and the **Archive.org
  HTTP API** (Advanced Search + Metadata); museum **CC0** datasets (Met, Smithsonian)
  optional. Download/resize via **img2dataset**; embeddings via **clip-retrieval** /
  **open_clip**. Audio rhythm (tempo/energy) via **librosa** (`pipeline/audio/tempo.py`, the
  optional `audio` extra). Output a static manifest plus an embeddings file.
- **Hosting:** Cloudflare **Pages** for the SPA, Cloudflare **R2** for media and manifest.
  `wrangler` for deploy.

## License rules (hard constraints, this is a commercial product)

- **May ship in the bundle:** MIT, BSD, Apache-2.0, Zlib, ISC, CC0, public domain, and
  CC-BY (only if attribution is rendered).
- **May NOT be embedded or linked into shipped code:** AGPL, GPL/LGPL where it would
  copyleft us, or anything "source-available but not open" (Remotion). Hydra and Strudel
  are inspiration only.
- **Every asset carries `license`, `source`, and (if required) `attribution`.** The app
  must render attributions for any CC-BY asset on screen. Reject CC-BY-NC and
  unknown-license assets in the pipeline.
- Add a dependency license check to CI (Phase 3). If a transitive dep is copyleft, stop
  and report.

## Repo layout

```
dreamreel/
  app/                      # Vite React TS frontend
    public/manifest.seed.json
    src/
      render/               # three.js compositor, transition material, post-fx, procedural sources
      dream/                # Dreamwalker, seeded prng, mood-axis projection
      audio/                # Tone.js engine
      state/                # Zustand store
      ui/                   # React components: Gate, ProjectorPanel, Captions, Idle
      manifest/             # loader + shared types (the contracts below)
      styles/
  pipeline/                 # Python offline corpus build
    ingest/  embed/  publish/
    pyproject.toml
  infra/                    # wrangler.toml, Pages config
  CLAUDE.md  README.md
```

## Shared contracts (the fixed interfaces; build against these exactly)

See `app/src/manifest/types.ts`, `app/src/dream/dreamwalker.ts`, and
`app/src/state/store.ts`. Field names are frozen; do not rename.

## Aesthetic tokens (available palette/type/grain — not a single mandated treatment)

These are the design tokens the app draws on. Per **Content & aesthetic direction** above, the
**default** look is a **coherent, lightly-graded, near-realistic** dream image whose wrongness comes
from juxtaposition/recombination — *not* a constant filter wash. The **chaotic, fluid, multi-modal,
densely-layered** look with heavy dynamic filtering is the **occasional escalation** (intensity peaks,
nightmare arcs) that relaxes back to the coherent baseline; it is neither the resting state nor one
uniform always-on old-cinema grade. The old-cinema treatment (grain, gate-weave, flicker, dust,
vignette) is **intensity-modulated** rather than a constant master: the film grade rises and falls
with the wake intensity signal, and warp/density vary with it.

- Palette: ink `#0E0B08`, tungsten amber `#C8A35E`, lamp glow `#E8C887`, silver-bone
  `#D8D2C4`, sepia `#6B5640`, verdigris `#4A6B66` (sparingly). Use as an available palette,
  not a fixed wash.
- Type: **Bodoni Moda** for intertitles/title cards (caps, wide tracking), **EB Garamond**
  for the drifting text, **Courier Prime** for archival captions/metadata.
- The projection-gate-in-a-dark-booth and the cinema grain/weave/flicker/dust/vignette
  remain available signatures, but they are one mode among many — modulated by intensity,
  not the permanent unifying treatment over every source.
- **Mood-mapped filter catalog (wake mode):** the look is a rotating library of treatments —
  kaleidoscope, liquid warp, solarize/x-ray, melt/bloom-bleed, posterize, and feedback
  echo-trails — selected by the dominant CLIP **mood axis** (melancholy→feedback,
  uncanny→solarize, nostalgic→liquid, ominous→kaleidoscope, tender→melt, mechanical→posterize).
  The intensity heartbeat scales filter strength; filters ease off at coherence troughs so the
  lucid image reads. Deterministic per seed; identity (no filter) by default so the classic
  reel is unchanged. See `dream/filterDirector.ts`, `render/DreamFilter.ts`, and the LayerStack
  feedback RT.
- **`dream/filterDirector.ts` is the SINGLE source of truth** for emotion+intensity → look: post-FX
  filter strengths, crossfade **transition** choice, **procedural-source** params, AND whether the
  optional **Butterchurn** layer engages. Keep new look decisions here (pure, seed-deterministic via
  a caller-supplied `roll`) so the look stays coherent and unit-testable.
  - *Transitions* (`render/transitions.ts`, ~30 original gl-transitions-spec GLSL shaders, MIT — see
    `app/NOTICE`; every shader is compile+link-checked in real WebGL by `tests/e2e/transitions-compile.spec.ts`):
    each of the 12 mood axes nominates a transition family (e.g. fear/ominous→hard
    cuts, tender/love→luminous dissolves, absurdity/strange→warped/melting, nostalgic→liquid,
    mechanical→glitch/posterize, joy→iris/radial); the live mood **blends** those families and
    `pickTransition` selects deterministically. Neutral mood → a gentle identity default; coherence
    troughs → the calmest dissolves; **reduced-motion → a gentle, no-flicker set** (never hard
    cuts/glitch/push).
  - *Post-FX filters* (`render/DreamFilter.ts`): all **12 axes** map onto the six-filter catalog
    (original six 1:1; new axes pair semantically — love→melt, loss→feedback, joy→liquid,
    fear→kaleidoscope, absurdity→posterize, strange→solarize). Strength scales with intensity and
    eases at coherence troughs.
  - *Procedural variants* (`render/procedural.ts`): the existing kinds read `proceduralParams`
    (speed/density/brightness/warmth/jitter) so fog thickens on ominous/fear, ripple quickens/brightens
    on joy + intensity, stars sparsen on loss, etc. A **neutral mood at zero intensity reproduces the
    original look bit-for-bit** (`NEUTRAL_PROC_PARAMS`). **Procedural sources are a fallback medium, not
    a primary visual:** the Dreamwalker walks real media + title cards (`dream/visualPool.ts` — media-first
    when archive is on); procedural is surfaced only when a real asset fails to load, to texture
    transitions, or as ghost echoes. Do not re-add procedural assets to the primary walk pool — that is
    what made dreams drift to an all-shaders look.
  - *Butterchurn psychedelic layer* (`render/ButterchurnLayer.ts`, `render/LayerStack.setPsychedelic`):
    a reactive Milkdrop wash engaged ONLY in high-intensity frenzy (`butterchurnEngaged`), off under
    reduced-motion and eased at troughs. **Behind the `?butterchurn=1` engine flag, default OFF.** The
    `butterchurn` + `butterchurn-presets` deps (both **MIT**, pass the CI license check) are **lazily
    code-split** — `import()`ed only on first engage, so they never enter the default bundle — and the
    whole path degrades to a no-op if WebGL2/the packages are unavailable (base reel untouched). It taps
    the Tone audio bed for reactivity via `AudioEngine.getVisualizerTap()`. ⚠ **Commercial-ship note:**
    the bundled presets are community-authored Milkdrop conversions under the package's MIT grant; if
    stricter per-author provenance is needed, swap the full pack for a hand-picked MIT/CC0 subset before
    enabling. Default-OFF keeps that a deliberate call. See `app/NOTICE`.
- Respect `prefers-reduced-motion`: dampen weave/flicker/dust, keep dissolves slow; transitions fall
  back to the gentle set and the Butterchurn layer never engages.

## Coding conventions

- TypeScript strict. No `any` in committed code. ESLint + Prettier.
- No browser storage for shareable state (the URL carries `?seed=` — the only shareable dream
  param). localStorage is allowed only for non-essential UI prefs.
- No secrets in client code. Pipeline secrets via env.
- Tests: Vitest for `dream/` and `manifest/`; Playwright smoke test for the app.
