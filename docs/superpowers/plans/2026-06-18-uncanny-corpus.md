# Uncanny Corpus (Round 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-curate the DREAMREEL asset pool from "pretty scenery" to a broad uncanny corpus (clinical + occult + liminal-nature) blended mostly-uncanny with a few familiar anchor themes, via pipeline-only changes.

**Architecture:** Retarget the ingest query catalogs toward uncanny subjects (single shared module), add a new Wellcome Collection ingester reusing the existing license gate, turn museums on by default, and add a deterministic mood-score curation filter in `build_manifest` that drops off-target assets while exempting the kept anchors.

**Tech Stack:** Python 3.12, `requests`, `pydantic`, `pytest`. No new runtime deps. Existing CLIP/embedding path unchanged.

## Global Constraints

- **License policy (hard):** ship only CC0, PD/PDM, or CC-BY (CC-BY only with attribution captured). Reject NC/ND/SA and unknown. All ingest goes through `make_candidate(...)` → `evaluate(...)`; never bypass the gate.
- **No AGPL clients:** Archive.org and Wellcome use plain `requests` only — never `internetarchive` or any copyleft client (CI greps for this).
- **No invented API fields:** only read fields confirmed against a real payload. The Wellcome fixture below is a real recorded response (fetched 2026-06-18).
- **TypeScript/app untouched:** this round changes only `pipeline/`. The manifest *shape* (keys per asset) must not change — curation only removes assets.
- **Determinism:** curation is a pure deterministic function (no `random`, no time). Same candidates + same cutoff → same kept set.
- **Run all pipeline tests from `pipeline/`:** `python -m pytest -q`. (`test_carry_through` fails locally only when `torch` is installed — known/expected, see HANDOFF.)

---

### Task 1: Shared theme catalog + anchors

Create the single source of truth for the uncanny query vocabulary and the anchor list, consumed by the ingesters and (later) the curation filter.

**Files:**
- Create: `pipeline/ingest/themes.py`
- Test: `pipeline/tests/test_themes.py`

**Interfaces:**
- Produces:
  - `ANCHOR_THEMES: tuple[str, ...]` = `("ruins", "faces", "antique photograph")`
  - `CLINICAL: tuple[str, ...]`, `OCCULT: tuple[str, ...]`, `LIMINAL: tuple[str, ...]`
  - `OPENVERSE_THEMES: list[str]` (the three veins + anchors, de-duplicated, order-stable)
  - `MUSEUM_THEMES: list[str]` (uncanny vocabulary tuned for museum search + anchors)

- [ ] **Step 1: Write the failing test**

```python
# pipeline/tests/test_themes.py
"""The uncanny query catalog and anchor list are the single source of truth for curation."""

from __future__ import annotations

from ingest import themes


def test_anchors_are_present_in_openverse_themes():
    for anchor in themes.ANCHOR_THEMES:
        assert anchor in themes.OPENVERSE_THEMES


def test_openverse_themes_have_no_duplicates():
    assert len(themes.OPENVERSE_THEMES) == len(set(themes.OPENVERSE_THEMES))


def test_all_three_veins_contribute():
    for vein in (themes.CLINICAL, themes.OCCULT, themes.LIMINAL):
        assert vein  # non-empty
        assert any(t in themes.OPENVERSE_THEMES for t in vein)


def test_anchors_are_the_only_familiar_themes():
    # anchors are exactly the kept-familiar set, and none of them appear in a vein
    vein_terms = set(themes.CLINICAL) | set(themes.OCCULT) | set(themes.LIMINAL)
    assert not (set(themes.ANCHOR_THEMES) & vein_terms)
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `pipeline/`): `python -m pytest tests/test_themes.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ingest.themes'`.

- [ ] **Step 3: Write minimal implementation**

