# DREAMREEL — Project Context (single source of truth)

## Mission

DREAMREEL is a surreal "dream sequence generator": press play and watch a seamless,
ever-changing mashup of public-domain media (vintage film, photos, art, maps, title
cards) with drifting stream-of-consciousness text and a generative ambient audio bed,
all under an old-cinema visual treatment (grain, gate-weave, flicker, dust, vignette).

The heavy lifting is offline. A pre-built, tagged asset pool plus embeddings ships as a
static manifest. At runtime the app generates sequences procedurally by walking the
embedding space. There are zero LLM/network inference calls at runtime. The only AI
spend is the one-time offline tagging pass.

## Core architecture (do not violate without flagging)

- **Tagged pool plus runtime sequencer**, never pre-baked fixed sequences. Variation
  comes from a seeded walk over the pool, not from playback of stored reels.
- **The Dreamwalker** is the Infinite-Jukebox model applied to mixed media: maintain a
  current point in CLIP embedding space, drift it (Brownian) and occasionally leap
  (non-sequitur), select the next asset by cosine similarity with a softmax temperature.
  The Surreality control is that temperature plus the leap probability. Reference: the
  Infinite Jukebox / Remixatron family. Reimplement the algorithm; do not copy code.
- **Determinism.** Given the same seed and surreality, the *sequence of assets and text*
  (the "dream script") — and, in wake mode, the sequence of coherence troughs and
  layer-swap events — is identical, even if frame timing varies. Seeds are shareable via
  URL (`?seed=...&s=...&t=...`).
- **Two compositing modes, both seeded and deterministic.**
  - *Classic clocks:* three desynced layer clocks (image, ghost/double-exposure, text)
    advance independently so layers recombine.
  - *Wake mode (the new default-intended experience):* a single seeded **intensity**
    signal drives the reel instead of independent clocks — sporadic fast layer-swaps,
    breathing N-layer density (the LayerStack compositor fanning out and collapsing), and
    rare **coherence troughs** where the walk briefly converges before dissolving again.
    The per-seed sequence of assets, text, layer events, and coherence troughs is preserved
    (timing may vary). Reachable today via `?wake=1`.
- **Live WebGL compositing** is the primary renderer. Offline pre-render (editly) is an
  optional secondary path, behind a flag, not the default.

## Stack (committed)

- **Frontend:** Vite + React + TypeScript + Tailwind. State via **Zustand**. No
  react-three-fiber: the compositor is an imperative three.js renderer wrapped by a React
  component, because we want an explicit single render loop.
- **Rendering:** **three.js** core; transitions via the **gl-transitions** spec
  implemented as a custom three.js `ShaderMaterial`; post-FX via **pmndrs/postprocessing**
  (`EffectComposer`).
- **Audio:** **Tone.js**.
- **Offline pipeline:** Python. Ingest via the **Openverse API** and the **Archive.org
  HTTP API** (Advanced Search + Metadata); museum **CC0** datasets (Met, Smithsonian)
  optional. Download/resize via **img2dataset**; embeddings via **clip-retrieval** /
  **open_clip**. Output a static manifest plus an embeddings file.
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

These are the design tokens the app draws on. The intended look is **chaotic, fluid,
multi-modal, and densely layered**, with varied and dynamic filtering — not one uniform,
always-on old-cinema grade. The old-cinema treatment (grain, gate-weave, flicker, dust,
vignette) is now **intensity-modulated** rather than applied as a constant master: the
film grade rises and falls with the wake intensity signal, and warp/density vary with it.

- Palette: ink `#0E0B08`, tungsten amber `#C8A35E`, lamp glow `#E8C887`, silver-bone
  `#D8D2C4`, sepia `#6B5640`, verdigris `#4A6B66` (sparingly). Use as an available palette,
  not a fixed wash.
- Type: **Bodoni Moda** for intertitles/title cards (caps, wide tracking), **EB Garamond**
  for the drifting text, **Courier Prime** for archival captions/metadata.
- The projection-gate-in-a-dark-booth and the cinema grain/weave/flicker/dust/vignette
  remain available signatures, but they are one mode among many — modulated by intensity,
  not the permanent unifying treatment over every source.
- Respect `prefers-reduced-motion`: dampen weave/flicker/dust, keep dissolves slow.

## Coding conventions

- TypeScript strict. No `any` in committed code. ESLint + Prettier.
- No browser storage for shareable state (use URL params for seed/surreality/tempo).
  localStorage is allowed only for non-essential UI prefs.
- No secrets in client code. Pipeline secrets via env.
- Tests: Vitest for `dream/` and `manifest/`; Playwright smoke test for the app.
