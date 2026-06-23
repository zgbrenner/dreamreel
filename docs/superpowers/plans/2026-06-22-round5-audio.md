# Round 5 — Sampled Audio as a First-Class Medium — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add recorded sound (music / voice / foley + film-clip native audio) as a first-class dream medium, selected by a second Infinite-Jukebox walk in CLAP space, text-bridge-coupled to the on-screen visual, mixed over the existing synth bed.

**Architecture:** A new offline `pipeline/audio/` stage embeds audio with **CLAP** (hash-fallback for CI) and text-embeds each visual asset's tags into a `claptext` bridge vector; the manifest gains `audio[]` + `audioEmbeddingDim` + visual `claptext`. At runtime a pure `AudioWalker` (seeded `seed+":audio"`) walks the CLAP pool, biased toward the current logical visual's `claptext`, and a `Mixer` (buses + ducking + a bounded `AudioPool`) layers the picks over the untouched synth bed. Everything is gated behind the existing sound/archive toggles. Determinism is preserved: the seeded PRNG is the only randomness, decode/network latency affects timing only.

**Tech Stack:** Python (laion CLAP, ffmpeg, numpy, boto3) offline; TypeScript + Tone.js + Web Audio runtime; Vitest + pytest + Playwright.

## Global Constraints

- **Determinism preserved.** Same `seed` → identical *sequence* of audio assets (timing may vary). No `Math.random` and no new RNG draws in the audio path; the audio walk uses the seeded PRNG (`makeRng` from `app/src/dream/prng.ts`). The audio walk is seeded `seed + ":audio"`.
- **Zero runtime inference.** No CLAP/ML at runtime. All embeddings (audio + the `claptext` bridge) are precomputed offline and shipped in the static manifest.
- **License gate (commercial).** Audio ships only if PD / CC0 / CC-BY (CC-BY only with attribution). Reject CC-BY-NC and unknown licenses in the pipeline, reusing `pipeline/ingest/licenses.py`. CC-BY audio without attribution fails schema validation.
- **TypeScript strict, no `any`** in committed code. ESLint + Prettier. Vitest for `dream/`+`audio/`+`manifest/`; pytest for `pipeline/`.
- **Manifest field names are frozen and additive** — do not rename existing fields. New fields: `Manifest.audio`, `Manifest.audioEmbeddingDim`, `Asset.claptext`.
- **CLIP and CLAP are different spaces.** Both happen to be 512-d but must never be compared. `embeddingDim` indexes CLIP; `audioEmbeddingDim` indexes CLAP. `claptext` lives in CLAP space.
- **No new URL params.** Coupling strength and per-kind weights are tuned constants.

---

### Task 1: CLAP backend (audio + text embeddings, hash-fallback)

Mirrors `pipeline/embed/clip_backend.py` exactly: a real laion-CLAP embedder with a deterministic hash fallback so CI needs no model download. Adds an `embed_audio(paths)` capability alongside `embed_texts(texts)`.

**Files:**
- Create: `pipeline/audio/__init__.py`
- Create: `pipeline/audio/clap_backend.py`
- Test: `pipeline/tests/test_clap_backend.py`

**Interfaces:**
- Consumes: `numpy`; the same `l2_normalize` shape as `embed/clip_backend.py`.
- Produces:
  - `class AudioEmbedder(Protocol)` with `dim: int`, `backend: str`, `embed_texts(texts: Sequence[str]) -> np.ndarray`, `embed_audio(paths: Sequence[str]) -> np.ndarray`.
  - `get_audio_embedder(allow_fallback: bool = True) -> AudioEmbedder`.
  - `l2_normalize(x: np.ndarray) -> np.ndarray` (re-exported for callers).

- [ ] **Step 1: Write the failing test**

```python
# pipeline/tests/test_clap_backend.py
import numpy as np
from audio.clap_backend import get_audio_embedder


def test_fallback_is_deterministic_and_normalized(tmp_path):
    emb = get_audio_embedder(allow_fallback=True)
    assert emb.backend == "hash-fallback"  # no laion_clap installed in CI
    assert emb.dim == 512

    # text embeddings: same text -> identical vector, L2-normalized
    a = emb.embed_texts(["a steam train"])
    b = emb.embed_texts(["a steam train"])
    assert a.shape == (1, 512)
    assert np.allclose(a, b)
    assert np.allclose(np.linalg.norm(a, axis=-1), 1.0)

    # audio embeddings keyed by file content: same bytes -> same vector
    p1 = tmp_path / "x.wav"
    p1.write_bytes(b"RIFF....WAVEdata1234")
    p2 = tmp_path / "y.wav"
    p2.write_bytes(b"RIFF....WAVEdata1234")
    va = emb.embed_audio([str(p1)])
    vb = emb.embed_audio([str(p2)])
    assert va.shape == (1, 512)
    assert np.allclose(va, vb)  # identical bytes -> identical embedding

    # different content -> different vector
    p3 = tmp_path / "z.wav"
    p3.write_bytes(b"RIFF....WAVEdataDIFFERENT")
    vc = emb.embed_audio([str(p3)])
    assert not np.allclose(va, vc)

    # empty inputs -> shape (0, dim)
    assert emb.embed_texts([]).shape == (0, 512)
    assert emb.embed_audio([]).shape == (0, 512)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline && python -m pytest tests/test_clap_backend.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'audio.clap_backend'`

- [ ] **Step 3: Write minimal implementation**

```python
# pipeline/audio/clap_backend.py
"""CLAP backend with a deterministic offline fallback.

Production uses laion CLAP (htsat, 512-dim joint text/audio space) for real audio + text
embeddings. When laion_clap/torch aren't installed (CI, or a quick offline manifest build), we
fall back to a deterministic hashing embedder so the pipeline still produces a structurally
valid manifest. The fallback is not semantic — it exists to exercise the plumbing without a GPU.

This mirrors embed/clip_backend.py but indexes a DIFFERENT (CLAP) space. CLAP vectors must never
be compared against CLIP vectors.
"""

from __future__ import annotations

import hashlib
from typing import Protocol, Sequence

import numpy as np


def l2_normalize(x: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(x, axis=-1, keepdims=True)
    n[n == 0] = 1.0
    return x / n


class AudioEmbedder(Protocol):
    dim: int
    backend: str

    def embed_texts(self, texts: Sequence[str]) -> np.ndarray: ...
    def embed_audio(self, paths: Sequence[str]) -> np.ndarray: ...


class _HashEmbedder:
    """Deterministic, non-semantic CLAP-space embeddings from content hashes (offline fallback)."""

    backend = "hash-fallback"

    def __init__(self, dim: int = 512) -> None:
        self.dim = dim

    def _vec(self, key: str) -> np.ndarray:
        seed = int.from_bytes(hashlib.sha256(key.encode("utf-8")).digest()[:8], "big")
        rng = np.random.default_rng(seed)
        return l2_normalize(rng.standard_normal(self.dim).astype(np.float32))

    def embed_texts(self, texts: Sequence[str]) -> np.ndarray:
        return (
            np.stack([self._vec("ct:" + t) for t in texts])
            if texts
            else np.zeros((0, self.dim), np.float32)
        )

    def embed_audio(self, paths: Sequence[str]) -> np.ndarray:
        out = []
        for p in paths:
            try:
                with open(p, "rb") as f:
                    h = hashlib.sha256(f.read()).hexdigest()
            except OSError:
                h = p
            out.append(self._vec("ca:" + h))
        return np.stack(out) if out else np.zeros((0, self.dim), np.float32)


class _LaionClapEmbedder:
    backend = "laion_clap"

    def __init__(self) -> None:
        import laion_clap  # lazy
        import torch

        self._torch = torch
        self.dim = 512
        self.model = laion_clap.CLAP_Module(enable_fusion=False)
        self.model.load_ckpt()  # downloads the default 630k checkpoint
        self.model.eval()

    def embed_texts(self, texts: Sequence[str]) -> np.ndarray:
        feats = self.model.get_text_embedding(list(texts), use_tensor=False)
        return l2_normalize(np.asarray(feats, dtype=np.float32))

    def embed_audio(self, paths: Sequence[str]) -> np.ndarray:
        if not paths:
            return np.zeros((0, self.dim), np.float32)
        feats = self.model.get_audio_embedding_from_filelist(list(paths), use_tensor=False)
        return l2_normalize(np.asarray(feats, dtype=np.float32))


def get_audio_embedder(allow_fallback: bool = True) -> AudioEmbedder:
    try:
        return _LaionClapEmbedder()
    except Exception as exc:  # noqa: BLE001 - any import/runtime failure -> fallback
        if not allow_fallback:
            raise
        print(f"[clap_backend] laion_clap unavailable ({exc}); using deterministic hash fallback")
        return _HashEmbedder()
```