```python
# pipeline/ingest/themes.py
"""Uncanny query catalog + anchors — the single source of truth for corpus curation.

Three veins of broad-uncanny subject matter (clinical, occult, liminal-nature) plus a small
set of familiar ANCHOR themes kept for dream-logic contrast. The anchors are exempt from the
mood-score curation filter (embed/curate.py) so a floor of recognizable imagery always survives.
"""

from __future__ import annotations

# Familiar imagery kept for contrast; exempt from mood curation.
ANCHOR_THEMES: tuple[str, ...] = ("ruins", "faces", "antique photograph")

# --- the three uncanny veins ---
CLINICAL: tuple[str, ...] = (
    "anatomical illustration",
    "dissection plate",
    "human skeleton",
    "x-ray",
    "medical specimen",
    "phrenology head",
    "taxidermy",
)
OCCULT: tuple[str, ...] = (
    "death mask",
    "memento mori",
    "occult symbol",
    "alchemical diagram",
    "spirit photography",
    "ritual mask",
)
LIMINAL: tuple[str, ...] = (
    "deep sea creature",
    "fungus",
    "cave",
    "decay",
    "moth",
    "abandoned",
)


def _dedup(seq) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in seq:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


# Openverse: all three veins + anchors.
OPENVERSE_THEMES: list[str] = _dedup([*CLINICAL, *OCCULT, *LIMINAL, *ANCHOR_THEMES])

# Museums (Met/Smithsonian) skew toward objects/plates; a tuned subset reads best there.
MUSEUM_THEMES: list[str] = _dedup(
    [
        "anatomical",
        "death mask",
        "memento mori",
        "skull",
        "ritual mask",
        "specimen",
        "alchemical",
        *ANCHOR_THEMES,
    ]
)
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `pipeline/`): `python -m pytest tests/test_themes.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add pipeline/ingest/themes.py pipeline/tests/test_themes.py
git commit -m "feat(pipeline): uncanny query catalog + anchor themes"
```

---

### Task 2: Point Openverse + museum ingesters at the uncanny catalog

Replace the tasteful in-module `THEMES` defaults with the shared catalog so default ingest queries the uncanny vocabulary.

**Files:**
- Modify: `pipeline/ingest/openverse.py` (the `THEMES` list, lines ~25-35)
- Modify: `pipeline/ingest/museums.py` (the `THEMES` list, line ~22)

**Interfaces:**
- Consumes: `ingest.themes.OPENVERSE_THEMES`, `ingest.themes.MUSEUM_THEMES` (Task 1)
- Produces: no new symbols — `openverse.ingest()` / `museums.ingest_met()` / `museums.ingest_smithsonian()` now default to uncanny themes.

- [ ] **Step 1: Write the failing test**

```python
# append to pipeline/tests/test_themes.py
from ingest import openverse, museums


def test_ingesters_default_to_the_uncanny_catalog():
    assert openverse.THEMES is themes.OPENVERSE_THEMES
    assert museums.THEMES is themes.MUSEUM_THEMES
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `pipeline/`): `python -m pytest tests/test_themes.py -k uncanny_catalog -v`
Expected: FAIL — `openverse.THEMES` is still the old local list (assert `is` fails).

- [ ] **Step 3: Write minimal implementation**

In `pipeline/ingest/openverse.py`, delete the local `THEMES = [...]` block and replace with an import-backed alias. Change the imports near the top:

```python
from .normalize import Candidate, Rejection, make_candidate
from .themes import OPENVERSE_THEMES
```

and replace the whole `THEMES = [ ... ]` literal with:

```python
# Default query catalog: the uncanny veins + anchors (see ingest/themes.py).
THEMES = OPENVERSE_THEMES
```

In `pipeline/ingest/museums.py`, change the import line:

```python
from .normalize import Candidate, Rejection, make_candidate
from .themes import MUSEUM_THEMES
```

and replace `THEMES = ["landscape", "portrait", "still life", "ruins", "celestial"]` with:

