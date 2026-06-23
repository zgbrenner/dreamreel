# Round 4 — Moving Image (Video) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add short, muted, looping public-domain video as a first-class visual asset, sourced and transcoded by the offline pipeline and rendered through the existing layer/stage seams in both compositing modes.

**Architecture:** The Python pipeline gains a parallel video path — fetch film → extract one poster frame (ffmpeg) → embed the poster with the existing CLIP image embedder → emit a `type:"video"` asset carrying an internal `_local` source path → transcode a 12s muted mp4 → upload to R2. Video rows live in a **separate** `fetched_videos.jsonl` so the image `img-{i}` row-indexing is untouched. The renderer gains `loadVideoTexture` + a `VideoPool` (bounded decoders, restart-at-0, reduced-motion freeze) behind a new `Compositor.showVideo`, with `video` branches added to the conductor's wake and classic dispatch. The manifest contract, dreamwalker, schema, and store are already video-ready and unchanged.

**Tech Stack:** Python (pydantic, numpy, Pillow, ffmpeg via subprocess, boto3-mocked tests, pytest). TypeScript (three.js, vitest, Playwright). Cloudflare R2.

## Global Constraints

- TypeScript strict; **no `any`** in committed code; ESLint + Prettier. (CLAUDE.md)
- **No `Math.random` in the dream path** — determinism is seeded. (CLAUDE.md)
- Determinism contract: same seed → same asset/text/coherence sequence; **timing may vary**. Video start-point must be deterministic (seek 0 on show); intra-clip phase may vary. (spec)
- Video is **muted / visual-only** this round (`-an` in transcode; `video.muted = true`). No film audio. (spec)
- Every asset carries `license`, `source`, and `attribution` (required when `license` starts with `CC-BY`). Reject CC-BY-NC / unknown. (CLAUDE.md)
- Field names in `app/src/manifest/types.ts` are **frozen** — add no public `Asset` fields. `_local` is an internal pipeline-only key, stripped before R2 upload. (CLAUDE.md / spec)
- VideoPool decoder cap = **2** concurrent playing videos (classic mode naturally uses ≤1). Video curation cutoff = **0.45** (distinct from the 0.52 image cutoff). (spec)
- Failures are non-fatal and fall back to a procedural texture, exactly like image failures. (spec)
- ⚠️ Before `npm run test:e2e`, kill any process on port 4173 (stale `reuseExistingServer` false-green). (handoff)
- ⚠️ `pipeline/tests/test_carry_through.py` fails locally if `torch` is installed — not a regression. (handoff)

---

## File structure

**Pipeline (Python):**
- Create `pipeline/embed/poster.py` — `extract_poster(video, dst_dir)` ffmpeg single-frame grab.
- Modify `pipeline/embed/download.py` — add `download_videos()` writing `fetched_videos.jsonl`; call it from `main()`.
- Modify `pipeline/embed/curate.py` — add `VIDEO_CUTOFF = 0.45`.
- Modify `pipeline/embed/build_manifest.py` — read `fetched_videos.jsonl`, embed posters, emit `vid-{i}` assets, curate with `VIDEO_CUTOFF`.
- Modify `pipeline/publish/upload_r2.py` — strip `_local` before upload.
- Tests: `pipeline/tests/test_poster.py`, `test_download_videos.py`, `test_curate_video.py`, `test_build_manifest_video.py`, `test_publish_video.py`.

**Renderer (TypeScript):**
- Create `app/src/render/videoTexture.ts` — `loadVideoTexture(url, opts)`.
- Create `app/src/render/VideoPool.ts` — bounded decoder pool.
- Modify `app/src/render/Compositor.ts` — add `showVideo()`.
- Modify `app/src/dream/conductor.ts` — `video` branch in `swapWakeLayer()` and `resolveVisual()`.
- Tests: `app/tests/unit/videoTexture.test.ts`, `app/tests/unit/videoPool.test.ts`, `app/tests/unit/compositorVideo.test.ts`.

**Integration / ship:**
- Modify `app/public/manifest.seed.json` — add one video asset for the e2e smoke.
- Modify `docs/HANDOFF.md` — mark round 4 shipped.

---

## Task 1: Poster-frame extraction

**Files:**
- Create: `pipeline/embed/poster.py`
- Test: `pipeline/tests/test_poster.py`

**Interfaces:**
- Consumes: nothing (leaf helper).
- Produces: `extract_poster(video: Path, dst_dir: Path, at_seconds: float = 1.0) -> Path | None` — writes `<video.stem>.jpg` into `dst_dir` via ffmpeg; returns the poster path, or `None` if ffmpeg is missing/fails.

- [ ] **Step 1: Write the failing test**

```python
# pipeline/tests/test_poster.py
"""Poster-frame extraction (the still that gives a video its CLIP embedding).

ffmpeg is mocked; this proves the command shape and the None-on-failure contract.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

from embed import poster as ps


def test_extract_poster_runs_ffmpeg_and_returns_path(tmp_path, monkeypatch):
    src = tmp_path / "abc123.mp4"
    src.write_bytes(b"not really a video")
    calls = {}

    def fake_run(cmd, check, capture_output):
        calls["cmd"] = cmd
        # emulate ffmpeg writing the output frame
        Path(cmd[-1]).write_bytes(b"jpeg")
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(ps.subprocess, "run", fake_run)
    out = ps.extract_poster(src, tmp_path / "posters", at_seconds=1.0)

    assert out is not None
    assert out.exists()
    assert out.suffix == ".jpg"
    assert out.stem == "abc123"
    cmd = calls["cmd"]
    assert cmd[0] == "ffmpeg"
    assert "-ss" in cmd and "1.0" in cmd
    assert "-frames:v" in cmd and "1" in cmd


def test_extract_poster_returns_none_when_ffmpeg_missing(tmp_path, monkeypatch):
    src = tmp_path / "x.mp4"
    src.write_bytes(b"v")

    def boom(cmd, check, capture_output):
        raise FileNotFoundError("ffmpeg")

    monkeypatch.setattr(ps.subprocess, "run", boom)
    assert ps.extract_poster(src, tmp_path / "p") is None


def test_extract_poster_returns_none_on_nonzero(tmp_path, monkeypatch):
    src = tmp_path / "x.mp4"
    src.write_bytes(b"v")

    def fail(cmd, check, capture_output):
        raise subprocess.CalledProcessError(1, cmd)

    monkeypatch.setattr(ps.subprocess, "run", fail)
    assert ps.extract_poster(src, tmp_path / "p") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline && python -m pytest tests/test_poster.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'embed.poster'`