Also create an empty `pipeline/audio/__init__.py`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline && python -m pytest tests/test_clap_backend.py -v`
Expected: PASS (4 assertions groups; backend == "hash-fallback")

- [ ] **Step 5: Commit**

```bash
git add pipeline/audio/__init__.py pipeline/audio/clap_backend.py pipeline/tests/test_clap_backend.py
git commit -m "feat(pipeline): CLAP audio/text backend with deterministic hash fallback"
```

---

### Task 2: Per-kind audio transcode (trim + loudness normalize)

ffmpeg derivative builder for audio, parallel to `transcode_video`. Each `AudioKind` gets its own duration window and all are loudness-normalized (`loudnorm`) to a consistent level. Returns the derivative path (or `None` on failure / no ffmpeg), exactly like the video transcoder.

**Files:**
- Create: `pipeline/audio/transcode_audio.py`
- Test: `pipeline/tests/test_transcode_audio.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `AUDIO_WINDOWS: dict[str, tuple[float, float]]` mapping kind → `(min_sec, max_sec)`: `{"music": (30.0, 90.0), "voice": (3.0, 10.0), "foley": (5.0, 20.0)}`.
  - `build_audio_cmd(src: Path, dst: Path, kind: str, start_seconds: float = 0.0) -> list[str]` — the ffmpeg argv (pure; unit-tested).
  - `transcode_audio(src: Path, dst_dir: Path, kind: str, start_seconds: float = 0.0) -> Path | None` — runs ffmpeg, returns the `.m4a` path or `None`.

- [ ] **Step 1: Write the failing test**

```python
# pipeline/tests/test_transcode_audio.py
from pathlib import Path

import pytest

from audio.transcode_audio import AUDIO_WINDOWS, build_audio_cmd, transcode_audio


def test_window_bounds_per_kind():
    assert AUDIO_WINDOWS["music"] == (30.0, 90.0)
    assert AUDIO_WINDOWS["voice"] == (3.0, 10.0)
    assert AUDIO_WINDOWS["foley"] == (5.0, 20.0)


def test_cmd_trims_to_kind_max_and_normalizes_loudness():
    cmd = build_audio_cmd(Path("in.wav"), Path("out.m4a"), "voice", start_seconds=2.5)
    # fast-seek start before -i
    assert cmd[:1] == ["ffmpeg"]
    assert "-ss" in cmd and cmd[cmd.index("-ss") + 1] == "2.5"
    assert cmd.index("-ss") < cmd.index("-i")
    # trimmed to the kind's max window (voice -> 10s)
    assert cmd[cmd.index("-t") + 1] == "10.0"
    # loudness-normalized
    assert any("loudnorm" in a for a in cmd)
    # AAC audio, no video stream, faststart for web
    assert "-vn" in cmd
    assert "aac" in cmd
    assert "+faststart" in cmd
    assert cmd[-1] == "out.m4a"


def test_unknown_kind_rejected():
    with pytest.raises(KeyError):
        build_audio_cmd(Path("in.wav"), Path("out.m4a"), "podcast")


def test_transcode_returns_none_without_ffmpeg(tmp_path, monkeypatch):
    import audio.transcode_audio as mod

    def boom(*a, **k):
        raise FileNotFoundError("ffmpeg")

    monkeypatch.setattr(mod.subprocess, "run", boom)
    assert transcode_audio(tmp_path / "x.wav", tmp_path / "out", "music") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline && python -m pytest tests/test_transcode_audio.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'audio.transcode_audio'`

- [ ] **Step 3: Write minimal implementation**

```python
# pipeline/audio/transcode_audio.py
"""Web-optimize audio: trim to a per-kind window, loudness-normalize, encode to AAC/.m4a.

Parallel to publish/transcode.transcode_video. start_seconds is inserted as -ss BEFORE -i for
fast seek (skip intros / silence). Requires ffmpeg on PATH; returns None when ffmpeg is missing
or fails, so a corpus build degrades gracefully (the asset is dropped upstream)."""

from __future__ import annotations

import subprocess
from pathlib import Path

# (min_seconds, max_seconds) per AudioKind. min is advisory (used upstream to drop too-short
# clips); max is the hard trim length passed to ffmpeg -t.
AUDIO_WINDOWS: dict[str, tuple[float, float]] = {
    "music": (30.0, 90.0),
    "voice": (3.0, 10.0),
    "foley": (5.0, 20.0),
}

# EBU R128 integrated-loudness target so music/voice/foley sit at a consistent level.
LOUDNORM = "loudnorm=I=-18:TP=-1.5:LRA=11"


def build_audio_cmd(src: Path, dst: Path, kind: str, start_seconds: float = 0.0) -> list[str]:
    max_seconds = AUDIO_WINDOWS[kind][1]  # raises KeyError for unknown kinds
    return [
        "ffmpeg", "-y",
        "-ss", str(start_seconds),
        "-i", str(src),
        "-t", str(max_seconds),
        "-af", LOUDNORM,
        "-vn",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        str(dst),
    ]


def transcode_audio(src: Path, dst_dir: Path, kind: str, start_seconds: float = 0.0) -> Path | None:
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / (src.stem + ".m4a")
    cmd = build_audio_cmd(src, dst, kind, start_seconds)
    try:
        subprocess.run(cmd, check=True, capture_output=True)
        return dst
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline && python -m pytest tests/test_transcode_audio.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add pipeline/audio/transcode_audio.py pipeline/tests/test_transcode_audio.py
git commit -m "feat(pipeline): per-kind audio transcode (trim + loudnorm + AAC)"
```

---

### Task 3: Audio ingest + license gate

Normalize raw audio candidates from the sources (Archive.org / Musopen / LibriVox / Freesound CC0) into the candidate shape the manifest builder consumes, dropping anything the license gate rejects. Reuses the existing `ingest/licenses.py` allow-set so the audio gate matches the visual gate exactly.

**Files:**
- Create: `pipeline/audio/ingest.py`
- Test: `pipeline/tests/test_audio_ingest.py`

**Interfaces:**
- Consumes: `pipeline/ingest/licenses.py` `is_allowed(license: str) -> bool` (see Step 3 note if the real name differs — the implementer must use the actual exported predicate).
- Produces:
  - `AudioCandidate` keys: `id, kind, source_url, source, license, tags, duration_sec, loopable, attribution?, attribution_url?`.
  - `normalize_audio(raw: list[dict]) -> list[dict]` — keeps only license-allowed rows, coerces to `AudioCandidate`, drops rows whose `duration_sec` is below the kind's min window (`AUDIO_WINDOWS[kind][0]`), and rows with an unknown `kind`.

- [ ] **Step 1: Write the failing test**

```python
# pipeline/tests/test_audio_ingest.py
from audio.ingest import normalize_audio


def _raw(**over):
    base = {
        "id": "a1",
        "kind": "music",
        "source_url": "https://archive.org/x.mp3",
        "source": "Archive.org / 78rpm",
        "license": "PD",
        "tags": ["jazz", "1920s"],
        "duration_sec": 120.0,
        "loopable": False,
    }
    base.update(over)
    return base


def test_keeps_pd_and_cc0_drops_disallowed():
    rows = [
        _raw(id="ok-pd", license="PD"),
        _raw(id="ok-cc0", license="CC0"),
        _raw(id="bad-nc", license="CC-BY-NC-4.0"),
        _raw(id="bad-unknown", license="All Rights Reserved"),
    ]
    out = normalize_audio(rows)
    ids = {r["id"] for r in out}
    assert ids == {"ok-pd", "ok-cc0"}


def test_drops_unknown_kind_and_too_short():
    rows = [
        _raw(id="bad-kind", kind="podcast"),
        _raw(id="short-voice", kind="voice", duration_sec=1.0),  # < voice min 3.0
        _raw(id="ok-voice", kind="voice", duration_sec=6.0),
    ]
    out = normalize_audio(rows)
    assert {r["id"] for r in out} == {"ok-voice"}


def test_carries_attribution_through():
    rows = [_raw(id="cc-by", license="CC-BY-4.0", attribution="Jane Doe",
                 attribution_url="https://example.com")]
    out = normalize_audio(rows)
    assert out[0]["attribution"] == "Jane Doe"
    assert out[0]["attribution_url"] == "https://example.com"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline && python -m pytest tests/test_audio_ingest.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'audio.ingest'`

- [ ] **Step 3: Write minimal implementation**

> **Implementer note:** open `pipeline/ingest/licenses.py` and use its real allow-predicate. If it exposes a different name than `is_allowed` (e.g. `license_allowed`, or an `ALLOWED` set), call that instead of inventing one — do not duplicate the allow-list here. The test only depends on the behavior (PD/CC0/CC-BY allowed, CC-BY-NC/unknown rejected).

```python
# pipeline/audio/ingest.py
"""Normalize raw audio candidates into the manifest-builder shape, applying the same license
gate as the visual pipeline (ingest/licenses.py). Drops disallowed licenses, unknown kinds, and
clips shorter than their kind's minimum window."""

from __future__ import annotations

from ingest.licenses import is_allowed  # use the real predicate; see implementer note above

from .transcode_audio import AUDIO_WINDOWS


def normalize_audio(raw: list[dict]) -> list[dict]:
    out: list[dict] = []
    for r in raw:
        kind = r.get("kind")
        if kind not in AUDIO_WINDOWS:
            continue
        if not is_allowed(r.get("license", "")):
            continue
        if float(r.get("duration_sec", 0.0)) < AUDIO_WINDOWS[kind][0]:
            continue
        cand = {
            "id": r["id"],
            "kind": kind,
            "source_url": r["source_url"],
            "source": r["source"],
            "license": r["license"],
            "tags": list(r.get("tags", [])),
            "duration_sec": float(r["duration_sec"]),
            "loopable": bool(r.get("loopable", False)),
        }
        if r.get("attribution"):
            cand["attribution"] = r["attribution"]
        if r.get("attribution_url"):
            cand["attribution_url"] = r["attribution_url"]
        out.append(cand)
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline && python -m pytest tests/test_audio_ingest.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add pipeline/audio/ingest.py pipeline/tests/test_audio_ingest.py
git commit -m "feat(pipeline): audio ingest + license gate (reuses ingest/licenses)"
```