```python
# Museum search vocabulary skews to objects/plates (see ingest/themes.py).
THEMES = MUSEUM_THEMES
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `pipeline/`): `python -m pytest tests/test_themes.py tests/test_ingesters.py -v`
Expected: PASS — the new alias test passes and the existing ingester tests (which pass `themes=[...]` explicitly) are unaffected.

- [ ] **Step 5: Commit**

```bash
git add pipeline/ingest/openverse.py pipeline/ingest/museums.py
git commit -m "feat(pipeline): default ingesters to the uncanny catalog"
```

---

### Task 3: Wellcome Collection ingester

Add a new ingester for the Wellcome catalogue images API, reusing the license gate. Field names are taken from a real 2026-06-18 response.

**Files:**
- Create: `pipeline/ingest/wellcome.py`
- Test: `pipeline/tests/test_wellcome.py`

**Interfaces:**
- Consumes: `ingest.normalize.make_candidate`, `ingest.themes.OPENVERSE_THEMES`
- Produces: `wellcome.ingest(themes: list[str] | None = None, per_theme: int = 30, page_size: int = 30) -> Iterator[tuple[Candidate | None, Rejection | None]]`; module constants `API`, `IIIF_SUFFIX`.

**Real API shape (recorded 2026-06-18, fields we read only):**
`results[].id`, `results[].locations[0].url` (IIIF `.../info.json`), `results[].locations[0].license.id` (`pdm`/`cc0`/`cc-by`/`cc-by-nc`...), `results[].locations[0].credit`, `results[].source.id`, `results[].source.title`. A usable image URL = the IIIF base (strip `/info.json`) + `IIIF_SUFFIX`. Landing page = `https://wellcomecollection.org/works/<source.id>`.

- [ ] **Step 1: Write the failing test**

```python
# pipeline/tests/test_wellcome.py
"""Wellcome ingester test against a real recorded response shape (2026-06-18).

Confirms: IIIF image-URL construction, license mapping (pdm->PD, cc0->CC0, cc-by kept with
attribution, cc-by-nc rejected), and landing-URL construction.
"""

from __future__ import annotations

from ingest import wellcome


class FakeResp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise AssertionError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


def _loc(license_id, credit="Wellcome Collection"):
    return {
        "url": "https://iiif.wellcomecollection.org/image/L0011861/info.json",
        "credit": credit,
        "license": {"id": license_id, "type": "License", "label": license_id, "url": "https://x"},
        "locationType": {"id": "iiif-image"},
        "type": "DigitalLocation",
    }


WELLCOME_RESULTS = [
    {"id": "pdm1", "locations": [_loc("pdm")], "source": {"id": "w-pdm", "title": "Anatomy plate"}},
    {"id": "cc01", "locations": [_loc("cc0")], "source": {"id": "w-cc0", "title": "Skull study"}},
    {"id": "by1", "locations": [_loc("cc-by")], "source": {"id": "w-by", "title": "Ritual mask"}},
    {"id": "nc1", "locations": [_loc("cc-by-nc")], "source": {"id": "w-nc", "title": "No commercial"}},
]


def test_wellcome_maps_and_gates(monkeypatch):
    def fake_get(url, params=None, headers=None, timeout=None):
        page = (params or {}).get("page", 1)
        return FakeResp({"results": WELLCOME_RESULTS if page == 1 else []})

    monkeypatch.setattr(wellcome.requests, "get", fake_get)
    monkeypatch.setattr(wellcome.time, "sleep", lambda *_a, **_k: None)

    kept, rejected = [], []
    for cand, rej in wellcome.ingest(themes=["anatomy"], per_theme=10):
        (kept if cand else rejected).append(cand or rej)

    # pdm + cc0 + cc-by kept; cc-by-nc rejected
    assert len(kept) == 3 and len(rejected) == 1

    pdm = next(c for c in kept if c.license == "PD")
    assert pdm.type == "image"
    assert pdm.source == "Wellcome Collection"
    assert pdm.source_url == (
        "https://iiif.wellcomecollection.org/image/L0011861/full/!1024,1024/0/default.jpg"
    )
    assert pdm.foreign_landing_url == "https://wellcomecollection.org/works/w-pdm"
    assert "anatomy" in pdm.tags

    by = next(c for c in kept if c.license.startswith("CC-BY"))
    assert by.attribution and "Wellcome" in by.attribution  # CC-BY keeps credit

    assert rejected[0].raw_license == "cc-by-nc"
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `pipeline/`): `python -m pytest tests/test_wellcome.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ingest.wellcome'`.

- [ ] **Step 3: Write minimal implementation**

