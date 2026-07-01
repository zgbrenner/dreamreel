# AGENTS.md

## Cursor Cloud specific instructions

DREAMREEL is a monorepo with three independently-set-up components. The **primary product** is
`app/` (the browser SPA); `pipeline/` and `trackfx/` are offline Python dev tooling. Standard commands
live in `README.md`, `docs/HANDOFF.md`, `app/package.json`, `pipeline/Makefile`, and each
`pyproject.toml` — prefer those. Notes below are the non-obvious startup/run caveats for this VM.

### Environment layout (already provisioned by the update script)
- `app/` uses **npm** with `app/package-lock.json` (Node 22). Run app commands from `app/`.
- `pipeline/` and `trackfx/` each have their **own venv at `<dir>/.venv`** (git-ignored). Activate the
  matching venv, or call its `.venv/bin/python` directly. **Keep them separate on purpose:** the
  pipeline test suite must run **without torch** (see gotcha below), while `trackfx` requires torch.
- `python3-venv` is a system package (installed once, lives in the VM snapshot); the update script only
  (re)creates the venvs and installs Python deps into them.

### Running the app (the product)
- Dev server: from `app/`, `npm run dev` → http://localhost:5173. Use tmux for long-running servers.
- **Media/CORS reality (expected, not a bug):** the bundled dev seed (`app/public/manifest.seed.json`)
  and the live R2 manifest both point visual assets at **third-party origins** — `archive.org` (all
  **video**), `commons.wikimedia.org`, `iiif.wellcomecollection.org`, `images.metmuseum.org` (images).
  `archive.org` sends **no CORS header**, so in-browser **video always fails to load and the app
  degrades to its procedural fallback** (grainy/abstract texture) — by design (see
  `render/textureLoader.ts`; the e2e smoke test explicitly filters CORS/network errors as ignorable).
  Museum/Wikimedia **images do load** and appear as real artwork. So a `localhost` dream shows real
  still imagery + drifting text + working controls, but not the film clips.
- Richer visual demo: point dev at the real corpus with
  `VITE_MANIFEST_URL="https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json" npm run dev`
  (images then stream in; videos still CORS-fail as above).
- Core UX is a single verb: **PLAY/PAUSE**, **NEW DREAM** (new `?seed=`), **SOUND** toggle. `?wake=0`
  opts into the classic reel; `?harness=1` is the render dev harness.

### Tests / checks
- App (from `app/`): `npm run typecheck` (**must be `tsc -b`**, not plain `tsc -p`), `npm run lint`,
  `npm run test` (vitest), `npm run build`, `npm run license:check`, `npm run test:e2e` (Playwright;
  chromium is installed in the snapshot — if missing, `npx playwright install --with-deps chromium`).
- **e2e gotcha:** Playwright rebuilds + serves on port **4173** and `reuseExistingServer` reuses a stale
  `npm run preview` there → false-green. Kill anything on 4173 before `npm run test:e2e`; a real run
  takes ~60s.
- Pipeline (from `pipeline/`, its venv): `python -m pytest -q` and `python scripts/check_licenses.py`.
- trackfx (from `trackfx/`, its venv): `python -m pytest -q`.

### Pipeline gotcha (important)
- `pipeline/tests/test_carry_through.py` **fails locally if `torch` is installed** (the real CLIP
  embedder can't decode the test's fake jpg). The pipeline venv is intentionally torch-less so the full
  suite passes; if you add torch there, run `python -m pytest -q -k "not carry_through"`.
- Heavy pipeline extras (`embed`/`sprites`/`entities`/`track`, i.e. torch/open_clip/CLAP/RAM++) and R2
  upload are **not installed** — they're only needed to (re)build/ship the corpus, never to run the app
  or the default test suites. The app runs entirely off the precomputed static manifest (zero runtime
  inference).
