# Wake polish R4 (smarter clips, less flicker/old-TV/breathing, more blend, longer visible video, less text) — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Address live owner feedback on `?wake=1`: clips still show baked-in logos/archival text; too much on-screen drifting text; too flickery / not blended; old-TV filter and the "breathing" feedback too strong; video cut away too quickly.

**Architecture:** Pipeline picks a *content* frame per film (multi-frame CLIP scoring that avoids title-card/logo frames), used for both embedding and clip start. Renderer: lower the old-cinema film grade + flicker, reduce the feedback echo persistence, thin out the title-card text, cross-fade layer swaps (less flicker/more blend), and hold + visually pin a playing clip so it isn't ranked out of view.

**Tech Stack:** Python (CLIP via open_clip, ffmpeg/ffprobe, pytest); TypeScript (three.js, vitest).

## Global Constraints
- Determinism preserved: no new `Math.random`/wall-clock in the dream path; threshold changes don't alter RNG draw sequences; holds/fades are logical-clock/dt driven. (project)
- TS strict, no `any`; ESLint + Prettier clean. Existing tests updated where they pin a changed constant; others stay green.
- Pipeline: CLIP backend has `embed_texts`/`embed_images` (`clip_backend.py:24-29`). Hash-fallback text scores are noise → when `embedder.backend == "hash-fallback"` (or ffprobe fails) degrade to the single 30% frame (`clip_window.clip_start_seconds`). ffmpeg/ffprobe failures never crash the build.
- Internal manifest fields (`_local`, `_clipStart`) are stripped before R2 upload (extend the existing `_local` strip).
- ffmpeg/ffprobe at `C:\Users\zgbre\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1.1-full_build\bin` — prepend to PATH for any real-binary command (tests mock subprocess).

---

## Task A: Pipeline — content-aware frame selection

**Files:**
- Create: `pipeline/embed/frame_selector.py`
- Modify: `pipeline/embed/download.py` (`download_videos`), `pipeline/embed/build_manifest.py` (`build_video_assets`), `pipeline/publish/run.py` (`build_derivatives`), `pipeline/publish/upload_r2.py` (strip `_clipStart`)
- Test: `pipeline/tests/test_frame_selector.py`; update `test_download_videos.py`, `test_publish_video.py`

**Interfaces:**
- Produces:
  - `build_avoid_vector(embedder) -> np.ndarray` — L2-normalized "title card / logo / text / archival notice" concept centroid (mirrors `mood_axes.build_axes` pattern: `embedder.embed_texts(PROMPTS).mean(axis=0)` then `l2_normalize`).
  - `select_best_frame(video, dst_dir, embedder, avoid_vec, duration, fractions=(0.2,0.35,0.5,0.65,0.8)) -> tuple[Path|None, float]` — extracts a candidate frame at each interior fraction (reuse `extract_poster(video, tmp, at_seconds=frac*duration)`), embeds them with `embed_image_paths`, scores each `dot(frame_emb, avoid_vec)`, copies the argmin (least title-card-like) frame to `dst_dir/<stem>.jpg`, returns `(poster_path, chosen_timestamp)`. Degrades to the single `clip_start_seconds(duration)` frame when `embedder.backend == "hash-fallback"`, `duration` is falsy, or no candidate frame extracts.

- [ ] **Step 1: Write failing tests for `frame_selector`**