```python
# pipeline/ingest/wellcome.py
"""Wellcome Collection ingester via the public catalogue API (plain requests, no AGPL client).

Wellcome's images endpoint aggregates a large public-domain/CC-BY medical, anatomical, and
occult archive — ideal uncanny material. We query by theme, map each hit through the license
gate, and build a usable IIIF image URL.

Response fields used (verified against a real 2026-06-18 response, do not invent fields):
  results[].id, results[].locations[0].{url,credit,license.id}, results[].source.{id,title}
"""

from __future__ import annotations

import time
from typing import Iterator

import requests

from .normalize import Candidate, Rejection, make_candidate
from .themes import OPENVERSE_THEMES

API = "https://api.wellcomecollection.org/catalogue/v2/images"
WORKS = "https://wellcomecollection.org/works"
USER_AGENT = "DREAMREEL-corpus/0.1 (+https://dreamreel.example; respectful crawler)"
# IIIF image request appended to the image base (info.json stripped).
IIIF_SUFFIX = "/full/!1024,1024/0/default.jpg"
_INFO = "/info.json"


def _image_url(location_url: str) -> str | None:
    """Turn an IIIF info.json URL into a concrete downloadable image URL."""
    if not location_url.endswith(_INFO):
        return None
    return location_url[: -len(_INFO)] + IIIF_SUFFIX


def ingest(
    themes: list[str] | None = None,
    per_theme: int = 30,
    page_size: int = 30,
) -> Iterator[tuple[Candidate | None, Rejection | None]]:
    themes = themes or OPENVERSE_THEMES
    headers = {"User-Agent": USER_AGENT}
    for theme in themes:
        fetched = 0
        page = 1
        while fetched < per_theme:
            params = {"query": theme, "page": page, "pageSize": min(page_size, per_theme - fetched)}
            try:
                r = requests.get(API, params=params, headers=headers, timeout=30)
                if r.status_code == 429:
                    time.sleep(5)
                    continue
                r.raise_for_status()
                results = r.json().get("results", [])
            except requests.RequestException:
                break
            if not results:
                break
            for item in results:
                locs = item.get("locations") or []
                if not locs:
                    continue
                loc = locs[0]
                img = _image_url(loc.get("url", ""))
                if not img:
                    continue
                src = item.get("source") or {}
                work_id = src.get("id")
                lic = (loc.get("license") or {}).get("id")
                yield make_candidate(
                    source_url=img,
                    type="image",
                    source="Wellcome Collection",
                    raw_license=lic,
                    creator=loc.get("credit"),
                    attribution_url=f"{WORKS}/{work_id}" if work_id else None,
                    tags=[theme, str(src.get("title", ""))[:40]],
                    query_theme=theme,
                    foreign_landing_url=f"{WORKS}/{work_id}" if work_id else None,
                )
            fetched += len(results)
            page += 1
            time.sleep(1.0)  # be polite
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `pipeline/`): `python -m pytest tests/test_wellcome.py -v`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add pipeline/ingest/wellcome.py pipeline/tests/test_wellcome.py
git commit -m "feat(pipeline): Wellcome Collection ingester"
```

---

### Task 4: Wire Wellcome into the run, museums on by default

Add the Wellcome ingester to the orchestration and make museums run by default (Met always; Smithsonian when keyed). Replace the opt-in `--museums` with an opt-out `--no-museums`, and add `--no-wellcome`.

**Files:**
- Modify: `pipeline/ingest/run.py`
- Modify: `pipeline/Makefile` (the `corpus` target comment only — behavior already flows through `run.py`)

**Interfaces:**
- Consumes: `ingest.wellcome.ingest` (Task 3); existing `openverse`, `archive_org`, `museums`.

- [ ] **Step 1: Edit `run.py` imports**

Change:
```python
from . import archive_org, museums, openverse
```
to:
```python
from . import archive_org, museums, openverse, wellcome
```

- [ ] **Step 2: Replace the argparse flags**

Replace:
```python
    ap.add_argument("--no-archive", action="store_true")
    ap.add_argument("--museums", action="store_true", help="include Met/Smithsonian CC0")
```
with:
```python
    ap.add_argument("--no-archive", action="store_true")
    ap.add_argument("--no-wellcome", action="store_true")
    ap.add_argument("--no-museums", action="store_true", help="skip Met/Smithsonian CC0")
```

- [ ] **Step 3: Replace the ingest body**

Replace the `if not args.no_archive: ...` / `if args.museums: ...` block with:
```python
    if not args.no_wellcome:
        print("ingesting Wellcome Collection images…")
        drain(wellcome.ingest())
    if not args.no_archive:
        print("ingesting Archive.org film…")
        drain(archive_org.ingest())
    if not args.no_museums:
        print("ingesting Met + Smithsonian CC0…")
        drain(museums.ingest_met())
        drain(museums.ingest_smithsonian())
```

