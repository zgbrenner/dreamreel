# DREAMREEL — Round 1: Weirder/Scarier Corpus (Design)

_Date: 2026-06-18. Status: approved, ready for plan._

## Goal

Re-curate the asset pool from "pretty scenery" to a **broad uncanny** corpus spanning three
veins — clinical/anatomical, occult/ritual, and liminal-nature — blended **mostly-uncanny**
with a few familiar **anchor** themes kept for dream-logic contrast and coherence troughs.

This is a **pipeline-only** round: no app/renderer/dream changes. The determinism contract is
unaffected — the manifest is still a static tagged pool, and a given `?seed` still produces the
same seeded walk over whatever pool ships. The corpus simply becomes weirder.

The existing mood axes already include `uncanny` and `ominous`, so a weirder pool will naturally
drive the wake-mode filter catalog (kaleidoscope/solarize/etc.) harder — no tuning required for
this round, though it may surface tuning opportunities later.

## Non-goals

- No app, renderer, `dream/`, or `audio/` changes.
- No video (that is Round 4) — Archive.org film ingest stays as-is and is not exercised here.
- No mood-axis redefinition — the `uncanny`/`ominous` contrasts in `embed/mood_axes.py` are
  already appropriate.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Aesthetic flavor | **Broad uncanny** — all three veins (clinical, occult, liminal-nature) |
| Replace vs blend | **Blend, mostly-uncanny** — keep a few strong anchor themes |
| Sourcing scope | Retarget existing sources **and add a new Wellcome Collection ingester** |
| Curation QC | **Mood-score threshold** (automated, deterministic; anchors exempt) |
| Deliverable | **Machinery + attempt live build** (ingest is live-reachable; embed/upload best-effort) |
| Size target | ~180–220 assets after curation (current corpus is 135) |
| Anchors | `ruins`, `faces`, `antique photograph` |
| Museums default | **On by default** in `make corpus` (was opt-in via `--museums`) |

## Components

### 1. Retargeted query catalogs — `ingest/openverse.py`, `ingest/museums.py`

Replace the tasteful `THEMES` lists with uncanny query sets, organized as labeled groups so the
anchors and the three veins are legible in the source:

- **Clinical:** `anatomical illustration`, `dissection plate`, `human skeleton`, `x-ray`,
  `medical specimen`, `phrenology head`, `taxidermy`
- **Occult:** `death mask`, `memento mori`, `occult symbol`, `alchemical diagram`,
  `spirit photography`, `ritual mask`
- **Liminal nature:** `deep sea creature`, `fungus`, `cave`, `decay`, `moth`, `abandoned`
- **Anchors (kept, exempt from curation):** `ruins`, `faces`, `antique photograph`

The Met ingester uses the same uncanny vocabulary (its CC0 open-access set is rich in masks,
memento mori, arms-and-armor, anatomical prints). Smithsonian uses it too when a key is present.
Museums run **by default** — `ingest/run.py` enables Met (+ Smithsonian if keyed) without the
`--museums` flag, and `make corpus` reflects that.

The exact theme→vein grouping lives as named lists/dicts in the source so a reader can see which
queries belong to which vein and which are anchors. The Openverse `THEMES`, museum `THEMES`, and
the shared anchor list must stay consistent with the curation filter (component 4).

### 2. New Wellcome Collection ingester — `ingest/wellcome.py`

Wellcome Collection is the richest public-domain medical/anatomical/occult archive. It exposes a
public catalogue API at `https://api.wellcomecollection.org/catalogue/v2/images` (no key for
basic use). Items carry CC0 / PDM / CC-BY licenses — all shippable under our policy (CC-BY
attribution is already rendered by the app; CC-BY-NC and unknown are rejected by the existing
license gate in `make_candidate`).

Implementation notes:

- **Verify the response shape against a real payload first.** Before writing the ingester we curl
  one live response and record it as the test fixture. We do NOT invent field names. Specifically
  confirm: where the license id lives, how to construct a usable image URL (the IIIF
  `.../full/!1024,1024/0/default.jpg` form vs the thumbnail), creator/attribution fields, and the
  landing-page URL.
- Map each hit through the existing `make_candidate(...)` so the license gate, normalization, and
  rejection reporting are reused unchanged.