```python
# pipeline/tests/test_frame_selector.py
"""Content-aware frame pick: choose the interior frame least like a title card / logo."""
from __future__ import annotations
from pathlib import Path
import numpy as np
from embed import frame_selector as fs

class FakeEmbedder:
    backend = "open_clip"
    dim = 4
    def embed_texts(self, texts):
        # "avoid" concept points along axis 0
        return np.tile(np.array([1.0, 0, 0, 0]), (len(texts), 1))
    def embed_images(self, paths):
        # frame i's similarity to axis 0 decreases with i; the LAST frame is least title-card-like
        rows = []
        for i, _ in enumerate(paths):
            v = np.array([1.0 - i * 0.2, i * 0.1, 0, 0])
            rows.append(v / np.linalg.norm(v))
        return np.array(rows)

def test_build_avoid_vector_is_unit(monkeypatch):
    v = fs.build_avoid_vector(FakeEmbedder())
    assert abs(float(np.linalg.norm(v)) - 1.0) < 1e-6

def test_select_best_frame_picks_least_titlecard(tmp_path, monkeypatch):
    # extract_poster writes a stub jpg per requested second and returns its path
    def fake_extract(video, dst_dir, at_seconds=1.0):
        dst_dir.mkdir(parents=True, exist_ok=True)
        p = dst_dir / f"f_{int(round(at_seconds))}.jpg"
        p.write_bytes(b"jpeg")
        return p
    monkeypatch.setattr(fs, "extract_poster", fake_extract)
    emb = FakeEmbedder()
    avoid = fs.build_avoid_vector(emb)
    video = tmp_path / "film.mp4"; video.write_bytes(b"v")
    poster, ts = fs.select_best_frame(video, tmp_path / "posters", emb, avoid, duration=1000.0,
                                      fractions=(0.2, 0.5, 0.8))
    assert poster is not None and poster.exists()
    # last fraction (0.8 -> 800s) is least like the avoid concept
    assert ts == 800.0

def test_select_best_frame_falls_back_for_hash_backend(tmp_path, monkeypatch):
    class Hash(FakeEmbedder): backend = "hash-fallback"
    called = {}
    def fake_extract(video, dst_dir, at_seconds=1.0):
        called["at"] = at_seconds
        p = dst_dir / "p.jpg"; dst_dir.mkdir(parents=True, exist_ok=True); p.write_bytes(b"j"); return p
    monkeypatch.setattr(fs, "extract_poster", fake_extract)
    video = tmp_path / "f.mp4"; video.write_bytes(b"v")
    poster, ts = fs.select_best_frame(video, tmp_path/"o", Hash(), np.array([1.0,0,0,0]), duration=1000.0)
    assert poster is not None
    assert ts == 300.0  # 30% single-frame fallback, no scoring
```

- [ ] **Step 2: Run, expect fail** — `cd pipeline && python -m pytest tests/test_frame_selector.py -v` → ModuleNotFound.

- [ ] **Step 3: Implement `pipeline/embed/frame_selector.py`**

```python
"""Pick the interior film frame that looks least like a title card / studio logo / archival
notice, using CLIP. Used for BOTH the embedding poster and the clip start so video reads as
real content. Degrades gracefully (single 30% frame) without semantic CLIP or ffprobe."""
from __future__ import annotations

import shutil
from pathlib import Path

import numpy as np

from .clip_backend import Embedder, l2_normalize
from .embed_images import embed_image_paths
from .poster import extract_poster
from .clip_window import clip_start_seconds

AVOID_PROMPTS = [
    "a title card with text", "a studio logo", "an archival film notice",
    "intertitle with words on screen", "white text on a black background",
    "copyright notice and film credits",
]

def build_avoid_vector(embedder: Embedder) -> np.ndarray:
    centroid = embedder.embed_texts(AVOID_PROMPTS).mean(axis=0)
    return l2_normalize(centroid.reshape(1, -1))[0]

def select_best_frame(
    video: Path,
    dst_dir: Path,
    embedder: Embedder,
    avoid_vec: np.ndarray,
    duration: float | None,
    fractions: tuple[float, ...] = (0.2, 0.35, 0.5, 0.65, 0.8),
) -> tuple[Path | None, float]:
    dst_dir.mkdir(parents=True, exist_ok=True)
    final = dst_dir / (video.stem + ".jpg")

    # Fallback: no semantic text scoring available, or unknown duration -> single 30% frame.
    if getattr(embedder, "backend", "") == "hash-fallback" or not duration:
        ts = clip_start_seconds(duration) if duration else 0.0
        p = extract_poster(video, dst_dir, at_seconds=ts)
        return (p, ts)

    tmp = dst_dir / "_cand"
    cands: list[tuple[Path, float]] = []
    for frac in fractions:
        ts = round(duration * frac, 3)
        p = extract_poster(video, tmp, at_seconds=ts)
        if p is not None:
            cands.append((p, ts))
    if not cands:
        ts = clip_start_seconds(duration)
        return (extract_poster(video, dst_dir, at_seconds=ts), ts)

    embs = embed_image_paths(embedder, [str(p) for p, _ in cands])
    scores = embs @ avoid_vec  # higher = more title-card-like
    best = int(np.argmin(scores))
    chosen_path, chosen_ts = cands[best]
    shutil.copyfile(chosen_path, final)
    return (final, chosen_ts)
```

- [ ] **Step 4: Run** — `cd pipeline && python -m pytest tests/test_frame_selector.py -v` → 3 pass.

- [ ] **Step 5: Wire into download/build/publish (thread the chosen timestamp)**

In `download.py` `download_videos`: build `embedder = get_embedder()` and `avoid = build_avoid_vector(embedder)` once before the loop (import both). For each film: `duration = probe_duration(local)`; `poster, clip_start = select_best_frame(local, poster_dir, embedder, avoid, duration)`; if `poster is None`: skip. Write the row with an added `"clip_start_seconds": clip_start`. (Update the existing `test_download_videos.py` mocks: monkeypatch `dl.select_best_frame` to return `(poster_path, 300.0)` and `dl.get_embedder`/`dl.build_avoid_vector` so no real CLIP is needed; assert the row carries `clip_start_seconds`.)