---

### Task 4: Manifest assembly — audio pool + claptext bridge

Extend `build_manifest.py` to (a) build `audio[]` assets from normalized audio candidates with CLAP embeddings + mood projection, (b) emit `audioEmbeddingDim`, and (c) add a `claptext` CLAP-text vector to each visual asset (embedding its dominant tags). Pure builder helpers are unit-tested; the full `build()` is exercised by the existing manifest-shape integration test pattern.

**Files:**
- Create: `pipeline/audio/build_audio.py`
- Modify: `pipeline/embed/build_manifest.py` (add audio + claptext wiring into `build()` and the emitted dict)
- Test: `pipeline/tests/test_build_audio.py`

**Interfaces:**
- Consumes: `audio.clap_backend.get_audio_embedder`, `l2_normalize`; `audio.ingest` candidate shape; `embed/mood_axes.py` `build_axes`/`project_mood` (CLAP axes built from the CLAP embedder, separate from the CLIP axes).
- Produces:
  - `build_audio_assets(embedder, axes, candidates: list[dict]) -> list[dict]` — emits `AudioAsset` dicts with `_local` (internal, stripped before upload) + `src` (rewritten on upload), `embedding`, `mood`, `durationSec`, `loopable`, `dwellBase`, license/source/attribution.
  - `claptext_for(embedder, tags: list[str]) -> list[float]` — CLAP-text embedding (rounded floats) of the joined dominant tags; `[]` when tags empty.
  - `_dwell_for_audio(kind: str) -> float`: `music -> 60.0`, `voice -> 7.0`, `foley -> 12.0`.

- [ ] **Step 1: Write the failing test**

```python
# pipeline/tests/test_build_audio.py
import numpy as np

from audio.build_audio import build_audio_assets, claptext_for, _dwell_for_audio
from audio.clap_backend import get_audio_embedder
from embed.mood_axes import build_axes


def test_build_audio_assets_shape_and_internal_fields():
    emb = get_audio_embedder(allow_fallback=True)
    axes = build_axes(emb)  # CLAP-space mood axes
    cands = [
        {"id": "m1", "kind": "music", "source_url": "https://r/x.m4a",
         "source": "Musopen", "license": "PD", "tags": ["piano"],
         "duration_sec": 80.0, "loopable": False, "_local": "/tmp/x.m4a"},
    ]
    out = build_audio_assets(emb, axes, cands)
    a = out[0]
    assert a["id"] == "m1" and a["kind"] == "music"
    assert len(a["embedding"]) == 512
    assert set(a["mood"]) == {"melancholy", "uncanny", "nostalgic", "ominous", "tender", "mechanical"}
    assert a["durationSec"] == 80.0 and a["loopable"] is False
    assert a["dwellBase"] == 60.0
    assert a["_local"] == "/tmp/x.m4a"  # internal path retained for transcode/upload
    assert a["src"] == "https://r/x.m4a"


def test_claptext_deterministic_and_empty_for_no_tags():
    emb = get_audio_embedder(allow_fallback=True)
    v1 = claptext_for(emb, ["steam", "train"])
    v2 = claptext_for(emb, ["steam", "train"])
    assert len(v1) == 512 and v1 == v2
    assert claptext_for(emb, []) == []


def test_dwell_by_kind():
    assert _dwell_for_audio("music") == 60.0
    assert _dwell_for_audio("voice") == 7.0
    assert _dwell_for_audio("foley") == 12.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline && python -m pytest tests/test_build_audio.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'audio.build_audio'`

- [ ] **Step 3: Write minimal implementation**

```python
# pipeline/audio/build_audio.py
"""Build the manifest `audio[]` pool (CLAP embeddings + mood) and the visual `claptext` bridge
vector. Mirrors embed/build_manifest.build_video_assets: keeps an internal _local path for the
transcode/upload steps and a src that publish/upload_r2 rewrites to the R2 URL."""

from __future__ import annotations

import numpy as np

from embed.mood_axes import project_mood

from .clap_backend import l2_normalize

_DWELL = {"music": 60.0, "voice": 7.0, "foley": 12.0}


def _emb_list(v: np.ndarray) -> list[float]:
    return [round(float(x), 6) for x in v.tolist()]


def _dwell_for_audio(kind: str) -> float:
    return _DWELL[kind]


def claptext_for(embedder, tags: list[str]) -> list[float]:
    if not tags:
        return []
    vec = embedder.embed_texts([", ".join(tags)])
    vec = l2_normalize(vec.reshape(1, -1))[0]
    return _emb_list(vec)


def build_audio_assets(embedder, axes, candidates: list[dict]) -> list[dict]:
    if not candidates:
        return []
    embs = embedder.embed_audio([c["_local"] for c in candidates])
    built: list[dict] = []
    for c, emb in zip(candidates, embs):
        emb = l2_normalize(emb.reshape(1, -1))[0]
        asset = {
            "id": c["id"],
            "kind": c["kind"],
            "src": c["source_url"],  # rewritten to the R2 URL in publish/upload_r2
            "_local": c["_local"],  # internal; stripped before upload
            "embedding": _emb_list(emb),
            "mood": project_mood(emb, axes),
            "tags": list(c.get("tags", [])),
            "durationSec": float(c["duration_sec"]),
            "loopable": bool(c.get("loopable", False)),
            "dwellBase": _dwell_for_audio(c["kind"]),
            "source": c["source"],
            "license": c["license"],
        }
        if c.get("attribution"):
            asset["attribution"] = c["attribution"]
        if c.get("attribution_url"):
            asset["attributionUrl"] = c["attribution_url"]
        built.append(asset)
    return built
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline && python -m pytest tests/test_build_audio.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire into `build_manifest.py` and verify the manifest shape**

Modify `pipeline/embed/build_manifest.py`:

1. Add imports near the top:
```python
from audio.build_audio import build_audio_assets, claptext_for
from audio.clap_backend import get_audio_embedder
```

2. In `build()`, after the CLIP `embedder`/`axes` are created, create the CLAP embedder + axes once:
```python
    audio_embedder = get_audio_embedder()
    print(f"[build_manifest] audio embedder backend: {audio_embedder.backend}, dim={audio_embedder.dim}")
    audio_axes = build_axes(audio_embedder)
```

3. When each **image** asset dict is built (in the `for i, (r, emb) in enumerate(...)` image loop), add the bridge vector:
```python
                    "claptext": claptext_for(audio_embedder, c.get("tags", [])),
```
Add the same `"claptext": claptext_for(audio_embedder, c.get("tags", []))` line to the **video** asset dict in `build_video_assets` (pass `audio_embedder` into that function as a new parameter, threaded from `build()`).

4. Build the audio pool from the audio candidates file (`out_dir / "fetched_audio.jsonl"`, normalized via `audio.ingest.normalize_audio`), mirroring how videos are loaded:
```python
    audio_assets: list[dict] = []
    audio_path = out_dir / "fetched_audio.jsonl"
    if audio_path.exists():
        import json as _json
        from audio.ingest import normalize_audio
        with audio_path.open(encoding="utf-8") as f:
            raw_audio = [_json.loads(line) for line in f if line.strip()]
        cands = normalize_audio(raw_audio)
        # each normalized candidate needs a _local derivative path from the audio transcode step;
        # the corpus driver writes it into the jsonl as "_local". Carry it through:
        for cand, raw in zip(cands, [r for r in raw_audio if r.get("id") in {c["id"] for c in cands}]):
            cand["_local"] = raw.get("_local", "")
        audio_assets = build_audio_assets(audio_embedder, audio_axes, cands)
```

5. Add to the emitted `manifest` dict:
```python
        "audioEmbeddingDim": int(audio_embedder.dim),
        "audio": audio_assets,
```

6. Add an integration test asserting the new shape. Append to `pipeline/tests/test_manifest_shape.py` (or create `pipeline/tests/test_manifest_audio_shape.py` if the former's fixtures are awkward):
```python
def test_manifest_includes_audio_pool_and_claptext(tmp_path):
    from embed.build_manifest import build
    out = build(tmp_path, fetched_path=None, videos_path=None)
    import json
    m = json.loads(out.read_text())
    assert "audio" in m and isinstance(m["audio"], list)
    assert "audioEmbeddingDim" in m and m["audioEmbeddingDim"] == 512
    # claptext is present on visual assets that have tags (procedural assets have tag lists too)
    assert all(("claptext" in a) for a in m["assets"])