- [ ] **Step 3: Write minimal implementation**

```python
# pipeline/embed/poster.py
"""Extract a single representative still from a video for CLIP embedding.

The poster frame is what gives a video asset its place in embedding space (the dreamwalker
selects by embedding, media-agnostically). Requires ffmpeg on PATH; returns None on absence
or failure so the caller can skip the candidate without crashing the build.
"""
from __future__ import annotations

import subprocess
from pathlib import Path


def extract_poster(video: Path, dst_dir: Path, at_seconds: float = 1.0) -> Path | None:
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / (video.stem + ".jpg")
    cmd = [
        "ffmpeg", "-y",
        "-ss", str(at_seconds),
        "-i", str(video),
        "-frames:v", "1",
        "-q:v", "2",
        str(dst),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    return dst if dst.exists() else None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline && python -m pytest tests/test_poster.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add pipeline/embed/poster.py pipeline/tests/test_poster.py
git commit -m "feat(pipeline): poster-frame extraction for video embedding"
```

---

## Task 2: Download videos to a separate manifest

**Files:**
- Modify: `pipeline/embed/download.py`
- Test: `pipeline/tests/test_download_videos.py`

**Interfaces:**
- Consumes: `extract_poster` (Task 1); `Candidate` (`ingest.normalize`).
- Produces: `download_videos(candidates: Iterable[Candidate], out_dir: Path) -> list[dict]` — fetches each `type=="video"` candidate to `out_dir/videos/<sha1>.mp4`, extracts a poster, and writes `out_dir/fetched_videos.jsonl` with rows `{"candidate": <dump>, "video_path": str, "poster_path": str}`. `main()` calls it alongside `download()`.

Note: the existing `download()` (images → `fetched.jsonl`) is **unchanged**; videos stay out of `fetched.jsonl`, so `img-{i}` indexing in `publish/run.py` is unaffected and `test_download.py` still passes.

- [ ] **Step 1: Write the failing test**

```python
# pipeline/tests/test_download_videos.py
"""Video download step (candidates.jsonl -> fetched_videos.jsonl).

Network and ffmpeg-poster are mocked; proves only videos are recorded, each row carries a
local video path and a poster path, and fetch/poster failures are dropped.
"""
from __future__ import annotations

import json
from pathlib import Path

from embed import download as dl
from ingest.normalize import make_candidate


class FakeResp:
    def __init__(self, content=b"film-bytes", status=200):
        self.content = content
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            import requests
            raise requests.HTTPError(str(self.status_code))


def _candidates(tmp_path: Path):
    img, _ = make_candidate(
        source_url="https://media.example/ok.jpg", type="image",
        source="Openverse / Flickr Commons", raw_license="cc0", tags=["sea"],
    )
    vid, _ = make_candidate(
        source_url="https://media.example/film.mp4", type="video",
        source="Archive.org / prelinger", raw_license="publicdomain", tags=["film"],
    )
    return [img, vid]


def test_download_videos_records_only_videos_with_poster(tmp_path, monkeypatch):
    monkeypatch.setattr(dl.requests, "get", lambda url, headers=None, timeout=None: FakeResp())
    # poster extraction succeeds: write a stub jpg next to the asked-for dst
    def fake_poster(video, dst_dir, at_seconds=1.0):
        dst_dir.mkdir(parents=True, exist_ok=True)
        p = dst_dir / (video.stem + ".jpg")
        p.write_bytes(b"jpeg")
        return p
    monkeypatch.setattr(dl, "extract_poster", fake_poster)

    rows = dl.download_videos(_candidates(tmp_path), tmp_path)

    assert len(rows) == 1
    assert rows[0]["candidate"]["type"] == "video"
    assert Path(rows[0]["video_path"]).exists()
    assert Path(rows[0]["poster_path"]).exists()

    written = [
        json.loads(line)
        for line in (tmp_path / "fetched_videos.jsonl").read_text().splitlines()
        if line.strip()
    ]
    assert len(written) == 1


def test_download_videos_drops_when_poster_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(dl.requests, "get", lambda url, headers=None, timeout=None: FakeResp())
    monkeypatch.setattr(dl, "extract_poster", lambda video, dst_dir, at_seconds=1.0: None)

    rows = dl.download_videos(_candidates(tmp_path), tmp_path)
    assert rows == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline && python -m pytest tests/test_download_videos.py -v`
Expected: FAIL with `AttributeError: module 'embed.download' has no attribute 'download_videos'`

- [ ] **Step 3: Write minimal implementation**

In `pipeline/embed/download.py`, add the import near the top (after `from ingest.normalize import Candidate`):

```python
from embed.poster import extract_poster
```

Then add the new function after `download()` (after line 77):

```python
def download_videos(candidates: Iterable[Candidate], out_dir: Path) -> list[dict]:
    """Fetch films + extract a poster frame; write fetched_videos.jsonl (videos only).

    Kept separate from download()/fetched.jsonl so the image img-{i} indexing (and the publish
    correlation that rebuilds it) is never disturbed. Each row carries the local video path
    (consumed by publish/transcode via the asset's _local field) and the poster path (embedded
    by build_manifest). Fetch or poster failures drop the candidate with no crash.
    """
    vid_dir = out_dir / "videos"
    poster_dir = out_dir / "posters"
    vid_dir.mkdir(parents=True, exist_ok=True)
    fetched: list[dict] = []
    for c in candidates:
        if c.type != "video":
            continue
        local = vid_dir / _safe_name(c.source_url, ".mp4")
        if not local.exists():
            try:
                r = requests.get(c.source_url, headers={"User-Agent": USER_AGENT}, timeout=120)
                r.raise_for_status()
                local.write_bytes(r.content)
            except requests.RequestException:
                continue
        poster = extract_poster(local, poster_dir)
        if poster is None:
            local.unlink(missing_ok=True)
            continue
        fetched.append(
            {"candidate": c.model_dump(), "video_path": str(local), "poster_path": str(poster)}
        )

    manifest_path = out_dir / "fetched_videos.jsonl"
    with manifest_path.open("w", encoding="utf-8") as f:
        for row in fetched:
            f.write(json.dumps(row) + "\n")
    print(f"downloaded {len(fetched)} videos -> {vid_dir}")
    return fetched
```