In `build_manifest.py` `build_video_assets`: read `r.get("clip_start_seconds", 0.0)` and put it on the asset as internal `"_clipStart"`.

In `publish/run.py` `build_derivatives`: for a video asset, use `start = a.get("_clipStart")` if present (else fall back to `clip_start_seconds(probe_duration(local))`) and pass `start_seconds=start` to `transcode_video`. (Update `test_publish_video.py` to pass `_clipStart` and assert it's used.)

In `publish/upload_r2.py` `publish_manifest`: also `a.pop("_clipStart", None)` next to the existing `a.pop("_local", None)`.

- [ ] **Step 6: Full pipeline suite** — `cd pipeline && python -m pytest -q -k "not carry_through"` → green.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(pipeline): pick content frame (avoid title cards/logos) via CLIP for poster + clip"`

---

## Task B: Renderer dials — less old-TV, less flicker, less breathing, less text

**Files:** Modify `app/src/dream/conductor.ts` (`baseWakeFilm`, `wakeTick` setParams), `app/src/render/LayerStack.ts:149` (feedback), `app/src/dream/dreamwalker.ts` (`pCard`), `app/src/dream/coherence.ts` (phrase prob). Test: `app/tests/unit/filmParams.test.ts` or a focused new check for `baseWakeFilm`.

**Interfaces:** Consumes nothing new; all constant changes.

- [ ] **Step 1: Lower the wake film floor + flicker (conductor `baseWakeFilm`)**

Replace the `baseWakeFilm()` body with the reduced floor (and kill most flicker in wake):
```typescript
function baseWakeFilm(): Partial<FilmParams> {
  return {
    vignette: 0.16,
    grain: 0.06,
    sepia: 0.08,
    scanline: 0.02,
    desat: 0.08,
    halation: 0.05,
    haze: 0.03,
    flicker: 0.02,
  };
}
```

- [ ] **Step 2: Lower the grade + bloom in `wakeTick` setParams**

Change `filmGrade: 0.62 - intensity * 0.4` → `filmGrade: 0.38 - intensity * 0.25`, and `bloom: 0.16 + intensity * 0.3` → `bloom: 0.10 + intensity * 0.18`. (Leave `warp` and `chroma` as-is from R3.)

- [ ] **Step 3: Reduce feedback "breathing" persistence**

`app/src/render/LayerStack.ts` line ~149: `this.fbMat.opacity = this.feedbackTrail * 0.85;` → `* 0.55;`.

- [ ] **Step 4: Thin out title-card text**

`app/src/dream/dreamwalker.ts` (the `pCard` line in `nextImage`, ~line 224):
`const pCard = 0.05 + (this.lastLeaped ? 0.12 : 0) + this.surreality * 0.06;`
→ `const pCard = 0.02 + (this.lastLeaped ? 0.05 : 0) + this.surreality * 0.03;`

`app/src/dream/coherence.ts` (~line 12): the phrase threshold `if (r < 0.85) return 'lucid'; return 'phrase';` → change `0.85` to `0.9` (phrase troughs 15% → 10%).

- [ ] **Step 5: Add/extend a test pinning the lower film floor**

Add to `app/tests/unit/filmParams.test.ts` (import `baseWakeFilm`? it's not exported — instead add a small test by importing the conductor is heavy). Simplest: export `baseWakeFilm` from conductor is undesirable. Instead add a focused assertion in an existing reachable place is hard. Given the conductor is not unit-harnessed, verify these dial changes via typecheck + lint + the full suite staying green, and the manual preview. (No new unit test for the constants; they are values, and the existing `filmParams`/`dreamwalker`/`coherence` tests must still pass — run them.)

- [ ] **Step 6: Verify** — `cd app && npm run typecheck && npm run lint && npx vitest run` → green (existing coherence/dreamwalker tests still pass; the `pCard`/phrase threshold changes don't break determinism tests — confirm).

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(dream): tame old-TV grade, flicker, feedback breathing, and title-card text in wake"`

---

## Task C: Cross-fade layer swaps (less flicker, more blend)

**Files:** Modify `app/src/render/LayerStack.ts` (fade arrays + `update(dt)` + `applyPlan` writes targets + `setLayerTexture` resets ramp), `app/src/dream/conductor.ts` (call `stack.update(dt)` each wake frame). Test: `app/tests/unit/layerFade.test.ts` (new).

**Interfaces:**
- Produces on `LayerStack`: `update(dtSec: number): void` — advances each visible slot's opacity from 0 toward its plan target over ~0.3s; `setLayerTexture` resets the swapped slot's ramp to 0 so a new texture fades in instead of hard-cutting.

- [ ] **Step 1: Write the fade test**

```typescript
// app/tests/unit/layerFade.test.ts
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { LayerStack } from '../../src/render/LayerStack';

// LayerStack needs a Compositor-like host; construct a minimal stub exposing scene + camera.
function stubCompositor() {
  const scene = new THREE.Scene();
  return {
    scene,
    camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
    addOverlay: (m: THREE.Object3D) => scene.add(m),
    removeOverlay: (m: THREE.Object3D) => scene.remove(m),
    size: { width: 2, height: 2 },
    renderer: {} as unknown,
  };
}

describe('LayerStack swap fade-in', () => {
  it('a freshly-set layer ramps opacity up from 0 over time, not an instant cut', () => {
    const stack = new LayerStack(stubCompositor() as never);
    const tex = new THREE.Texture();
    tex.userData.ownedByCompositor = false;
    stack.setLayerTexture(0, tex);
    stack.applyPlan({ layerCount: 1, blends: ['screen'], feedback: 0, warp: 0 } as never);
    // immediately after swap: near 0
    stack.update(0); // settle visibility
    const mat0 = (stack as unknown as { mats: THREE.MeshBasicMaterial[] }).mats[0];
    const early = mat0.opacity;
    stack.update(0.5); // half a second later -> approaching target
    const later = mat0.opacity;
    expect(early).toBeLessThan(0.5);
    expect(later).toBeGreaterThan(early);
  });
});
```

- [ ] **Step 2: Run, expect fail** (`stack.update` missing).

- [ ] **Step 3: Implement the fade in `LayerStack.ts`**

- Add fields: `private readonly fadeOpacity = new Array<number>(MAX_LAYERS).fill(0); private readonly fadeTarget = new Array<number>(MAX_LAYERS).fill(0);`
- In `setLayerTexture`, after bumping `writeSeq`, add `this.fadeOpacity[index] = 0;` (new texture fades in).
- In `applyPlan`, where it currently sets `mat.opacity = 0.92` (hero) / `Math.max(0.18, 0.6 - rank*0.09)` (others), instead write those values to `this.fadeTarget[slot]` and set hidden slots' `fadeTarget = 0`; keep `mat.blending` assignment as-is; do NOT set `mat.opacity` here.
- Add `update(dtSec: number): void` that, for each layer `i`: `this.fadeOpacity[i] += (this.fadeTarget[i] - this.fadeOpacity[i]) * Math.min(1, dtSec * 8);` (≈0.3s ease) and `this.mats[i].opacity = this.fadeOpacity[i];`.

- [ ] **Step 4: Call `update(dt)` each wake frame**

In `conductor.ts` `wakeTick`, alongside `stack.captureFeedback(...)` add `stack.update(dt)`. `dt` is available from the frame-listener tick; thread it into `wakeTick(dt)` if not already (the tick signature is `tick(dt)`); pass `dt` through to `wakeTick`.

- [ ] **Step 5: Verify** — `cd app && npx vitest run tests/unit/layerFade.test.ts && npm run typecheck && npm run lint && npx vitest run` → green.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(render): cross-fade layer swaps (smoother, less flicker)"`

---

## Task D: Longer video hold + pin a playing clip visible

**Files:** Modify `app/src/render/LayerStack.ts` (`applyPlan` accepts pinned slots), `app/src/dream/conductor.ts` (longer hold; compute + pass pinned set). Test: `app/tests/unit/layerPin.test.ts` (new).

**Interfaces:**
- `applyPlan(plan, pinnedSlots?: ReadonlySet<number>)` — pinned slots that hold a texture are forced into the visible set (prepended to the recency ranking) so a held clip can't be ranked out of view.

- [ ] **Step 1: Write the pin test**

```typescript
// app/tests/unit/layerPin.test.ts
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { LayerStack } from '../../src/render/LayerStack';
function stub() { const s = new THREE.Scene(); return { scene: s, camera: new THREE.OrthographicCamera(-1,1,1,-1,0,1), addOverlay:(m:THREE.Object3D)=>s.add(m), removeOverlay:(m:THREE.Object3D)=>s.remove(m), size:{width:2,height:2}, renderer:{} as unknown }; }

describe('LayerStack pin', () => {
  it('a pinned slot stays visible even when newer swaps would rank it out', () => {
    const stack = new LayerStack(stub() as never);
    const layers = (stack as unknown as { layers: THREE.Mesh[] }).layers;
    // slot 0 is the pinned (old) video; fill newer slots 1..3
    for (let i = 0; i < 4; i++) { const t = new THREE.Texture(); t.userData.ownedByCompositor=false; stack.setLayerTexture(i, t); }
    // plan shows only 2 layers; without a pin, slot 0 (oldest) would be hidden
    stack.applyPlan({ layerCount: 2, blends: ['screen','screen','screen','screen'], feedback:0, warp:0 } as never, new Set([0]));
    expect(layers[0].visible).toBe(true); // pinned stays on
  });
});
```

- [ ] **Step 2: Run, expect fail** (pinned param ignored → slot 0 hidden).

- [ ] **Step 3: Implement pin in `applyPlan`**

After building `ranked` (slots with a map, sorted by `writeSeq` desc), reorder so pinned slots come first:
```typescript
const pin = pinnedSlots ?? new Set<number>();
const pinned = ranked.filter((i) => pin.has(i));
const rest = ranked.filter((i) => !pin.has(i));
const finalRanked = [...pinned, ...rest];
```
then use `finalRanked` in place of `ranked` for the `visibleCount` slice and the visible/opacity/blend loop. `visibleCount = Math.min(plan.layerCount, finalRanked.length)` (pinned still count toward the cap but are guaranteed inclusion by being first).

- [ ] **Step 4: Longer hold + pass the pinned set (conductor)**

- In `swapWakeLayer`, bump the video hold: `this.slotHeldUntil[slot] = this.clock + (sample.inTrough ? 13.0 : 9.0);` (was 8.0/5.0).
- In `wakeTick`, before `stack.applyPlan(this.currentPlan)`, compute the pinned set from active holds and pass it:
```typescript
const pinned = new Set<number>();
for (let i = 0; i < this.slotHeldUntil.length; i++) if (this.slotHeldUntil[i] > this.clock) pinned.add(i);
if (this.currentPlan) stack.applyPlan(this.currentPlan, pinned);
```
(Also update the `applyPlan(this.currentPlan)` call inside `swapWakeLayer` to pass the same pinned set, or compute it there too.)

- [ ] **Step 5: Verify** — `cd app && npx vitest run tests/unit/layerPin.test.ts && npm run typecheck && npm run lint && npx vitest run` → green.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(dream): hold + visually pin a playing clip so it isn't cut away early"`

---

## Task E: Rebuild corpus (smart frames) + reship + preview

**Files:** none (operational).

- [ ] **Step 1: Rebuild from this branch's pipeline (has frame_selector)**

```bash
cd pipeline
export PATH="<ffmpeg-bin>:$PATH"   # the WinGet ffmpeg path above
export R2_ACCOUNT_ID=... R2_BUCKET=dreamreel-media R2_PUBLIC_BASE=https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
python -m embed.download --candidates out/candidates.jsonl --out out   # re-pick content frames (films cached)
python -m embed.build_manifest --out out
python -m publish.run --out out --upload
```

- [ ] **Step 2: Verify live** — `latest.json` is a new version with 40 videos, all srcs R2, 0 `_local`/`_clipStart` leaks; sample a clip → 200 `video/mp4`, ~12s; confirm the chosen timestamps are non-trivial interior points.

- [ ] **Step 3: Hand to owner for preview** at the PR's Pages URL `?wake=1`.

---

## Self-Review
- Clips show content not title cards → Task A (CLIP frame avoidance) + reship (Task E). ✓
- Less drifting text → Task B (`pCard`, phrase prob). ✓
- Less flickery / more blended → Task B (flicker, grade) + Task C (cross-fade swaps). ✓
- Old-TV filter lower → Task B (baseWakeFilm + filmGrade + bloom). ✓
- Breathing filter lower → Task B (feedback 0.85→0.55). ✓
- Video cut away too quickly → Task D (longer hold + visibility pin). ✓
- Determinism preserved (threshold/constant changes, dt/clock-driven fades, no new RNG) → Tasks B/C/D. ✓
- Internal `_clipStart` stripped before upload → Task A Step 5. ✓

**Type consistency:** `select_best_frame → (Path|None, float)` consumed in `download_videos`; `clip_start_seconds`/`probe_duration` reused from `clip_window.py`; `_clipStart` written in build_manifest, read in publish, stripped in upload_r2. `applyPlan(plan, pinnedSlots?)` — pinned `Set<number>` produced in conductor, consumed in LayerStack. `update(dtSec)` added on LayerStack, called from conductor `wakeTick(dt)`.