```

> **Implementer note:** `build()`'s signature is `build(out_dir, fetched_path, videos_path=None)`. If passing `fetched_path=None` trips an existing assumption, pass the same empty-input fixtures the existing `test_manifest_shape.py` uses. Keep the assertion focused on the three new fields.

- [ ] **Step 6: Run the manifest tests**

Run: `cd pipeline && python -m pytest tests/test_build_audio.py tests/test_manifest_shape.py -v`
Expected: PASS (existing manifest tests still green + new audio-shape test)

- [ ] **Step 7: Commit**

```bash
git add pipeline/audio/build_audio.py pipeline/embed/build_manifest.py pipeline/tests/test_build_audio.py pipeline/tests/test_manifest_shape.py
git commit -m "feat(pipeline): emit audio[] pool + audioEmbeddingDim + visual claptext bridge"
```

---

### Task 5: Film-clip native audio + R2 upload of audio media

Stop muting the ~40 film clips (drop `-an`) while keeping a separate muted poster/transcode path, and extend the R2 publisher to upload audio derivatives and strip the internal `_local` field from `audio[]` (mirroring how it strips `_local`/`_clipStart` from videos).

**Files:**
- Modify: `pipeline/publish/transcode.py` (add an audio-preserving clip transcode variant)
- Modify: `pipeline/publish/upload_r2.py` (upload audio media; strip `_local` from `audio[]`)
- Test: `pipeline/tests/test_publish_audio.py`

**Interfaces:**
- Consumes: existing `transcode_video` (kept as the muted variant for posters); existing `publish_manifest` strip logic.
- Produces:
  - `transcode_video_with_audio(src, dst_dir, max_seconds=12, start_seconds=0.0) -> Path | None` — same as `transcode_video` but **without** `-an` (keeps the soundtrack).
  - `publish_manifest` (modified) strips `_local` from every entry of `manifest["audio"]` and rewrites each audio `src` to its R2 URL, exactly as it does for video.

- [ ] **Step 1: Write the failing test**

```python
# pipeline/tests/test_publish_audio.py
from pathlib import Path

from publish.transcode import transcode_video_with_audio, build_clip_audio_cmd


def test_clip_audio_cmd_keeps_soundtrack():
    cmd = build_clip_audio_cmd(Path("in.mp4"), Path("out.mp4"), max_seconds=12, start_seconds=4.0)
    assert "-an" not in cmd            # soundtrack preserved
    assert "-c:a" in cmd and "aac" in cmd
    assert cmd[cmd.index("-t") + 1] == "12"
    assert cmd.index("-ss") < cmd.index("-i")  # fast seek
    assert "+faststart" in cmd


def test_publish_strips_local_from_audio_and_rewrites_src():
    # Mirrors test_publish_video's expectations for the audio pool.
    from publish.upload_r2 import _rewrite_for_upload  # pure helper used by publish_manifest

    manifest = {
        "audio": [
            {"id": "m1", "kind": "music", "src": "https://orig/x.m4a",
             "_local": "/tmp/x.m4a", "embedding": [0.1], "mood": {}, "tags": [],
             "durationSec": 80.0, "loopable": False, "dwellBase": 60.0,
             "source": "Musopen", "license": "PD"},
        ],
    }
    rewritten = _rewrite_for_upload(manifest, base_url="https://cdn.example/r2")
    a = rewritten["audio"][0]
    assert "_local" not in a
    assert a["src"].startswith("https://cdn.example/r2/")
    assert a["src"].endswith(".m4a")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline && python -m pytest tests/test_publish_audio.py -v`
Expected: FAIL — `ImportError: cannot import name 'transcode_video_with_audio'` (and `build_clip_audio_cmd` / `_rewrite_for_upload` may not yet exist).

> **Implementer note:** Read `pipeline/publish/upload_r2.py` first. It already strips `_local`/`_clipStart` and rewrites video `src`. If that logic is inline inside `publish_manifest` rather than a `_rewrite_for_upload(manifest, base_url)` helper, **extract it into that pure helper** (no network, no boto3) and have `publish_manifest` call it — then add the audio pool to the same helper. The test targets the pure helper so upload stays untested-by-network, consistent with the existing video tests. Match whatever base-url/key-naming scheme the video path already uses for `src` rewriting.

- [ ] **Step 3: Write minimal implementation**

In `pipeline/publish/transcode.py`, add (reuse `MAX_SIDE`):
```python
def build_clip_audio_cmd(src: Path, dst: Path, max_seconds: int = 12, start_seconds: float = 0.0) -> list[str]:
    """ffmpeg argv for a short web mp4 that KEEPS its soundtrack (no -an). Used for film clips
    whose native audio the runtime ducks in when the clip is a hero layer."""
    return [
        "ffmpeg", "-y",
        "-ss", str(start_seconds),
        "-i", str(src),
        "-t", str(max_seconds),
        "-vf", f"scale='min({MAX_SIDE},iw)':-2",
        "-c:v", "libx264", "-crf", "26", "-preset", "medium",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        str(dst),
    ]


def transcode_video_with_audio(src: Path, dst_dir: Path, max_seconds: int = 12, start_seconds: float = 0.0) -> Path | None:
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / (src.stem + ".mp4")
    cmd = build_clip_audio_cmd(src, dst, max_seconds, start_seconds)
    try:
        subprocess.run(cmd, check=True, capture_output=True)
        return dst
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
```

In `pipeline/publish/upload_r2.py`, ensure a pure `_rewrite_for_upload(manifest, base_url)` exists that handles `assets`, `texts`, **and** `audio`: for each `audio` entry, derive the R2 key/filename from `_local` (same scheme videos use), set `src` to `f"{base_url}/{key}"`, and delete `_local`. `publish_manifest` calls this helper before uploading.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline && python -m pytest tests/test_publish_audio.py tests/test_publish_video.py -v`
Expected: PASS (new audio tests + existing video publish tests still green)

- [ ] **Step 5: Commit**

```bash
git add pipeline/publish/transcode.py pipeline/publish/upload_r2.py pipeline/tests/test_publish_audio.py
git commit -m "feat(pipeline): film-clip native audio + R2 upload of audio media (strip _local)"
```

---

### Task 6: Manifest types + zod schema for the audio pool

Add the `AudioAsset`/`AudioKind` types, the `audio[]`/`audioEmbeddingDim` manifest fields, and the optional `claptext` on visual assets, with zod validation that enforces CLAP-dim consistency and the CC-BY-attribution rule for audio.

**Files:**
- Modify: `app/src/manifest/types.ts`
- Modify: `app/src/manifest/schema.ts`
- Test: `app/src/manifest/schema.test.ts` (create if absent; otherwise extend)

**Interfaces:**
- Produces (frozen, additive):
```ts
export type AudioKind = 'music' | 'voice' | 'foley';
export interface AudioAsset {
  id: string; kind: AudioKind; src: string;
  embedding: number[]; mood: Record<MoodAxis, number>; tags: string[];
  durationSec: number; loopable: boolean; dwellBase: number;
  source: string; license: string; attribution?: string; attributionUrl?: string;
}
// Manifest gains: audioEmbeddingDim: number; audio: AudioAsset[];
// Asset gains:    claptext?: number[];
```

- [ ] **Step 1: Write the failing test**

```ts
// app/src/manifest/schema.test.ts
import { describe, it, expect } from 'vitest';
import { manifestSchema } from './schema';

const base = () => ({
  version: '1', createdAt: 'now', embeddingDim: 2,
  moodAxes: {
    melancholy: [0, 0], uncanny: [0, 0], nostalgic: [0, 0],
    ominous: [0, 0], tender: [0, 0], mechanical: [0, 0],
  },
  assets: [], texts: [],
  audioEmbeddingDim: 2,
  audio: [] as unknown[],
});

const mood = {
  melancholy: 0.5, uncanny: 0.5, nostalgic: 0.5,
  ominous: 0.5, tender: 0.5, mechanical: 0.5,
};

describe('manifest audio schema', () => {
  it('accepts a valid audio asset', () => {
    const m = base();
    m.audio = [{
      id: 'm1', kind: 'music', src: 'https://r/x.m4a',
      embedding: [0.1, 0.2], mood, tags: ['piano'],
      durationSec: 80, loopable: false, dwellBase: 60,
      source: 'Musopen', license: 'PD',
    }];
    expect(manifestSchema.safeParse(m).success).toBe(true);
  });

  it('rejects an audio embedding whose length != audioEmbeddingDim', () => {
    const m = base();
    m.audio = [{
      id: 'm1', kind: 'music', src: 'https://r/x.m4a',
      embedding: [0.1, 0.2, 0.3], mood, tags: [],
      durationSec: 80, loopable: false, dwellBase: 60,
      source: 'Musopen', license: 'PD',
    }];
    expect(manifestSchema.safeParse(m).success).toBe(false);
  });

  it('rejects a CC-BY audio asset with no attribution', () => {
    const m = base();
    m.audio = [{
      id: 'm1', kind: 'music', src: 'https://r/x.m4a',
      embedding: [0.1, 0.2], mood, tags: [],
      durationSec: 80, loopable: false, dwellBase: 60,
      source: 'Freesound', license: 'CC-BY-4.0',
    }];
    expect(manifestSchema.safeParse(m).success).toBe(false);
  });

  it('accepts visual claptext when present', () => {
    const m = base();
    m.assets = [{
      id: 'i1', type: 'image', src: 'https://r/x.webp',
      embedding: [0.1, 0.2], mood, tags: ['train'],
      dwellBase: 6, source: 'X', license: 'PD',
      claptext: [0.3, 0.4],
    }] as unknown as typeof m.assets;
    expect(manifestSchema.safeParse(m).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run src/manifest/schema.test.ts`
Expected: FAIL (audio assets unknown / stripped; dim + attribution checks absent)

- [ ] **Step 3: Write minimal implementation**

In `app/src/manifest/types.ts` add the `AudioKind`/`AudioAsset` exports, add `claptext?: number[];` to `Asset`, and add `audioEmbeddingDim: number;` + `audio: AudioAsset[];` to `Manifest`.