Then wire it into `main()` — replace the body after `cands = load_candidates(args.candidates)` (currently just `download(cands, args.out)`):

```python
    cands = load_candidates(args.candidates)
    download(cands, args.out)
    download_videos(cands, args.out)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline && python -m pytest tests/test_download_videos.py tests/test_download.py -v`
Expected: PASS (both the new video tests and the unchanged image tests)

- [ ] **Step 5: Commit**

```bash
git add pipeline/embed/download.py pipeline/tests/test_download_videos.py
git commit -m "feat(pipeline): download videos + posters to fetched_videos.jsonl"
```

---

## Task 3: Video curation cutoff

**Files:**
- Modify: `pipeline/embed/curate.py`
- Test: `pipeline/tests/test_curate_video.py`

**Interfaces:**
- Consumes: existing `curate(assets, *, cutoff, anchors)`.
- Produces: module constant `VIDEO_CUTOFF = 0.45` for callers to pass as `cutoff`.

- [ ] **Step 1: Write the failing test**

```python
# pipeline/tests/test_curate_video.py
"""The lower video cutoff keeps films an image-strength cutoff would drop."""
from __future__ import annotations

from embed.curate import VIDEO_CUTOFF, curate


def _vid(score: float, id_: str) -> dict:
    return {"id": id_, "type": "video", "tags": ["film"], "mood": {"uncanny": score, "ominous": 0.0}}


def test_video_cutoff_is_lower_than_image_default():
    from embed.curate import DEFAULT_CUTOFF
    assert VIDEO_CUTOFF < DEFAULT_CUTOFF
    assert VIDEO_CUTOFF == 0.45


def test_curate_keeps_video_at_video_cutoff():
    assets = [_vid(0.47, "vid-0"), _vid(0.30, "vid-1")]
    kept, dropped = curate(assets, cutoff=VIDEO_CUTOFF)
    assert {a["id"] for a in kept} == {"vid-0"}
    assert {a["id"] for a in dropped} == {"vid-1"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline && python -m pytest tests/test_curate_video.py -v`
Expected: FAIL with `ImportError: cannot import name 'VIDEO_CUTOFF'`

- [ ] **Step 3: Write minimal implementation**

In `pipeline/embed/curate.py`, add below `DEFAULT_CUTOFF = 0.52`:

```python
VIDEO_CUTOFF = 0.45  # videos are scarce moving image; a gentler bar than the 0.52 image cutoff
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline && python -m pytest tests/test_curate_video.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add pipeline/embed/curate.py pipeline/tests/test_curate_video.py
git commit -m "feat(pipeline): VIDEO_CUTOFF (0.45) for video curation"
```

---

## Task 4: Build video assets into the manifest

**Files:**
- Modify: `pipeline/embed/build_manifest.py`
- Test: `pipeline/tests/test_build_manifest_video.py`

**Interfaces:**
- Consumes: `VIDEO_CUTOFF`, `curate` (Task 3); `embed_image_paths`, `l2_normalize`, `project_mood`, `_dwell_for`, `_emb_list` (existing).
- Produces: `build_video_assets(embedder, axes, videos_path: Path | None) -> list[dict]` — reads `fetched_videos.jsonl`, embeds each `poster_path`, emits `vid-{i:04d}` assets (`type:"video"`, `src` = remote source_url for now, `_local` = video_path, `dwellBase` 7.5, mood from poster), curated with `VIDEO_CUTOFF`. `build()` appends its result to `assets`; `main()` passes the videos path.

- [ ] **Step 1: Write the failing test**

```python
# pipeline/tests/test_build_manifest_video.py
"""build_manifest emits valid video assets from fetched_videos.jsonl.

Uses the offline hash-fallback embedder (no torch) via get_embedder(), so embeddings are
deterministic and L2-normalized without a CLIP model.
"""
from __future__ import annotations

import json
from pathlib import Path

from embed import build_manifest as bm
from embed.clip_backend import get_embedder
from embed.mood_axes import build_axes


def _write_videos_jsonl(tmp_path: Path) -> Path:
    poster = tmp_path / "posters" / "film.jpg"
    poster.parent.mkdir(parents=True, exist_ok=True)
    poster.write_bytes(b"\xff\xd8\xff\xd9")  # minimal jpg-ish bytes; hash-fallback embeds by bytes
    video = tmp_path / "videos" / "film.mp4"
    video.parent.mkdir(parents=True, exist_ok=True)
    video.write_bytes(b"film")
    row = {
        "candidate": {
            "source_url": "https://media.example/film.mp4",
            "type": "video",
            "source": "Archive.org / prelinger",
            "license": "PD",
            "attribution": None,
            "attribution_url": None,
            "tags": ["film", "decay"],
            "query_theme": "decay",
            "foreign_landing_url": None,
        },
        "video_path": str(video),
        "poster_path": str(poster),
    }
    p = tmp_path / "fetched_videos.jsonl"
    p.write_text(json.dumps(row) + "\n", encoding="utf-8")
    return p


def test_build_video_assets_emits_valid_video_asset(tmp_path):
    embedder = get_embedder()
    axes = build_axes(embedder)
    assets = bm.build_video_assets(embedder, axes, _write_videos_jsonl(tmp_path))

    assert len(assets) == 1
    a = assets[0]
    assert a["id"] == "vid-0000"
    assert a["type"] == "video"
    assert a["dwellBase"] == 7.5
    assert a["src"] == "https://media.example/film.mp4"
    assert a["_local"].endswith("film.mp4")
    assert len(a["embedding"]) == embedder.dim
    assert abs(sum(x * x for x in a["embedding"]) - 1.0) < 1e-3  # L2-normalized


def test_build_video_assets_empty_when_no_file(tmp_path):
    embedder = get_embedder()
    axes = build_axes(embedder)
    assert bm.build_video_assets(embedder, axes, tmp_path / "missing.jsonl") == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline && python -m pytest tests/test_build_manifest_video.py -v`
