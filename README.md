# DREAMREEL

*"bababadalgharaghtakamminarronnkonnbronntonnerronntuonnthunntrovarrhounawnskawntoohoohoordenenthurnuk!"* - *Finnegans Wake* by James Joyce

A surreal **dream-sequence generator**. Press play and watch a seamless, ever-changing mashup
of public-domain media — vintage film, photographs, art, maps, title cards — with drifting
stream-of-consciousness text and a generative ambient audio bed, all under an old-cinema
treatment (grain, gate-weave, flicker, dust, vignette).

The variation does not come from pre-baked reels. It comes from a **seeded walk over a tagged
asset pool** in CLIP embedding space (the *Dreamwalker*). There are **zero LLM / network
inference calls at runtime** — the only AI spend is the one-time offline tagging pass. A given
`?seed=…&s=…&t=…` URL reproduces the exact dream script.

```
            OFFLINE (Python)                         RUNTIME (browser, no inference)
 ┌───────────────────────────────────┐      ┌──────────────────────────────────────────┐
 │ ingest   Openverse + Archive.org   │      │  Manifest (assets+texts+embeddings+moods)  │
 │          + museum CC0   ──► license│      │            │                                │
 │          gate (CC0/PD/CC-BY only)  │      │            ▼                                │
 │ embed    open_clip → embeddings    │ ───► │  Dreamwalker  ── drift + leap + softmax ──┐ │
 │          mood axes = text contrasts│ R2   │   (seeded, deterministic dream script)    │ │
 │ publish  transcode → QC → R2 +     │      │            │                              │ │
 │          versioned manifest        │      │   3 desynced clocks: image · ghost · text │ │
 └───────────────────────────────────┘      │            ▼                              ▼ │
                                             │  three.js compositor → gl-transitions →    │
                                             │  film post-FX (1 merged pass) → <canvas>   │
                                             │  Tone.js mood-driven ambient bed           │
                                             └──────────────────────────────────────────┘
```

## Repository layout

| Path | What |
| --- | --- |
| `app/` | Vite + React + TS + Tailwind SPA. Imperative three.js compositor, film post-FX, the Dreamwalker, Tone.js audio, Zustand store. |
| `pipeline/` | Python offline corpus build: `ingest → embed → publish`. Produces the static manifest. |
| `infra/` | Cloudflare Pages + R2 (`wrangler.toml`). |
| `CLAUDE.md` | The single source of truth: architecture, contracts, aesthetic tokens, license rules. |
| `NOTICE`, `CREDITS.md` | Third-party + asset attributions. |

## Run the app

```bash
cd app
npm install
npm run dev            # http://localhost:5173 — plays against the bundled seed manifest
```

Point it at a real corpus by setting `VITE_MANIFEST_URL` (an R2/CDN manifest URL) at build
time; if unset or unreachable the app falls back to `public/manifest.seed.json`.

Quality gates (all run in CI):

```bash
npm run typecheck && npm run lint && npm run test && npm run build
npm run license:check        # fails on AGPL/GPL/source-available production deps
npm run test:e2e             # Playwright smoke: load, play, 30s, no console errors
```

Dev render harness (compositor / transitions / ghost / post-FX / procedural):
`http://localhost:5173/?harness=1`.

## Build the corpus

```bash
cd pipeline
make install-embed           # heavy deps: open_clip, torch, img2dataset, boto3
make corpus                  # ingest → embed → publish, writes out/manifest.json
make corpus UPLOAD=1         # also push media + versioned manifest to R2 (needs R2_* env)
```

Without the heavy extras (`make install` only), `make corpus` still runs using a deterministic
**offline fallback embedder**, producing a structurally valid manifest the app accepts — useful
for CI and plumbing checks. Real CLIP embeddings require the `embed` extra.

Required environment (never committed):

| Var | Used by |
| --- | --- |
| `OPENVERSE_CLIENT_ID` / `OPENVERSE_CLIENT_SECRET` | higher Openverse rate limits (optional) |
| `SMITHSONIAN_API_KEY` | Smithsonian CC0 ingest (optional) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE` | publish to R2 |

## License policy (this is a commercial product)

Three independent backstops enforce the same rule — ship only **MIT / BSD / Apache-2.0 / Zlib /
ISC / CC0 / public-domain / OFL** code and **CC0 / PD / CC-BY (with rendered attribution)**
media:

1. **Pipeline gate** (`pipeline/ingest/licenses.py`) — rejects CC-BY-NC/ND/SA and unknown
   licenses at ingest, logging every rejection.
2. **CI dependency scan** (`app` + `pipeline` license jobs) — fails the build on any
   copyleft / source-available dependency.
3. **On-screen attribution** — the caption strip renders the attribution for every CC-BY
   asset; the contract requires it.

We use Archive.org's **HTTP API**, never the AGPL `internetarchive` client. Every shipped asset
carries `license`, `source`, and (when required) `attribution`. See `CREDITS.md`
(`cd app && npm run gen:credits`) and `NOTICE`.

## Deploy

Cloudflare Pages serves the SPA; R2 holds media + manifests. The `Deploy` workflow builds and
publishes on push to `main` (needs `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and
optionally `DREAMREEL_MANIFEST_URL`). Hashed assets are cached immutably; the `latest` manifest
pointer is short-cached. See `infra/wrangler.toml`.

## How the dream works

The Dreamwalker keeps a point in CLIP embedding space, **drifts** it (seeded Brownian noise)
and occasionally **leaps** (non-sequitur), then selects the next asset by **cosine similarity
through a softmax** whose temperature — plus the leap probability — is the *Surreality* control.
Low surreality → coherent, near-argmax picks; high surreality → near-uniform, dreamlike jumps.
Image, ghost (double-exposure) and text run on three independent clocks so the layers
recombine. Everything stochastic routes through one seeded PRNG, which is what makes a seed
shareable. Original implementation of the Infinite-Jukebox approach — no external code copied.