In `app/src/manifest/schema.ts`:
```ts
const audioKindSchema = z.enum(['music', 'voice', 'foley']);

export const audioAssetSchema = z.object({
  id: z.string().min(1),
  kind: audioKindSchema,
  src: z.string().url(),
  embedding: z.array(z.number()).min(1),
  mood: moodRecord,
  tags: z.array(z.string()),
  durationSec: z.number().positive(),
  loopable: z.boolean(),
  dwellBase: z.number().positive(),
  source: z.string().min(1),
  license: z.string().min(1),
  attribution: z.string().optional(),
  attributionUrl: z.string().optional(),
});
```
Add `claptext: z.array(z.number()).optional()` to `assetSchema`. Add to the manifest object: `audioEmbeddingDim: z.number().int().positive()` and `audio: z.array(audioAssetSchema)`. In the `superRefine`:
```ts
    for (const a of m.audio) {
      if (a.embedding.length !== m.audioEmbeddingDim) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `audio ${a.id} embedding length ${a.embedding.length} != audioEmbeddingDim ${m.audioEmbeddingDim}`,
        });
      }
      if (a.license.toUpperCase().startsWith('CC-BY') && !a.attribution) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `audio ${a.id} is ${a.license} but has no attribution`,
        });
      }
    }
```

> **Implementer note:** the existing `manifestSchema` may be strict about unknown keys via `.strip()` defaults — confirm the existing `assets`/`texts` already round-trip extra optional fields. Adding `claptext` as `.optional()` on `assetSchema` is sufficient. Do not make `audio`/`audioEmbeddingDim` optional — a freshly built manifest always emits them (Task 4).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run src/manifest/schema.test.ts && npx tsc --noEmit -p .`
Expected: PASS + typecheck clean.

> **Implementer note (loader):** if `app/src/manifest/loader.ts` constructs a typed `Manifest` or has fixtures/sample manifests that now lack `audio`/`audioEmbeddingDim`, update them so the loader still parses. Check `app/public/manifest.seed.json` — add `"audioEmbeddingDim": <dim>` and `"audio": []` if the app loads it at dev time and the schema would now reject it.

- [ ] **Step 5: Commit**

```bash
git add app/src/manifest/types.ts app/src/manifest/schema.ts app/src/manifest/schema.test.ts
git commit -m "feat(app): manifest types + zod schema for audio pool + claptext bridge"
```

---

### Task 7: AudioWalker — CLAP Infinite-Jukebox walk + text-bridge coupling

A pure module mirroring `Dreamwalker`: drift + leap + cosine-softmax over the CLAP pool, seeded `seed+":audio"`, biased toward the current logical visual's `claptext`, with per-kind `TYPE_WEIGHTS`. No DOM/Tone. This is the determinism-critical unit.

**Files:**
- Create: `app/src/dream/audioWalker.ts`
- Test: `app/src/dream/audioWalker.test.ts`

**Interfaces:**
- Consumes: `makeRng` (`./prng`), `cosine`/`l2norm` (`./mood`), `AudioAsset` (`../manifest/types`).
- Produces:
```ts
export interface AudioWalkerConfig { seed: string; surreality: number; coupling?: number; }
export interface AudioPick { asset: AudioAsset; dwellMs: number; }
export interface AudioWalkerPools { audio: AudioAsset[]; audioEmbeddingDim: number; }
export interface AudioWalker {
  next(claptext: number[] | undefined, tempoMul: number): AudioPick | null;
  setSurreality(v: number): void;
  reseed(seed: string): void;
}
export function createAudioWalker(pools: AudioWalkerPools, config: AudioWalkerConfig): AudioWalker;
```
- `next` returns `null` only when the pool is empty (so the conductor can no-op when no audio shipped). `dwellMs = asset.dwellBase * 1000 / max(0.1, tempoMul)`.
- Constants: `TYPE_WEIGHTS = { music: 1.0, voice: 0.5, foley: 0.8 }`; default `COUPLING = 0.6`.

- [ ] **Step 1: Write the failing test**

```ts
// app/src/dream/audioWalker.test.ts
import { describe, it, expect } from 'vitest';
import { createAudioWalker, type AudioWalkerPools } from './audioWalker';
import type { AudioAsset } from '../manifest/types';

const mood = {
  melancholy: 0.5, uncanny: 0.5, nostalgic: 0.5,
  ominous: 0.5, tender: 0.5, mechanical: 0.5,
};

function asset(id: string, kind: AudioAsset['kind'], e: number[]): AudioAsset {
  return {
    id, kind, src: `https://r/${id}.m4a`,
    embedding: e, mood, tags: [], durationSec: 10, loopable: false,
    dwellBase: 6, source: 'X', license: 'PD',
  };
}

// A small CLAP-ish pool spread around a 4-d space.
function pool(): AudioWalkerPools {
  return {
    audioEmbeddingDim: 4,
    audio: [
      asset('train', 'foley', [1, 0, 0, 0]),
      asset('rain', 'foley', [0, 1, 0, 0]),
      asset('song', 'music', [0, 0, 1, 0]),
      asset('speech', 'voice', [0, 0, 0, 1]),
      asset('song2', 'music', [0.2, 0, 0.9, 0]),
      asset('speech2', 'voice', [0, 0.2, 0, 0.9]),
    ],
  };
}

function sequence(seed: string, n: number, claptext?: number[], coupling = 0.6): string[] {
  const w = createAudioWalker(pool(), { seed, surreality: 0.5, coupling });
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const pick = w.next(claptext, 1);
    if (pick) out.push(pick.asset.id);
  }
  return out;
}