- Tag each candidate with its query theme + vein so curation and downstream tagging work.
- Polite pagination + `User-Agent`, mirroring the Openverse ingester's etiquette (timeouts,
  429 backoff, sleeps).
- Wire into `ingest/run.py` alongside Openverse / Archive / museums, with a `--no-wellcome` flag
  for symmetry with the other `--no-*` switches.

### 3. Mood-threshold curation filter — `embed/curate.py` (called from `build_manifest`)

After CLIP embedding and mood projection, before the manifest is written, drop any asset whose
`max(uncanny, ominous)` mood score is below a tuned cutoff — **except** assets whose `query_theme`
is a kept anchor, which always pass through (preserving the familiar-contrast anchors regardless
of their mood score).

- Pure function: `curate(assets, *, cutoff, anchors) -> (kept, dropped)`; deterministic.
- `build_manifest` calls it after mood projection and **logs counts** — total in, kept, dropped,
  and the cutoff used — so curation is never a silent truncation.
- Cutoff is a named constant, tunable; start around `0.55` and adjust against the live sample.
- Anchors are read from the single shared source of truth (component 4).

### 4. Anchor list — single source of truth

A small shared constant (e.g. `ANCHOR_THEMES = ("ruins", "faces", "antique photograph")`) in one
module, imported by both the ingest query catalogs and the curation filter, so "what is exempt
from curation" is defined exactly once.

## Data flow

```
ingest.run                          embed.download        embed.build_manifest         publish.run
 ├ openverse (uncanny + anchors)
 ├ wellcome  (uncanny)        ──►  candidates.jsonl ──►  CLIP embed                 ──►  R2
 ├ met       (uncanny)              (download+resize)     mood project
 └ smithsonian (uncanny, keyed)                           curate (mood threshold,
                                                            anchors exempt)  ◄── new
                                                          → manifest.json
```

## Testing

- **Wellcome ingester** (`tests/test_ingesters.py` or a new `test_wellcome.py`): unit test with a
  recorded real fixture — license id mapping (CC0/PDM/CC-BY kept, NC/unknown rejected), image URL
  construction, creator/attribution carry-through.
- **Curate filter** (new `tests/test_curate.py`): below-cutoff asset dropped; anchor asset exempt
  even below cutoff; logged counts correct; empty/all-kept edge cases.
- **Existing tests stay green:** `test_ingesters`, `test_carry_through`, `test_manifest_shape`,
  `test_licenses`, `test_no_copyleft_client`. Note: `test_carry_through` fails locally only when
  `torch` is installed (known, documented in HANDOFF); CI's torch-less venv passes.
- License/CI: the copyleft grep gate must still pass — the Wellcome ingester uses plain `requests`,
  never an AGPL client.

## This session's execution boundary

Environment probe (2026-06-18): Openverse + Wellcome APIs return `200` (live ingest works), but
`torch` / `open_clip` / `boto3` / `wrangler` are absent and R2 creds are unset.

1. Build all four components via TDD (mocked/fixture HTTP — no live calls in tests).
2. Run a **live ingest** to confirm the uncanny queries return real, on-target candidates and to
   produce a real Wellcome fixture; inspect `candidates.jsonl` + `rejections.jsonl`.
3. Best-effort: if embed deps install cheaply, embed a small sample to sanity-check the curation
   cutoff against real mood scores. Otherwise document the expected behavior.
4. **Hand off the full rebuild + R2 re-upload to the owner** (needs torch + boto3/wrangler + R2
   creds, none available here). Update `docs/HANDOFF.md` with the new corpus state and how to
   rebuild.

## Risks / mitigations

- **Wellcome API shape guessed wrong** → verify against a live payload before coding; fixture is a
  real recorded response.
- **Cutoff too aggressive (corpus too small) or too loose (noise survives)** → cutoff is a single
  named constant; the live sample informs the starting value; anchors guarantee a floor of
  familiar imagery regardless.
- **Query noise / irrelevant hits** → that is exactly what the mood-threshold curation filter
  removes; anchors are the only exemption.
- **CC-BY attribution** → already handled end-to-end (gate keeps CC-BY with attribution; app
  renders it). No new attribution code needed, only correct field carry-through.