Expected: FAIL with `AttributeError: module 'embed.build_manifest' has no attribute 'build_video_assets'`

- [ ] **Step 3: Write minimal implementation**

In `pipeline/embed/build_manifest.py`, extend the curate import (line 21):

```python
from .curate import DEFAULT_CUTOFF, VIDEO_CUTOFF, curate
```

Add this function after `curate_image_assets` (after line 61):

```python
def build_video_assets(embedder, axes, videos_path: Path | None) -> list[dict]:
    """Read fetched_videos.jsonl, embed each poster frame, emit curated video assets.

    Each asset carries an internal _local source path (consumed by publish/transcode, stripped
    before R2 upload) and src = the remote film URL (rewritten to the R2 mp4 URL on upload).
    Curated with the gentler VIDEO_CUTOFF so the scarce film pool is not over-pruned.
    """
    if not (videos_path and videos_path.exists()):
        return []
    with videos_path.open(encoding="utf-8") as f:
        rows = [json.loads(line) for line in f if line.strip()]
    if not rows:
        return []
    poster_paths = [r["poster_path"] for r in rows]
    embs = embed_image_paths(embedder, poster_paths)
    built: list[dict] = []
    for i, (r, emb) in enumerate(zip(rows, embs)):
        c = r["candidate"]
        emb = l2_normalize(emb.reshape(1, -1))[0]
        built.append(
            {
                "id": f"vid-{i:04d}",
                "type": "video",
                "src": c["source_url"],  # rewritten to the R2 mp4 URL in publish/upload_r2
                "_local": r["video_path"],  # internal; stripped before upload
                "embedding": _emb_list(emb),
                "mood": project_mood(emb, axes),
                "tags": c.get("tags", []),
                "dwellBase": _dwell_for("video", c.get("tags", [])),
                "source": c["source"],
                "license": c["license"],
                **({"attribution": c["attribution"]} if c.get("attribution") else {}),
                **({"attributionUrl": c["attribution_url"]} if c.get("attribution_url") else {}),
            }
        )
    kept, dropped = curate(built, cutoff=VIDEO_CUTOFF)
    print(
        f"[build_manifest] curation: kept {len(kept)}/{len(built)} video assets "
        f"(dropped {len(dropped)} below cutoff {VIDEO_CUTOFF}; anchors exempt)"
    )
    return kept
```

Change `build()` to accept and use a videos path. Update the signature (line 64) and the call site. Replace the signature line:

```python
def build(out_dir: Path, fetched_path: Path | None, videos_path: Path | None = None) -> Path:
```

Immediately after `assets.extend(curate_image_assets(image_assets))` (line 99), add:

```python
    # --- video assets from the video download step ---
    assets.extend(build_video_assets(embedder, axes, videos_path))
```

Update `main()` (after line 161) to pass the videos path:

```python
    fetched = args.fetched or (args.out / "fetched.jsonl")
    videos = args.out / "fetched_videos.jsonl"
    build(args.out, fetched, videos)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline && python -m pytest tests/test_build_manifest_video.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Run the full pipeline suite + the app's manifest validator to confirm no contract break**

Run: `cd pipeline && python -m pytest -q -k "not carry_through"`
Expected: PASS (existing tests + new ones; `carry_through` skipped per the torch gotcha)

- [ ] **Step 6: Commit**

```bash
git add pipeline/embed/build_manifest.py pipeline/tests/test_build_manifest_video.py
git commit -m "feat(pipeline): build curated video assets into the manifest"
```

---

## Task 5: Strip `_local` before upload + confirm video publish path

**Files:**
- Modify: `pipeline/publish/upload_r2.py`
- Test: `pipeline/tests/test_publish_video.py`

**Interfaces:**
- Consumes: existing `build_derivatives` (already transcodes `_local` videos), `transcode_video`, `upload_media` (already dispatches `.mp4 → video/mp4`).
- Produces: `publish_manifest` strips every `_local` key from assets before serialization/upload.

- [ ] **Step 1: Write the failing test**

```python
# pipeline/tests/test_publish_video.py
"""Video assets transcode + upload as video/mp4, and the internal _local key never ships."""
from __future__ import annotations

import json
from pathlib import Path

from publish import run as pub
from publish import upload_r2


def test_build_derivatives_transcodes_local_video(tmp_path, monkeypatch):
    src = tmp_path / "film.mp4"
    src.write_bytes(b"v")
    out_mp4 = tmp_path / "deriv" / "film.mp4"

    def fake_transcode_video(s, dst_dir, max_seconds=12):
        dst_dir.mkdir(parents=True, exist_ok=True)
        out_mp4.write_bytes(b"clip")
        return out_mp4

    monkeypatch.setattr(pub, "transcode_video", fake_transcode_video)
    assets = [{"id": "vid-0000", "type": "video", "_local": str(src)}]
    derivs = pub.build_derivatives(assets, tmp_path / "fetched.jsonl", tmp_path / "deriv")

    assert derivs == {"vid-0000": out_mp4}