describe('AudioWalker', () => {
  it('same seed -> identical sequence (determinism)', () => {
    expect(sequence('abc', 30)).toEqual(sequence('abc', 30));
  });

  it('different seeds -> different sequences', () => {
    expect(sequence('abc', 30)).not.toEqual(sequence('xyz', 30));
  });

  it('returns null on an empty pool', () => {
    const w = createAudioWalker({ audio: [], audioEmbeddingDim: 4 }, { seed: 's', surreality: 0.5 });
    expect(w.next(undefined, 1)).toBeNull();
  });

  it('text-bridge bias pulls selection toward the concept; coupling=0 reproduces unbiased', () => {
    // Concept vector aligned with the music axis -> more music when coupling is on.
    const concept = [0, 0, 1, 0];
    const musicCount = (ids: string[]) => ids.filter((id) => id.startsWith('song')).length;

    const biased = sequence('seed-1', 200, concept, 1.5);
    const unbiasedA = sequence('seed-1', 200, concept, 0);
    const unbiasedB = sequence('seed-1', 200, undefined, 0.6);

    expect(musicCount(biased)).toBeGreaterThan(musicCount(unbiasedA));
    // coupling=0 with a concept == no concept at all (bias term vanishes)
    expect(unbiasedA).toEqual(unbiasedB);
  });

  it('per-kind weights lift music over equally-similar voice at the same point', () => {
    // With weights music:1.0 > voice:0.5, a neutral walk should select music at least as often.
    const ids = sequence('weight-seed', 300);
    const music = ids.filter((id) => id.startsWith('song')).length;
    const voice = ids.filter((id) => id.startsWith('speech')).length;
    expect(music).toBeGreaterThan(voice);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run src/dream/audioWalker.test.ts`
Expected: FAIL — `Cannot find module './audioWalker'`

- [ ] **Step 3: Write minimal implementation**

```ts
// app/src/dream/audioWalker.ts
//
// The AudioWalker: the Infinite-Jukebox model in CLAP space, a sibling to the visual
// Dreamwalker. It maintains a point in CLAP embedding space, drifts it (Brownian) and
// occasionally leaps, then selects the next sampled-audio asset by cosine similarity through a
// softmax whose temperature is the Surreality control. Each pick is additionally biased toward
// the current on-screen concept via a CLAP-text "claptext" vector (the text bridge), scaled by
// a fixed coupling constant. Original implementation; no external code copied.
//
// Pure module: no DOM, no Tone. Seeded `seed + ':audio'` so the audio sequence is a distinct but
// deterministic function of the shared dream seed.

import type { AudioAsset, AudioKind } from '../manifest/types';
import { makeRng, type Rng } from './prng';
import { cosine, l2norm } from './mood';

export interface AudioWalkerConfig {
  seed: string;
  surreality: number; // 0..1
  coupling?: number; // text-bridge strength; default COUPLING
}

export interface AudioPick {
  asset: AudioAsset;
  dwellMs: number;
}

export interface AudioWalkerPools {
  audio: AudioAsset[];
  audioEmbeddingDim: number;
}

export interface AudioWalker {
  next(claptext: number[] | undefined, tempoMul: number): AudioPick | null;
  setSurreality(v: number): void;
  reseed(seed: string): void;
}

const RECENT_WINDOW = 4;
// Surface rates per kind (multiplicative on the pre-softmax weight; deterministic).
const TYPE_WEIGHTS: Record<AudioKind, number> = { music: 1.0, voice: 0.5, foley: 0.8 };
const COUPLING = 0.6;

export function createAudioWalker(
  pools: AudioWalkerPools,
  config: AudioWalkerConfig,
): AudioWalker {
  return new AudioWalkerImpl(pools, config);
}

class AudioWalkerImpl implements AudioWalker {
  private readonly audio: AudioAsset[];
  private readonly dim: number;
  private readonly coupling: number;
  private surreality: number;
  private seed: string;
  private rng!: Rng;
  private e!: number[];
  private recent: string[] = [];

  constructor(pools: AudioWalkerPools, config: AudioWalkerConfig) {
    this.audio = pools.audio;
    this.dim = pools.audioEmbeddingDim;
    this.coupling = config.coupling ?? COUPLING;
    this.surreality = clamp01(config.surreality);
    this.seed = config.seed;
    this.resetState();
  }

  next(claptext: number[] | undefined, tempoMul: number): AudioPick | null {
    if (this.audio.length === 0) return null;
    this.advancePoint();
    const asset = this.pick(claptext);
    const dwellMs = (asset.dwellBase * 1000) / Math.max(0.1, tempoMul);
    return { asset, dwellMs };
  }

  setSurreality(v: number): void {
    this.surreality = clamp01(v);
  }

  reseed(seed: string): void {
    this.seed = seed;
    this.resetState();
  }

  private resetState(): void {
    // Salt with ':audio' so this walk is independent of the visual CLIP walk.
    this.rng = makeRng(this.seed + ':audio');
    const start = this.audio[this.rng.int(this.audio.length)].embedding;
    this.e = start.slice();
    this.recent = [];
  }

  private temperature(): number {
    return 0.12 + this.surreality * 1.1;
  }

  private advancePoint(): void {
    const driftScale = 0.12 + this.surreality * 0.6;
    const e = this.e.slice();
    const n = Math.min(this.dim, e.length);
    for (let i = 0; i < n; i++) e[i] += this.rng.gaussian() * driftScale;
    const leapP = this.surreality * 0.28;
    if (this.rng.next() < leapP) {
      this.e = this.audio[this.rng.int(this.audio.length)].embedding.slice();
    } else {
      this.e = l2norm(e);
    }
  }

  private pick(claptext: number[] | undefined): AudioAsset {
    const recent = new Set(this.recent);
    let candidates = this.audio.filter((a) => !recent.has(a.id));
    if (candidates.length === 0) candidates = this.audio;

    const T = this.temperature();
    const useBridge = !!claptext && claptext.length > 0 && this.coupling !== 0;
    // Pre-softmax score: cosine-to-point/T plus the text-bridge term (coupling * cos(asset, concept)).
    const scores = candidates.map((a) => {
      const base = cosine(this.e, a.embedding) / T;
      const bridge = useBridge ? this.coupling * cosine(a.embedding, claptext as number[]) : 0;
      return base + bridge;
    });
    const max = Math.max(...scores);
    let sum = 0;
    const weights = scores.map((s, i) => {
      const w = Math.exp(s - max) * TYPE_WEIGHTS[candidates[i].kind];
      sum += w;
      return w;
    });

    let roll = this.rng.next() * sum;
    let idx = 0;
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i];
      if (roll <= 0) {
        idx = i;
        break;
      }
    }
    const chosen = candidates[idx];
    this.recent.push(chosen.id);
    if (this.recent.length > RECENT_WINDOW) this.recent.shift();
    return chosen;
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run src/dream/audioWalker.test.ts && npx tsc --noEmit -p .`
Expected: PASS (5 tests) + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add app/src/dream/audioWalker.ts app/src/dream/audioWalker.test.ts
git commit -m "feat(app): AudioWalker — CLAP jukebox walk + text-bridge coupling (deterministic)"
```

---

### Task 8: Ducking level math (pure)

The sidechain policy as pure functions returning per-bus gain in dB, given which buses currently want focus. Priority: `voice ≈ filmclip > music > foley > bed`.

**Files:**
- Create: `app/src/audio/ducking.ts`
- Test: `app/src/audio/ducking.test.ts`

**Interfaces:**
- Produces:
```ts
export type BusName = 'bed' | 'music' | 'foley' | 'voice' | 'filmclip';
export interface FocusState { voice: boolean; filmclip: boolean; music: boolean; foley: boolean; }
export function busGainsDb(focus: FocusState): Record<BusName, number>;
```
- Rules: a "focus source" = `voice || filmclip`. When focus present: `voice`/`filmclip` at `0`, `music` `-9`, `foley` `-6`, `bed` `-10`. When no focus present: `music` `0`, `foley` `-3`, `bed` `-5`. A bus with no source playing returns `-Infinity` is **not** used — gains are bus-level trims; the mixer only applies them to buses that have a source. `voice`/`filmclip` gains are `0` whenever they're active, else `0` (their presence is what triggers ducking elsewhere).

- [ ] **Step 1: Write the failing test**

```ts
// app/src/audio/ducking.test.ts
import { describe, it, expect } from 'vitest';
import { busGainsDb } from './ducking';

describe('busGainsDb', () => {
  it('no focus: foley and bed gently trimmed, music at unity', () => {
    const g = busGainsDb({ voice: false, filmclip: false, music: true, foley: true });
    expect(g.music).toBe(0);
    expect(g.foley).toBe(-3);
    expect(g.bed).toBe(-5);
  });

  it('voice focus ducks music/foley/bed harder', () => {
    const g = busGainsDb({ voice: true, filmclip: false, music: true, foley: true });
    expect(g.voice).toBe(0);
    expect(g.music).toBe(-9);
    expect(g.foley).toBe(-6);
    expect(g.bed).toBe(-10);
  });

  it('film-clip audio is a focus source too (same ducking as voice)', () => {
    const g = busGainsDb({ voice: false, filmclip: true, music: true, foley: false });
    expect(g.filmclip).toBe(0);
    expect(g.music).toBe(-9);
    expect(g.bed).toBe(-10);
  });

  it('monotonic: bed is never quieter with focus absent than present', () => {
    const present = busGainsDb({ voice: true, filmclip: false, music: true, foley: true }).bed;
    const absent = busGainsDb({ voice: false, filmclip: false, music: true, foley: true }).bed;
    expect(present).toBeLessThan(absent);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run src/audio/ducking.test.ts`
Expected: FAIL — `Cannot find module './ducking'`

- [ ] **Step 3: Write minimal implementation**

```ts
// app/src/audio/ducking.ts
// Pure ducking policy: given which buses want focus, return a per-bus gain trim in dB. The
// mixer applies these (ramped) only to buses that currently have a source. Priority order is
// voice ~= filmclip > music > foley > bed.

export type BusName = 'bed' | 'music' | 'foley' | 'voice' | 'filmclip';

export interface FocusState {
  voice: boolean;
  filmclip: boolean;
  music: boolean;
  foley: boolean;
}

export function busGainsDb(focus: FocusState): Record<BusName, number> {
  const focusActive = focus.voice || focus.filmclip;
  return {
    voice: 0,
    filmclip: 0,
    music: focusActive ? -9 : 0,
    foley: focusActive ? -6 : -3,
    bed: focusActive ? -10 : -5,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run src/audio/ducking.test.ts && npx tsc --noEmit -p .`
Expected: PASS (4 tests) + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add app/src/audio/ducking.ts app/src/audio/ducking.test.ts
git commit -m "feat(app): pure ducking level math (voice/filmclip > music > foley > bed)"
```

---

### Task 9: AudioPool — bounded concurrent decoders

Mirrors `VideoPool`: bounds how many sampled sources decode/play at once; pauses the oldest beyond the cap; pauses/resumes on tab visibility; injectable loader for tests.

**Files:**
- Create: `app/src/audio/AudioPool.ts`
- Test: `app/src/audio/AudioPool.test.ts`

**Interfaces:**
- Produces:
```ts
export interface PooledAudio { url: string; pause(): void; play(): void; readonly paused: boolean; dispose(): void; }
export interface AudioPoolOptions { cap: number; load?: (url: string) => Promise<PooledAudio>; }
export class AudioPool {
  constructor(opts: AudioPoolOptions);
  acquire(url: string): Promise<PooledAudio>;
  pauseAll(): void;
  resumeAll(): void;
  dispose(): void;
}
```
- Beyond `cap` *playing* sources, the oldest are paused (frozen, not torn down) — exactly `VideoPool.enforceCap`. `dispose()` disposes all.

- [ ] **Step 1: Write the failing test**

```ts
// app/src/audio/AudioPool.test.ts
import { describe, it, expect } from 'vitest';
import { AudioPool, type PooledAudio } from './AudioPool';

function fake(url: string): PooledAudio {
  let paused = false;
  return {
    url,
    play() { paused = false; },
    pause() { paused = true; },
    get paused() { return paused; },
    dispose() { paused = true; },
  };
}

async function poolOf(cap: number) {
  const created: PooledAudio[] = [];
  const pool = new AudioPool({
    cap,
    load: async (url) => { const a = fake(url); created.push(a); return a; },
  });
  return { pool, created };
}

describe('AudioPool', () => {
  it('keeps at most `cap` sources playing; older ones pause', async () => {
    const { pool, created } = await poolOf(2);
    await pool.acquire('a');
    await pool.acquire('b');
    await pool.acquire('c'); // exceeds cap -> oldest (a) paused
    expect(created[0].paused).toBe(true);
    expect(created[1].paused).toBe(false);
    expect(created[2].paused).toBe(false);
  });

  it('pauseAll then resumeAll re-enforces the cap', async () => {
    const { pool, created } = await poolOf(2);
    await pool.acquire('a');
    await pool.acquire('b');
    pool.pauseAll();
    expect(created.every((c) => c.paused)).toBe(true);
    pool.resumeAll();
    expect(created.filter((c) => !c.paused).length).toBe(2);
  });

  it('dispose tears down every source', async () => {
    const { pool, created } = await poolOf(3);
    await pool.acquire('a');
    await pool.acquire('b');
    pool.dispose();
    expect(created.every((c) => c.paused)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run src/audio/AudioPool.test.ts`
Expected: FAIL — `Cannot find module './AudioPool'`

- [ ] **Step 3: Write minimal implementation**

```ts
// app/src/audio/AudioPool.ts
// Bounds concurrent sampled-audio sources, mirroring render/VideoPool. A source plays when
// acquired; once more than `cap` are playing, the oldest is paused (frozen, not torn down).
// pauseAll/resumeAll follow dream pause + tab visibility.

export interface PooledAudio {
  url: string;
  pause(): void;
  play(): void;
  readonly paused: boolean;
  dispose(): void;
}

export interface AudioPoolOptions {
  cap: number;
  /** Injectable for tests; defaults to the streaming/buffered loader in mixer.ts. */
  load?: (url: string) => Promise<PooledAudio>;
}

interface Active {
  src: PooledAudio;
  seq: number;
}

export class AudioPool {
  private readonly active: Active[] = [];
  private seq = 0;

  constructor(private readonly opts: AudioPoolOptions) {}

  async acquire(url: string): Promise<PooledAudio> {
    if (!this.opts.load) throw new Error('AudioPool: no loader configured');
    const src = await this.opts.load(url);
    const entry: Active = { src, seq: this.seq++ };
    this.active.push(entry);
    this.enforceCap();
    return src;
  }

  pauseAll(): void {
    for (const a of this.active) {
      try { a.src.pause(); } catch { /* ignore */ }
    }
  }

  resumeAll(): void {
    for (const a of this.active) {
      try { a.src.play(); } catch { /* ignore */ }
    }
    this.enforceCap();
  }

  dispose(): void {
    for (const a of [...this.active]) {
      try { a.src.dispose(); } catch { /* ignore */ }
    }
    this.active.length = 0;
  }

  private enforceCap(): void {
    const cap = Math.max(1, this.opts.cap);
    const playing = this.active.filter((a) => !a.src.paused).sort((a, b) => a.seq - b.seq);
    const overflow = playing.length - cap;
    for (let i = 0; i < overflow; i++) {
      try { playing[i].src.pause(); } catch { /* ignore */ }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run src/audio/AudioPool.test.ts && npx tsc --noEmit -p .`
Expected: PASS (3 tests) + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add app/src/audio/AudioPool.ts app/src/audio/AudioPool.test.ts
git commit -m "feat(app): AudioPool — bounded concurrent sampled-audio decoders"
```

---

### Task 10: Mixer — bus graph, kind routing, ducking wiring

The real-time mixer: hangs music/foley/voice/filmclip buses off the existing Tone master, routes an `AudioPick` to its kind's bus, drives the `AudioPool`, and applies `busGainsDb` (ramped) as focus changes. Tone/Web-Audio is not unit-harnessed (like the conductor/engine); correctness is gated by typecheck/lint, a small focus-tracking unit test, and manual verification.

**Files:**
- Create: `app/src/audio/mixer.ts`
- Test: `app/src/audio/mixer.test.ts` (focus-state reducer only)

**Interfaces:**
- Consumes: `busGainsDb`/`FocusState` (`./ducking`), `AudioPool`/`PooledAudio` (`./AudioPool`), `AudioPick`/`AudioWalker` types, `AudioAsset`. The mixer accepts the existing Tone master `Gain` so the bed and samples share one node/mute.
- Produces:
```ts
export interface MixerDeps {
  master: import('tone').Gain;          // existing engine master
  pool?: AudioPool;                      // injectable; default cap-3 streaming/buffered loader
}
export interface Mixer {
  show(pick: AudioPick): void;           // route by pick.asset.kind onto its bus
  setFilmClipAudio(active: boolean, el?: HTMLVideoElement): void; // hero clip native audio
  setEnabled(on: boolean): void;         // master sound toggle (also mutes film-clip)
  setArchiveAudio(on: boolean): void;    // archive toggle governs film-clip native audio
  pause(): void; resume(): void; dispose(): void;
}
export function nextFocus(prev: FocusState, kind: AudioAsset['kind'] | 'filmclip', active: boolean): FocusState;
export function createMixer(deps: MixerDeps): Mixer;
```
- `nextFocus` is the pure reducer the test targets: given a focus state and a (kind|'filmclip', active) event, return the updated `FocusState` (music/foley track presence; voice/filmclip track focus). This keeps the duck-trigger logic testable without Web Audio.

- [ ] **Step 1: Write the failing test**

```ts
// app/src/audio/mixer.test.ts
import { describe, it, expect } from 'vitest';
import { nextFocus } from './mixer';
import type { FocusState } from './ducking';

const empty: FocusState = { voice: false, filmclip: false, music: false, foley: false };

describe('nextFocus', () => {
  it('tracks music/foley presence', () => {
    const a = nextFocus(empty, 'music', true);
    expect(a.music).toBe(true);
    const b = nextFocus(a, 'foley', true);
    expect(b.foley).toBe(true);
    expect(nextFocus(b, 'music', false).music).toBe(false);
  });

  it('voice and filmclip toggle focus', () => {
    expect(nextFocus(empty, 'voice', true).voice).toBe(true);
    expect(nextFocus(empty, 'filmclip', true).filmclip).toBe(true);
    expect(nextFocus({ ...empty, voice: true }, 'voice', false).voice).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run src/audio/mixer.test.ts`
Expected: FAIL — `Cannot find module './mixer'`

- [ ] **Step 3: Write minimal implementation**

Implement `app/src/audio/mixer.ts`. The pure `nextFocus` reducer plus a `createMixer` that builds the Tone graph. Key points the implementer must honor (no placeholders — concrete shape below):

```ts
// app/src/audio/mixer.ts
import * as Tone from 'tone';
import { AudioPool, type PooledAudio } from './AudioPool';
import { busGainsDb, type BusName, type FocusState } from './ducking';
import type { AudioPick } from '../dream/audioWalker';
import type { AudioAsset } from '../manifest/types';

const RAMP = 0.4; // seconds, click-free bus-gain ramps
const POOL_CAP = 3;

export function nextFocus(
  prev: FocusState,
  kind: AudioAsset['kind'] | 'filmclip',
  active: boolean,
): FocusState {
  const next = { ...prev };
  if (kind === 'music') next.music = active;
  else if (kind === 'foley') next.foley = active;
  else if (kind === 'voice') next.voice = active;
  else if (kind === 'filmclip') next.filmclip = active;
  return next;
}

export interface MixerDeps {
  master: Tone.Gain;
  pool?: AudioPool;
}

export interface Mixer {
  show(pick: AudioPick): void;
  setFilmClipAudio(active: boolean, el?: HTMLVideoElement): void;
  setEnabled(on: boolean): void;
  setArchiveAudio(on: boolean): void;
  pause(): void;
  resume(): void;
  dispose(): void;
}

export function createMixer(deps: MixerDeps): Mixer {
  // One Tone.Gain per bus, all -> deps.master. dbToGain on each bus from busGainsDb.
  const buses: Record<BusName, Tone.Gain> = {
    bed: new Tone.Gain(1).connect(deps.master),     // bed routed here for ducking trim only
    music: new Tone.Gain(1).connect(deps.master),
    foley: new Tone.Gain(1).connect(deps.master),
    voice: new Tone.Gain(1).connect(deps.master),
    filmclip: new Tone.Gain(1).connect(deps.master),
  };
  const pool = deps.pool ?? new AudioPool({ cap: POOL_CAP, load: defaultLoad });
  let focus: FocusState = { voice: false, filmclip: false, music: false, foley: false };
  let enabled = true;
  let archive = true;

  function applyDuck(): void {
    const g = busGainsDb(focus);
    for (const name of Object.keys(buses) as BusName[]) {
      buses[name].gain.rampTo(enabled ? Tone.dbToGain(g[name]) : 0, RAMP);
    }
  }

  // show(): connect the pooled source for pick.asset.kind into buses[kind]; on a music/voice
  //   swap, crossfade out the previous occupant of that bus. Update focus via nextFocus +
  //   applyDuck. A failed load (pool.acquire rejects) is swallowed (skip), never thrown.
  // setFilmClipAudio(): route the hero <video>'s MediaElementSource into buses.filmclip and
  //   toggle focus; gated by `archive` (archive off => keep it silent) and `enabled`.
  // setEnabled(): enabled = on; applyDuck() (on=false => every bus to 0). One mute for all.
  // setArchiveAudio(): archive = on; if !on, drop film-clip focus + silence that bus.
  // pause()/resume(): pool.pauseAll()/resumeAll(). dispose(): pool.dispose(); dispose buses.

  // ...concrete wiring per the comments above...
  return /* Mixer */ {} as Mixer; // replace with the constructed object
}

async function defaultLoad(url: string): Promise<PooledAudio> {
  // Streamed playback via HTMLAudioElement -> MediaElementAudioSource for long music; the same
  // element works for short voice/foley. The element's own gain stays 1; bus gain does ducking.
  const el = new Audio();
  el.crossOrigin = 'anonymous';
  el.src = url;
  el.loop = false;
  let disposed = false;
  await el.play().catch(() => { /* autoplay/gesture races are harmless; bus is gated by enabled */ });
  return {
    url,
    play() { if (!disposed) void el.play().catch(() => {}); },
    pause() { el.pause(); },
    get paused() { return el.paused; },
    dispose() { disposed = true; el.pause(); el.removeAttribute('src'); el.load(); },
  };
}
```

> **Implementer note:** the `createMixer` body must actually construct and return a working `Mixer` object implementing every method per the inline comments — the `{} as Mixer` placeholder above is illustrative of the signature only and MUST be replaced. Routing a `MediaElementAudioSourceNode` into a Tone bus: use `Tone.getContext().rawContext.createMediaElementSource(el)` and `Tone.connect(node, buses.filmclip)` (or connect the element source to the bus's input). `loopable` foley should set `el.loop = true` when the asset says so — thread that from `show()` by passing the asset to the loader, or set `el.loop` after acquire. Keep the public surface exactly as the Interfaces block specifies; `nextFocus` stays pure and exported for the test.

- [ ] **Step 4: Run the unit test + typecheck + lint**

Run: `cd app && npx vitest run src/audio/mixer.test.ts && npx tsc --noEmit -p . && npm run lint`
Expected: PASS (2 reducer tests) + typecheck + lint clean. (Bus wiring is verified manually in Task 11.)

- [ ] **Step 5: Commit**

```bash
git add app/src/audio/mixer.ts app/src/audio/mixer.test.ts
git commit -m "feat(app): Mixer — bus graph + kind routing + ducking wiring over the synth bed"
```

---

### Task 11: Wire the AudioWalker + Mixer into the conductor and store toggles

Drive the audio walk on its own logical cadence inside the conductor, route picks to the mixer, feed the text bridge from the current logical visual asset, hand the mixer the hero clip's `<video>` for native audio, and thread `setSound`/`setArchive` through to the mixer. Integration task — verified by the full suite staying green plus manual `?wake=1` + classic checks (the conductor/store are not unit-harnessed).

**Files:**
- Modify: `app/src/dream/conductor.ts` (own a `Mixer` + `AudioWalker`; advance + route; thread toggles)
- Modify: `app/src/state/store.ts` and/or `app/src/ui/Gate.tsx` (construct the walker/mixer with the loaded manifest + existing Tone master; pass into the conductor)
- Test: none new (integration); the full `vitest` + `tsc` + `lint` suite is the gate.

**Interfaces:**
- Consumes: `createAudioWalker` (Task 7), `createMixer` (Task 10), the loaded `Manifest` (`audio`, `audioEmbeddingDim`), each visual beat's `asset.claptext` (Task 6), the existing `AudioEngine` master `Gain`.
- Produces: no new exported types; behavioral wiring only.

- [ ] **Step 1: Construct the walker + mixer where the conductor + AudioEngine are created**

Read `app/src/ui/Gate.tsx` (creates `new AudioEngine()`) and `app/src/state/store.ts` (creates the runtime/conductor). Where the manifest is available and the `AudioEngine` is built:
```ts
import { createAudioWalker } from '../dream/audioWalker';
import { createMixer } from '../audio/mixer';
// ...
const audioWalker = manifest.audio.length
  ? createAudioWalker(
      { audio: manifest.audio, audioEmbeddingDim: manifest.audioEmbeddingDim },
      { seed, surreality },
    )
  : null;
// AudioEngine must expose its master Gain; add a getter `get master(): Tone.Gain | undefined`
// to engine.ts if not present, returning this.master. Build the mixer after engine.start():
const mixer = engineMaster ? createMixer({ master: engineMaster }) : null;
```
Pass `audioWalker` and `mixer` into the conductor constructor (extend its signature; both nullable so the no-audio-corpus path is a clean no-op).

- [ ] **Step 2: Advance the audio walk on its own accumulator in the conductor tick**

In `conductor.ts`, add an audio cadence accumulator alongside the existing tick logic (works in both classic and wake). On each frame `dt`:
```ts
// audio cadence: when the current pick's dwell elapses, take the next pick.
this.audioElapsedMs += dt * 1000;
if (this.audioWalker && this.mixer && this.audioElapsedMs >= this.audioDwellMs) {
  const claptext = this.currentVisualAsset?.claptext; // set wherever the image beat is applied
  const pick = this.audioWalker.next(claptext, this.tempoMul);
  if (pick) {
    this.mixer.show(pick);
    this.audioDwellMs = pick.dwellMs;
    this.audioElapsedMs = 0;
  }
}
```
Set `this.currentVisualAsset` wherever the conductor applies the image beat (next to the existing `setMood` calls at the two sites grep found: ~313 and ~405). Initialize `audioElapsedMs = 0`, `audioDwellMs = 0` (so the first frame takes an immediate first pick).

- [ ] **Step 3: Route hero-clip native audio + thread the toggles**

- Where the conductor shows a **video** asset on the hero layer, call `this.mixer?.setFilmClipAudio(true, heroVideoEl)` and `setFilmClipAudio(false)` when it leaves the hero slot. The `<video>` element is `texture.userData.video` (see `VideoPool`).
- In `conductor.setSound(on)` (line ~139): also call `this.mixer?.setEnabled(on)` (in addition to the existing `audio.setVolume`).
- In `conductor.setArchive(on)` (line ~143): also call `this.mixer?.setArchiveAudio(on)`.
- In the conductor's pause/resume/dispose paths: call `this.mixer?.pause()/resume()/dispose()` next to the existing `audio.suspend()/resume()/dispose()`. Wrap mixer calls in the existing `safeAudio(() => ...)` guard so a Web-Audio failure never breaks the render loop.
- On reseed: `this.audioWalker?.reseed(seed)` and reset the audio accumulators.

- [ ] **Step 4: Verify the whole suite + typecheck + lint stay green**

Run: `cd app && npx tsc --noEmit -p . && npm run lint && npx vitest run`
Expected: PASS — all existing + new unit tests green, typecheck + lint clean.

- [ ] **Step 5: Manual verification**

```bash
cd app && npm run build && npm run preview
```
Open the preview URL with a seed, sound ON, in both classic and `?wake=1`:
- Sampled audio layers over the synth bed (you hear recorded sound, not only synth).
- A spoken-word fragment ducks music/foley while it plays.
- When a film clip is the hero image, its own soundtrack ducks in, then out as it leaves.
- Toggling sound OFF silences everything; archive OFF silences film-clip native audio.
- Reloading the same `?seed` replays the same audio sequence (asset order), timing aside.

(If no audio corpus is shipped yet, the walker/mixer are a clean no-op and only the synth bed plays — confirm no console errors in that case too.)

- [ ] **Step 6: Commit**

```bash
git add app/src/dream/conductor.ts app/src/state/store.ts app/src/ui/Gate.tsx app/src/audio/engine.ts
git commit -m "feat(app): wire AudioWalker + Mixer into the conductor (both modes, sound/archive gated)"
```

---

### Task 12: Playwright smoke — audio path starts clean

Extend the existing smoke spec so the audio subsystem is covered by the same "loads, plays, no console errors, bounded heap" guard the wake/video paths use.

**Files:**
- Modify: `tests/e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: the existing smoke harness (start, play, console-error + heap assertions).

- [ ] **Step 1: Add an audio-path assertion to the existing smoke test**

Extend the existing wake-mode test (it already gates console errors + heap) so that after starting playback it lets the reel run long enough for at least one audio pick + mixer `show()` to occur, and asserts no console errors were emitted and the heap stayed bounded. If the harness exposes a way to assert a global (e.g. `window.__dreamreel?` debug hook), assert the mixer constructed; otherwise the no-console-error guard over a longer run is the assertion. Mirror the structure of the current `?wake=1` test rather than inventing a new harness.

> **Implementer note:** read `tests/e2e/smoke.spec.ts` first and follow its exact patterns (selectors, timeouts, the heap-bound check). Do not add a second browser project or new fixtures. Sound may be gated behind a user gesture — reuse whatever click/start the existing test already performs; do not assert on actual audio output (not observable in headless), only that enabling sound + running the reel produces no console errors and no runaway heap.

- [ ] **Step 2: Run the smoke test**

Run: `cd app && npx playwright test tests/e2e/smoke.spec.ts`
Expected: PASS (both existing scenarios, now exercising the audio path without console errors).

- [ ] **Step 3: Commit**

```bash
git add app/tests/e2e/smoke.spec.ts
git commit -m "test(e2e): cover the audio path in the smoke spec (no console errors, bounded heap)"
```

---

## Final integration check (after all tasks)

```bash
cd pipeline && python -m pytest -q
cd ../app && npx tsc --noEmit -p . && npm run lint && npx vitest run && npx playwright test
```
Expected: all green. Then the whole-branch review (subagent-driven-development's final reviewer), then a corpus rebuild + reship is a **separate operational step** (not part of this plan): build a small PD/CC0 audio corpus, run the pipeline end-to-end, and ship `audio[]` to R2.

## Notes for the corpus build (operational, not a code task)

The runtime degrades cleanly with an empty `audio[]` (walker/mixer no-op). Shipping real sound is an offline run of: gather PD/CC0 audio → `normalize_audio` → `transcode_audio` per kind (writing each derivative's `_local` into `fetched_audio.jsonl`) → re-transcode the ~40 clips with `transcode_video_with_audio` → `build_manifest` → `upload_r2`. Sourcing targets: ~60 music (Archive.org 78rpm / Musopen), ~80 voice (LibriVox / Archive.org speeches), ~60 foley (Freesound CC0 / Archive.org field recordings). This mirrors the Round 4 video reship.