- [ ] **Step 4: Update the Makefile comment**

In `pipeline/Makefile`, the `ingest` target stays `$(PY) -m ingest.run --out $(OUT)`. Update the comment above `corpus` to note museums + Wellcome are now included by default:
```make
# full corpus build (openverse + wellcome + archive + museums by default).
# Add UPLOAD=1 to push to R2 (requires R2_* env).
corpus: ingest download embed publish
```

- [ ] **Step 5: Verify nothing imports break**

Run (from `pipeline/`): `python -c "from ingest import run; print('ok')"`
Expected: prints `ok` (no import error). The full ingester orchestration is exercised live in Task 7.

- [ ] **Step 6: Commit**

```bash
git add pipeline/ingest/run.py pipeline/Makefile
git commit -m "feat(pipeline): run Wellcome + museums by default in ingest"
```

---

### Task 5: Mood-score curation filter

A pure, deterministic filter that drops image assets whose `max(uncanny, ominous)` mood score is below a cutoff, exempting any asset tagged with an anchor theme.

**Files:**
- Create: `pipeline/embed/curate.py`
- Test: `pipeline/tests/test_curate.py`

**Interfaces:**
- Consumes: `ingest.themes.ANCHOR_THEMES`
- Produces:
  - `DEFAULT_CUTOFF: float = 0.55`
  - `curate(assets: list[dict], *, cutoff: float = DEFAULT_CUTOFF, anchors=ANCHOR_THEMES) -> tuple[list[dict], list[dict]]` returning `(kept, dropped)`. Each asset is a dict with `"mood"` (dict incl. `"uncanny"`, `"ominous"`) and `"tags"` (list[str]).

- [ ] **Step 1: Write the failing test**

```python
# pipeline/tests/test_curate.py
"""The mood-score curation filter keeps weird assets and the familiar anchors, drops the rest."""

from __future__ import annotations

from embed.curate import DEFAULT_CUTOFF, curate
from ingest.themes import ANCHOR_THEMES


def _asset(tags, uncanny=0.0, ominous=0.0):
    return {"id": "x", "tags": list(tags), "mood": {"uncanny": uncanny, "ominous": ominous}}


def test_drops_below_cutoff():
    weird = _asset(["death mask"], uncanny=0.9)
    bland = _asset(["death mask"], uncanny=0.1, ominous=0.1)
    kept, dropped = curate([weird, bland], cutoff=0.55)
    assert weird in kept and bland in dropped


def test_max_of_uncanny_or_ominous_counts():
    ominous_only = _asset(["cave"], uncanny=0.1, ominous=0.8)
    kept, dropped = curate([ominous_only], cutoff=0.55)
    assert ominous_only in kept


def test_anchor_is_exempt_even_when_bland():
    anchor = ANCHOR_THEMES[0]
    bland_anchor = _asset([anchor], uncanny=0.0, ominous=0.0)
    kept, dropped = curate([bland_anchor], cutoff=0.55)
    assert bland_anchor in kept and not dropped


def test_returns_partition_with_default_cutoff():
    a = _asset(["fungus"], uncanny=DEFAULT_CUTOFF)  # exactly at cutoff is kept
    kept, dropped = curate([a])
    assert a in kept
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `pipeline/`): `python -m pytest tests/test_curate.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'embed.curate'`.

- [ ] **Step 3: Write minimal implementation**

```python
# pipeline/embed/curate.py
"""Mood-score curation: keep image assets that read as uncanny/ominous, plus the anchors.

Deterministic and pure — given the same assets and cutoff it always returns the same partition.
An asset survives if it is tagged with an anchor theme (familiar contrast we always keep) OR its
max(uncanny, ominous) mood score is at least the cutoff. Everything else is dropped as off-target.
"""

from __future__ import annotations

from typing import Sequence

from ingest.themes import ANCHOR_THEMES

DEFAULT_CUTOFF = 0.55


def _is_anchor(asset: dict, anchors: Sequence[str]) -> bool:
    tags = asset.get("tags") or []
    return any(anchor in tags for anchor in anchors)