def test_publish_manifest_strips_local(monkeypatch):
    uploaded = {}

    class FakeClient:
        def put_object(self, **kw):
            uploaded[kw["Key"]] = kw["Body"]

    monkeypatch.setenv("R2_BUCKET", "b")
    monkeypatch.setenv("R2_PUBLIC_BASE", "https://cdn.example")
    monkeypatch.setattr(upload_r2, "_client", lambda: FakeClient())

    manifest = {
        "version": "v1",
        "assets": [{"id": "vid-0000", "type": "video", "src": "https://x/film.mp4", "_local": "/tmp/film.mp4"}],
    }
    upload_r2.publish_manifest(manifest, {"vid-0000": "https://cdn.example/media/film.mp4"})

    body = json.loads(uploaded["manifest/latest.json"].decode("utf-8"))
    asset = body["assets"][0]
    assert asset["src"] == "https://cdn.example/media/film.mp4"
    assert "_local" not in asset
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline && python -m pytest tests/test_publish_video.py -v`
Expected: FAIL on `test_publish_manifest_strips_local` (`_local` still present)

- [ ] **Step 3: Write minimal implementation**

In `pipeline/publish/upload_r2.py`, in `publish_manifest`, replace the rewrite loop (lines 51-53) with one that also strips `_local`:

```python
    for a in manifest.get("assets", []):
        if a["id"] in media_urls:
            a["src"] = media_urls[a["id"]]
        a.pop("_local", None)  # internal pipeline key — never ship local paths
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline && python -m pytest tests/test_publish_video.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add pipeline/publish/upload_r2.py pipeline/tests/test_publish_video.py
git commit -m "feat(pipeline): strip _local before upload; verify video transcode path"
```

---

## Task 6: `loadVideoTexture`

**Files:**
- Create: `app/src/render/videoTexture.ts`
- Test: `app/tests/unit/videoTexture.test.ts`

**Interfaces:**
- Consumes: `TextureLoadResult` (`./textureLoader`).
- Produces:
  - `interface VideoLoadOptions { timeoutMs?: number; paused?: boolean; createVideo?: () => HTMLVideoElement; makeTexture?: (el: HTMLVideoElement) => THREE.Texture; }`
  - `loadVideoTexture(url: string, opts?: VideoLoadOptions): Promise<TextureLoadResult>` — builds a muted/looping/playsInline video, resolves `{ok:true, texture}` on `canplay` with `texture.userData = { ownedByCompositor:true, kind:'video', video:<el> }`, or `{ok:false, reason:'error'|'timeout'}`. Autoplays unless `paused`. The element + texture factories are injectable for node tests.

- [ ] **Step 1: Write the failing test**

```typescript
// app/tests/unit/videoTexture.test.ts
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { loadVideoTexture } from '../../src/render/videoTexture';

function fakeVideo() {
  return {
    muted: false, loop: false, playsInline: false, preload: '', crossOrigin: '',
    src: '', currentTime: 0, paused: true,
    oncanplay: null as null | (() => void), onerror: null as null | (() => void),
    setAttribute: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(),
    play: vi.fn(function (this: any) { this.paused = false; return Promise.resolve(); }),
    pause: vi.fn(function (this: any) { this.paused = true; }),
  };
}