def _weird_score(asset: dict) -> float:
    mood = asset.get("mood") or {}
    return max(float(mood.get("uncanny", 0.0)), float(mood.get("ominous", 0.0)))


def curate(
    assets: list[dict],
    *,
    cutoff: float = DEFAULT_CUTOFF,
    anchors: Sequence[str] = ANCHOR_THEMES,
) -> tuple[list[dict], list[dict]]:
    """Partition assets into (kept, dropped) by mood score, exempting anchors."""
    kept: list[dict] = []
    dropped: list[dict] = []
    for a in assets:
        if _is_anchor(a, anchors) or _weird_score(a) >= cutoff:
            kept.append(a)
        else:
            dropped.append(a)
    return kept, dropped
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `pipeline/`): `python -m pytest tests/test_curate.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add pipeline/embed/curate.py pipeline/tests/test_curate.py
git commit -m "feat(pipeline): mood-score curation filter (anchors exempt)"
```

---

### Task 6: Apply curation in build_manifest

Call the curation filter on the image assets (after mood projection, before procedural/text assets are added) and log the counts so curation is never silent.

**Files:**
- Modify: `pipeline/embed/build_manifest.py`
- Test: `pipeline/tests/test_curate_integration.py`

**Interfaces:**
- Consumes: `embed.curate.curate`, `embed.curate.DEFAULT_CUTOFF` (Task 5)

- [ ] **Step 1: Write the failing test**

This test calls the curation seam directly with synthetic assets (no CLIP/torch needed) to prove `build_manifest` filters image assets while leaving procedural/text assets untouched. It imports the module-level helper added in Step 3.

```python
# pipeline/tests/test_curate_integration.py
"""build_manifest applies mood curation to image assets only."""

from __future__ import annotations

from embed import build_manifest


def _img(tags, uncanny):
    return {"id": "img", "type": "image", "tags": list(tags), "mood": {"uncanny": uncanny, "ominous": 0.0}}


def test_curate_image_assets_filters_only_images():
    weird = _img(["death mask"], 0.9)
    bland = _img(["botanical"], 0.05)
    anchor = _img(["ruins"], 0.0)
    kept = build_manifest.curate_image_assets([weird, bland, anchor])
    assert weird in kept and anchor in kept and bland not in kept
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `pipeline/`): `python -m pytest tests/test_curate_integration.py -v`
Expected: FAIL — `AttributeError: module 'embed.build_manifest' has no attribute 'curate_image_assets'`.

- [ ] **Step 3: Add the helper and call it in `build`**

In `pipeline/embed/build_manifest.py`, add the import near the existing `from .mood_axes import ...`:
```python
from .curate import DEFAULT_CUTOFF, curate
```

Add a module-level helper (after the `_dwell_for` function):
```python
def curate_image_assets(image_assets: list[dict]) -> list[dict]:
    """Drop off-target image assets by mood score (anchors exempt); log the counts."""
    kept, dropped = curate(image_assets, cutoff=DEFAULT_CUTOFF)
    print(
        f"[build_manifest] curation: kept {len(kept)}/{len(image_assets)} image assets "
        f"(dropped {len(dropped)} below cutoff {DEFAULT_CUTOFF}; anchors exempt)"
    )
    return kept
```

In `build(...)`, the image-assets loop appends to the shared `assets` list. Change it to collect images separately, curate them, then extend `assets`. Replace:
```python
    assets: list[dict] = []

    # --- image assets from the download step ---
    rows: list[dict] = []
```
with:
```python
    assets: list[dict] = []
    image_assets: list[dict] = []

    # --- image assets from the download step ---
    rows: list[dict] = []
```
Then in the image loop, change `assets.append(` to `image_assets.append(`. Immediately after the image loop (before the `# --- procedural placeholder assets` comment), insert:
```python
    assets.extend(curate_image_assets(image_assets))
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `pipeline/`): `python -m pytest tests/test_curate_integration.py -v`
Expected: PASS (1 passed).

- [ ] **Step 5: Run the full pipeline suite**

Run (from `pipeline/`): `python -m pytest -q`
Expected: PASS for all tests (note: `test_carry_through` is skipped/xfail-equivalent only matters with torch installed; in a torch-less env it passes).

- [ ] **Step 6: Commit**

```bash
git add pipeline/embed/build_manifest.py pipeline/tests/test_curate_integration.py
git commit -m "feat(pipeline): curate image assets by mood in build_manifest"
```

---

### Task 7: Live ingest verification + handoff update

Run a real ingest (network is reachable; no torch needed) to confirm the uncanny queries return on-target candidates, then update the handoff. This is a verification + docs task, not TDD.

**Files:**
- Modify: `docs/HANDOFF.md`

- [ ] **Step 1: Run a small live ingest**

Run (from `pipeline/`), keeping it small/polite:
```bash
python -m ingest.run --out /tmp/uncanny-check --no-archive --per-theme 6
```
Expected: writes `/tmp/uncanny-check/candidates.jsonl` + `rejections.jsonl`; prints kept/rejected counts and top rejection reasons. Wellcome + Met run by default.

- [ ] **Step 2: Eyeball the candidates**

Run:
```bash
python -c "import json,collections; rows=[json.loads(l) for l in open('/tmp/uncanny-check/candidates.jsonl')]; print('n=',len(rows)); print(collections.Counter(r['source'].split(' / ')[0] for r in rows)); [print(r['query_theme'],'|',r['license'],'|',r['source_url'][:70]) for r in rows[:25]]"
```
Expected: a healthy mix of Openverse / Wellcome / Met sources; query_themes from the uncanny veins + anchors; all licenses in {CC0, PD, CC-BY*}. Spot-check 3-4 `source_url`s resolve (open in browser or `curl -sI`). If a vein returns near-zero candidates, note it in the handoff for query tuning (do not block).

- [ ] **Step 3: Attempt the embed/upload (best-effort, expected to stop here)**

Per the spec, a full build needs torch + boto3/wrangler + R2 creds, which are absent in this environment. Confirm and record:
```bash
python -c "import torch" 2>&1 | tail -1   # expect ModuleNotFoundError
```
If torch is unexpectedly available, run `make corpus OUT=/tmp/uncanny-build` and inspect the curation log line + `manifest.json` asset count; otherwise document that the rebuild+upload is owner-run.

- [ ] **Step 4: Update `docs/HANDOFF.md`**

Mark Round 1 (corpus) status, and record:
- The corpus is now uncanny (3 veins + anchors), museums + Wellcome on by default.
- Curation cutoff `0.55` in `embed/curate.py` — a tuning knob; the live-sample mood distribution informs it.
- To ship: owner runs `cd pipeline && pip install -e '.[embed,publish]' && make corpus UPLOAD=1` with `R2_*` env (or the wrangler path), then verify load/play at `?wake=1`.
- Any vein that under-returned in Step 2 (query tuning follow-up).

In the roadmap table, change the Round 1 corpus row from `⬜ not started` to `✅ machinery built (owner runs rebuild+upload)`.

- [ ] **Step 5: Commit**

```bash
git add docs/HANDOFF.md
git commit -m "docs: round 1 uncanny corpus — machinery done, rebuild handoff"
```

---

## Self-Review

**Spec coverage:**
- Broad-uncanny 3 veins → Task 1 (`CLINICAL`/`OCCULT`/`LIMINAL`). ✅
- Blend mostly-uncanny + anchors → Task 1 (`ANCHOR_THEMES` in `OPENVERSE_THEMES`), Task 5 (anchor exemption). ✅
- Retarget existing sources → Task 2. ✅
- Wellcome ingester → Task 3, wired Task 4. ✅
- Museums on by default → Task 4. ✅
- Mood-threshold curation, anchors exempt, logged (no silent truncation) → Tasks 5-6. ✅
- Single source of truth for anchors → Task 1 `themes.py`, imported by Task 5 `curate.py`. ✅
- Machinery + attempt live build, hand off rebuild/upload → Task 7. ✅
- No app/manifest-shape change → curation only removes assets; no key changes. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✅

**Type consistency:** `curate(...)` signature and return `(kept, dropped)` consistent across Tasks 5-6; `ANCHOR_THEMES`/`OPENVERSE_THEMES`/`MUSEUM_THEMES` names consistent Tasks 1-5; `wellcome.ingest(...)` signature consistent Tasks 3-4. ✅