describe('loadVideoTexture', () => {
  it('resolves ok on canplay, autoplays, and tags userData', async () => {
    const v = fakeVideo();
    const p = loadVideoTexture('http://x/film.mp4', {
      createVideo: () => v as unknown as HTMLVideoElement,
      makeTexture: () => new THREE.Texture(),
    });
    v.oncanplay?.();
    const res = await p;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(v.muted).toBe(true);
    expect(v.loop).toBe(true);
    expect(v.play).toHaveBeenCalled();
    expect(res.texture.userData.ownedByCompositor).toBe(true);
    expect(res.texture.userData.kind).toBe('video');
    expect(res.texture.userData.video).toBe(v);
  });

  it('does not autoplay when paused (reduced motion)', async () => {
    const v = fakeVideo();
    const p = loadVideoTexture('http://x/film.mp4', {
      paused: true,
      createVideo: () => v as unknown as HTMLVideoElement,
      makeTexture: () => new THREE.Texture(),
    });
    v.oncanplay?.();
    const res = await p;
    expect(res.ok).toBe(true);
    expect(v.play).not.toHaveBeenCalled();
  });

  it('resolves fail on error', async () => {
    const v = fakeVideo();
    const p = loadVideoTexture('http://x/film.mp4', {
      createVideo: () => v as unknown as HTMLVideoElement,
      makeTexture: () => new THREE.Texture(),
    });
    v.onerror?.();
    const res = await p;
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('error');
  });

  it('resolves fail timeout', async () => {
    vi.useFakeTimers();
    const v = fakeVideo();
    const p = loadVideoTexture('http://x/film.mp4', {
      timeoutMs: 10,
      createVideo: () => v as unknown as HTMLVideoElement,
      makeTexture: () => new THREE.Texture(),
    });
    vi.advanceTimersByTime(11);
    const res = await p;
    vi.useRealTimers();
    expect(res.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run tests/unit/videoTexture.test.ts`
Expected: FAIL — cannot find module `../../src/render/videoTexture`

- [ ] **Step 3: Write minimal implementation**

```typescript
// app/src/render/videoTexture.ts
import * as THREE from 'three';
import type { TextureLoadResult } from './textureLoader';

const DEFAULT_TIMEOUT_MS = 8000;

export interface VideoLoadOptions {
  timeoutMs?: number;
  /** When true (reduced motion), do not autoplay — leave on the first frame. */
  paused?: boolean;
  /** Injectable for tests; defaults to a real <video> element. */
  createVideo?: () => HTMLVideoElement;
  /** Injectable for tests; defaults to new THREE.VideoTexture(el). */
  makeTexture?: (el: HTMLVideoElement) => THREE.Texture;
}

/**
 * Load a video URL into a looping, muted THREE.VideoTexture. Resolves a `fail` result (never
 * rejects) on error or timeout so the caller can substitute a procedural source — mirrors
 * loadImageTexture. The texture carries userData.video so the VideoPool can pause/free the
 * underlying element when the texture is recycled.
 */
export function loadVideoTexture(
  url: string,
  opts: VideoLoadOptions = {},
): Promise<TextureLoadResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const createVideo = opts.createVideo ?? (() => document.createElement('video'));
  const makeTexture = opts.makeTexture ?? ((el) => new THREE.VideoTexture(el));

  return new Promise((resolve) => {
    const video = createVideo();
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    video.setAttribute?.('playsinline', '');

    let settled = false;
    const finish = (r: TextureLoadResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.oncanplay = null;
      video.onerror = null;
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);

    video.oncanplay = () => {
      try {
        const tex = makeTexture(video);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.userData.ownedByCompositor = true;
        tex.userData.kind = 'video';
        tex.userData.video = video;
        if (!opts.paused) void video.play?.()?.catch?.(() => {});
        finish({ ok: true, texture: tex });
      } catch {
        finish({ ok: false, reason: 'error' });
      }
    };
    video.onerror = () => finish({ ok: false, reason: 'error' });
    video.src = url;
    video.load?.();
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run tests/unit/videoTexture.test.ts`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add app/src/render/videoTexture.ts app/tests/unit/videoTexture.test.ts
git commit -m "feat(render): loadVideoTexture (muted, looping, fail-safe)"
```

---

## Task 7: `VideoPool` (bounded decoders)

**Files:**
- Create: `app/src/render/VideoPool.ts`
- Test: `app/tests/unit/videoPool.test.ts`

**Interfaces:**
- Consumes: `loadVideoTexture`, `VideoLoadOptions` (Task 6); `TextureLoadResult`.
- Produces:
  - `interface VideoPoolOptions { cap: number; reducedMotion?: () => boolean; load?: (url: string, opts?: VideoLoadOptions) => Promise<TextureLoadResult>; }`
  - `class VideoPool` with `acquire(url): Promise<TextureLoadResult>` (loads, seeks to 0, plays unless reduced-motion, tracks active, attaches a `dispose` listener that frees the element, and pauses the oldest playing video beyond `cap`) and `dispose()`.

Cap semantics: at most `cap` videos **decoding** at once. Exceeding it pauses the oldest (it becomes a frozen still — decode stops, texture preserved). The element is fully freed when the LayerStack/compositor disposes the texture (THREE.Texture emits a `dispose` event).

- [ ] **Step 1: Write the failing test**

```typescript
// app/tests/unit/videoPool.test.ts
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { VideoPool } from '../../src/render/VideoPool';

function fakeVideo() {
  return {
    currentTime: 1, paused: true,
    play: vi.fn(function (this: any) { this.paused = false; return Promise.resolve(); }),
    pause: vi.fn(function (this: any) { this.paused = true; }),
    removeAttribute: vi.fn(), load: vi.fn(),
  };
}

function okLoader(reducedPaused = false) {
  return async () => {
    const v = fakeVideo();
    const tex = new THREE.Texture();
    tex.userData.video = v;
    if (!reducedPaused) v.play();
    return { ok: true as const, texture: tex };
  };
}

describe('VideoPool', () => {
  it('acquire seeks to 0 and plays', async () => {
    const pool = new VideoPool({ cap: 2, reducedMotion: () => false, load: okLoader() });
    const res = await pool.acquire('u');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const v = res.texture.userData.video;
    expect(v.currentTime).toBe(0);
    expect(v.play).toHaveBeenCalled();
  });

  it('pauses the oldest playing video beyond cap', async () => {
    const pool = new VideoPool({ cap: 1, reducedMotion: () => false, load: okLoader() });
    const a = await pool.acquire('a');
    const b = await pool.acquire('b');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.texture.userData.video.paused).toBe(true);   // evicted -> frozen still
    expect(b.texture.userData.video.paused).toBe(false);  // newest keeps decoding
  });

  it('frees the element when the texture is disposed', async () => {
    const pool = new VideoPool({ cap: 2, reducedMotion: () => false, load: okLoader() });
    const res = await pool.acquire('u');
    if (!res.ok) return;
    const v = res.texture.userData.video;
    res.texture.dispose(); // LayerStack/compositor recycle path emits 'dispose'
    expect(v.pause).toHaveBeenCalled();
    expect(v.removeAttribute).toHaveBeenCalledWith('src');
  });

  it('does not play under reduced motion', async () => {
    const pool = new VideoPool({ cap: 2, reducedMotion: () => true, load: okLoader(true) });
    const res = await pool.acquire('u');
    if (!res.ok) return;
    expect(res.texture.userData.video.play).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run tests/unit/videoPool.test.ts`
Expected: FAIL — cannot find module `../../src/render/VideoPool`

- [ ] **Step 3: Write minimal implementation**

```typescript
// app/src/render/VideoPool.ts
import type * as THREE from 'three';
import { loadVideoTexture, type VideoLoadOptions } from './videoTexture';
import type { TextureLoadResult } from './textureLoader';

export interface VideoPoolOptions {
  /** Max videos decoding at once; older ones are paused (frozen still) beyond this. */
  cap: number;
  /** Defaults to a prefers-reduced-motion media query. */
  reducedMotion?: () => boolean;
  /** Injectable for tests; defaults to loadVideoTexture. */
  load?: (url: string, opts?: VideoLoadOptions) => Promise<TextureLoadResult>;
}

interface Active {
  texture: THREE.Texture;
  video: HTMLVideoElement;
  seq: number;
}

/**
 * Bounds concurrent video decoders in the N-layer compositor. A video plays when acquired;
 * once more than `cap` are playing, the oldest is paused (its texture freezes on its last
 * frame — cheap, and never black). Full teardown of the <video> element follows the texture's
 * lifecycle: when the LayerStack/compositor disposes the texture, we pause + detach the element.
 */
export class VideoPool {
  private readonly active: Active[] = [];
  private seq = 0;

  constructor(private readonly opts: VideoPoolOptions) {}

  async acquire(url: string): Promise<TextureLoadResult> {
    const paused = (this.opts.reducedMotion ?? defaultReducedMotion)();
    const load = this.opts.load ?? loadVideoTexture;
    const res = await load(url, { paused });
    if (!res.ok) return res;

    const video = res.texture.userData.video as HTMLVideoElement;
    try {
      video.currentTime = 0; // deterministic start-point on every show
    } catch {
      /* not seekable yet — harmless */
    }
    if (!paused) void video.play?.()?.catch?.(() => {});

    const entry: Active = { texture: res.texture, video, seq: this.seq++ };
    this.active.push(entry);
    res.texture.addEventListener('dispose', () => this.free(entry));
    this.enforceCap();
    return res;
  }

  dispose(): void {
    for (const a of [...this.active]) this.free(a);
  }

  private enforceCap(): void {
    const cap = Math.max(1, this.opts.cap);
    const playing = this.active.filter((a) => !a.video.paused).sort((a, b) => a.seq - b.seq);
    const overflow = playing.length - cap;
    for (let i = 0; i < overflow; i++) {
      try {
        playing[i].video.pause?.();
      } catch {
        /* ignore */
      }
    }
  }

  private free(entry: Active): void {
    const i = this.active.indexOf(entry);
    if (i !== -1) this.active.splice(i, 1);
    try {
      entry.video.pause?.();
    } catch {
      /* ignore */
    }
    entry.video.removeAttribute?.('src');
    try {
      entry.video.load?.();
    } catch {
      /* ignore */
    }
  }
}

function defaultReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run tests/unit/videoPool.test.ts`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add app/src/render/VideoPool.ts app/tests/unit/videoPool.test.ts
git commit -m "feat(render): VideoPool bounds concurrent decoders, restart-at-0, reduced-motion"
```

---

## Task 8: `Compositor.showVideo`

**Files:**
- Modify: `app/src/render/Compositor.ts`
- Test: `app/tests/unit/compositorVideo.test.ts`

**Interfaces:**
- Consumes: `VideoPool` (Task 7).
- Produces: `Compositor.showVideo(url: string, grade?: string): Promise<TextureLoadResult>` — routes through an internal `VideoPool` (cap 2) and tags `userData.grade` like `showImage`. Exposes `videoPool` (or disposes it in `dispose()`).

The pool is constructed with a test seam: the test replaces `compositor['videoPool']` with a stub before calling `showVideo`. (A single cap-2 pool serves both modes; classic crossfade naturally shows ≤1 at a time.)

- [ ] **Step 1: Write the failing test**

```typescript
// app/tests/unit/compositorVideo.test.ts
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { Compositor } from '../../src/render/Compositor';

describe('Compositor.showVideo', () => {
  it('routes through the video pool and applies grade', async () => {
    const comp = new Compositor();
    const tex = new THREE.Texture();
    const fakePool = { acquire: vi.fn(async () => ({ ok: true as const, texture: tex })), dispose: vi.fn() };
    // inject the stub pool
    (comp as unknown as { videoPool: typeof fakePool }).videoPool = fakePool;

    const res = await comp.showVideo('http://x/film.mp4', 'sepia 0.4');
    expect(fakePool.acquire).toHaveBeenCalledWith('http://x/film.mp4');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.texture.userData.grade).toBe('sepia 0.4');
  });

  it('passes through a fail result unchanged', async () => {
    const comp = new Compositor();
    const fakePool = { acquire: vi.fn(async () => ({ ok: false as const, reason: 'error' as const })), dispose: vi.fn() };
    (comp as unknown as { videoPool: typeof fakePool }).videoPool = fakePool;
    const res = await comp.showVideo('http://x/film.mp4');
    expect(res.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run tests/unit/compositorVideo.test.ts`
Expected: FAIL — `comp.showVideo is not a function`

- [ ] **Step 3: Write minimal implementation**

In `app/src/render/Compositor.ts`, add the import (after line 5):

```typescript
import { VideoPool } from './VideoPool';
```

Add a field near `current` (after line 41):

```typescript
  private videoPool = new VideoPool({ cap: 2 });
```

Add the method right after `showImage` (after line 160):

```typescript
  /** Resolve a video URL to a looping muted VideoTexture via the bounded pool. */
  async showVideo(url: string, grade?: string): Promise<TextureLoadResult> {
    const res = await this.videoPool.acquire(url);
    if (res.ok && grade) res.texture.userData.grade = grade;
    return res;
  }
```

In `dispose()` (after line 211's body, before `this.renderer.dispose()`), add:

```typescript
    this.videoPool.dispose();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run tests/unit/compositorVideo.test.ts`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add app/src/render/Compositor.ts app/tests/unit/compositorVideo.test.ts
git commit -m "feat(render): Compositor.showVideo via bounded VideoPool"
```

---

## Task 9: Conductor video branches (wake + classic)

**Files:**
- Modify: `app/src/dream/conductor.ts`

**Interfaces:**
- Consumes: `Compositor.showVideo` (Task 8); existing `proc`, `markLive`, `IMAGE_FALLBACK_KINDS`, `presRng`, `crossfadeMs`, `setLayerTexture`, `crossfadeTo`.
- Produces: no new exports — adds `type === 'video'` routing in `swapWakeLayer()` and `resolveVisual()`, mirroring the image branch and falling back to a procedural texture on `fail`.

Note: the conductor is not unit-harnessed in this codebase (it wires three.js + audio + DOM). This task is verified by `npm run typecheck` + the existing unit suite (no regressions) + the Task 10 e2e smoke with a real video asset. The branches are a direct structural mirror of the already-tested image branches.

- [ ] **Step 1: Add the wake-mode branch**

In `swapWakeLayer()`, insert a `video` branch between the `image` branch and the trailing `else` (between lines 333 and 334):

```typescript
    } else if (asset.type === 'video' && asset.src) {
      void this.compositor.showVideo(asset.src, asset.grade).then((res) => {
        if (res.ok) {
          stack.setLayerTexture(slot, res.texture);
        } else {
          const kind = IMAGE_FALLBACK_KINDS[this.presRng.int(IMAGE_FALLBACK_KINDS.length)];
          const src = this.proc(`fallback:${asset.id}`, kind);
          this.markLive(src);
          stack.setLayerTexture(slot, src.texture);
        }
      });
```

- [ ] **Step 2: Add the classic-mode branch**

In `resolveVisual()`, insert a `video` branch after the image `if (... 'image' ...) { ... return; }` block (after line 436):

```typescript
    if (asset.type === 'video' && asset.src) {
      void this.compositor.showVideo(asset.src, asset.grade).then((res) => {
        if (res.ok) {
          this.compositor.crossfadeTo(res.texture, transition, this.crossfadeMs());
        } else {
          const kind = IMAGE_FALLBACK_KINDS[this.presRng.int(IMAGE_FALLBACK_KINDS.length)];
          const src = this.proc(`fallback:${asset.id}`, kind);
          this.markLive(src);
          this.compositor.crossfadeTo(src.texture, transition, this.crossfadeMs());
        }
      });
      return;
    }
```

- [ ] **Step 3: Typecheck + full unit suite**

Run: `cd app && npm run typecheck && npm run lint && npx vitest run`
Expected: PASS (no type/lint errors; all unit tests green)

- [ ] **Step 4: Commit**

```bash
git add app/src/dream/conductor.ts
git commit -m "feat(dream): route video assets to showVideo in wake + classic modes"
```

---

## Task 10: Seed a video asset + e2e smoke

**Files:**
- Modify: `app/public/manifest.seed.json`

**Interfaces:**
- Consumes: the runtime video path (Tasks 6-9).
- Produces: a `type:"video"` asset in the seed manifest so the Playwright smoke exercises the real path offline.

- [ ] **Step 1: Inspect the seed manifest shape**

Run: `cd app && node -e "const m=require('./public/manifest.seed.json'); console.log(m.embeddingDim, m.assets[0])"`
Expected: prints `embeddingDim` and a sample asset (copy its `embedding` length + `mood` keys for the new asset).

- [ ] **Step 2: Add one video asset**

Add an entry to the `assets` array in `app/public/manifest.seed.json`, reusing an existing asset's `embedding` array (correct length) and `mood` keys verbatim, with a small public-domain sample mp4 URL (e.g. an Archive.org `.mp4`) as `src`:

```json
{
  "id": "vid-seed-0",
  "type": "video",
  "src": "https://archive.org/download/Popeye_forPresident/Popeye_forPresident_512kb.mp4",
  "embedding": [/* paste an existing asset's embedding array verbatim */],
  "mood": {/* paste an existing asset's mood object verbatim */},
  "tags": ["film", "archive"],
  "dwellBase": 7.5,
  "source": "Archive.org / Prelinger",
  "license": "PD"
}
```

- [ ] **Step 3: Validate the seed manifest against the zod loader**

Run: `cd app && npx tsx scripts/validate-manifest.ts public/manifest.seed.json`
Expected: PASS (validates; embedding L2-norm within tolerance)

- [ ] **Step 4: Run the e2e smoke (kill stale 4173 first)**

Run:
```bash
cd app
# Windows PowerShell: Get-NetTCPConnection -LocalPort 4173 | %{ Stop-Process -Id $_.OwningProcess -Force }
npm run test:e2e
```
Expected: PASS (`?wake=1` renders; ~60s real run that rebuilds — not a <15s reused-server false-green)

- [ ] **Step 5: Commit**

```bash
git add app/public/manifest.seed.json
git commit -m "test(e2e): seed a video asset for the wake-mode smoke"
```

---

## Task 11: Ship the real corpus + update handoff

**Files:**
- Modify: `docs/HANDOFF.md`

This task is operational (no TDD). It requires ffmpeg locally and the user's R2 API keys.

- [ ] **Step 1: Install ffmpeg**

Run: `winget install --id Gyan.FFmpeg -e` then confirm `ffmpeg -version`.
Expected: ffmpeg on PATH.

- [ ] **Step 2: Build the corpus end-to-end**

Run: `cd pipeline && make corpus`
Expected: ingest → download (images + videos + posters) → embed → manifest. Note the kept-video count in the `[build_manifest] curation: kept N/M video assets` line.

- [ ] **Step 3: Provide R2 creds and upload**

`pipeline/.env` is absent in this clone (gitignored). Add it with the 3 non-secret R2 vars (from `docs/HANDOFF.md`) plus the user's 2 secret API keys, then:
Run: `cd pipeline && set -a && . ./.env && set +a && make corpus UPLOAD=1`
(Or have the user run the upload via `!` if they prefer not to share keys.)
Expected: `[publish] published: {...}` with versioned + latest URLs.

- [ ] **Step 4: Verify live**

Run:
```bash
curl -s https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json | grep -o '"type": "video"' | wc -l
```
Expected: ≥1 video asset. Then open `https://dreamreel.pages.dev/?wake=1` and confirm a moving clip appears. Spot-check a `.mp4` returns `200 video/mp4`.

- [ ] **Step 5: Update the handoff + roadmap**

Edit `docs/HANDOFF.md`: mark **Round 4 — Video** as ✅ shipped with the new corpus version, video count, and date; update the roadmap table row.

- [ ] **Step 6: Commit**

```bash
git add docs/HANDOFF.md
git commit -m "docs(handoff): round 4 video shipped"
```

---

## Self-Review

**Spec coverage:**
- Pipeline poster-frame extraction → Task 1. ✓
- Fetch videos without disturbing image indexing → Task 2 (separate `fetched_videos.jsonl`). ✓
- Reuse image embedder for posters → Task 4. ✓
- `VIDEO_CUTOFF = 0.45` → Tasks 3-4. ✓
- `_local` carried then stripped before upload → Tasks 4-5. ✓
- `transcode_video` (muted) wiring + `.mp4 → video/mp4` upload → Task 5 (verified; already wired). ✓
- `loadVideoTexture` (muted/loop/playsInline, fail-safe) → Task 6. ✓
- `VideoPool` (cap 2, restart-at-0, reduced-motion freeze, dispose-driven teardown) → Task 7. ✓
- `Compositor.showVideo` → Task 8. ✓
- Conductor video branch in **both** modes, procedural fallback → Task 9. ✓
- Determinism (seek 0 on show; selection unchanged) → Tasks 6-7, 9. ✓
- Tests: pipeline pytest, renderer vitest, e2e smoke → all tasks + Task 10. ✓
- Ship (ffmpeg, rebuild, R2 upload, verify, handoff) → Task 11. ✓
- Manifest contract unbroken (zod strips `_local`; video already in enum) → confirmed in design; Task 4 Step 5 re-runs the suite. ✓

**Placeholder scan:** The only intentional fill-in is Task 10 Step 2 (paste an existing embedding/mood from the seed manifest) — it cannot be hardcoded because it must match the seed file's exact `embeddingDim`; Step 1 obtains it and Step 3 validates it. No other TBDs.

**Type consistency:** `TextureLoadResult` (ok/fail union) is reused unchanged across `loadVideoTexture`, `VideoPool`, `Compositor.showVideo`, and the conductor branches. `VideoLoadOptions.paused` is the single reduced-motion signal threaded loader→pool. `userData.video` is written in Task 6 and read in Task 7. `_local` is written in Task 4 (`build_video_assets`), read in `publish/run.py` `build_derivatives` (existing), and stripped in Task 5 (`publish_manifest`). `vid-{i:04d}` ids are produced in Task 4 and never re-indexed by publish (videos carry `_local` directly). Consistent.
