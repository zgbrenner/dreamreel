"""Granular "ghost music" pad stems from public-domain 78rpm recordings (Great 78 Project).

Turns short snippets of Archive.org `georgeblood` 78rpm transfers into long, ambient,
loopable pad stems for DREAMREEL's audio corpus: a PURE, SEEDED granular synthesizer
(`granulate_pad`) smears a ~25s source snippet into a 60s Hann-windowed grain cloud —
random source positions, grain lengths, and (optionally) per-grain pitch shifts — so the
original melody dissolves into a haunted, texture-like bed.

Two layers, mirroring the rest of the audio pipeline:

- `granulate_pad` is the pure DSP core. It is deterministic: numpy's `default_rng` is
  seeded from a stable SHA-256 hash of the `seed` string, so the same samples + seed
  yield a bit-identical pad. Per-grain pitch shifting uses librosa (the optional `audio`
  extra) via a LAZY import; when librosa is not installed the synth degrades gracefully
  to the no-pitch-shift path — grains land at their original pitch, nothing crashes, and
  the output is still fully deterministic (it just differs from the librosa-enabled
  render, since shifted grain *content* differs; grain positions/lengths are identical
  either way because the semitone value is always drawn from the rng).

- `build_pad_stems` is the operational driver (like audio.build_corpus, not a unit under
  test end-to-end): it searches the `georgeblood` collection with the same advancedsearch
  pattern as `audio.build_corpus.fetch_archive`, ffmpeg-stream-trims a ~25s wav snippet
  (from 8s in, past the needle lead-in), granulates it to a 60s pad, and encodes
  `aud-pad-<ident>.m4a` (aac 128k, loudnorm, +faststart — the transcode_audio
  conventions). It returns candidate dicts in EXACTLY build_corpus's audio-candidate
  shape (id/kind/source/license/tags/duration_sec/loopable/attribution/attribution_url +
  `_local` pointing at the m4a).

Shipping: these rows go through the EXISTING audio.build_corpus / audio.ship_corpus flow
— feed them into `build_audio_assets` (they carry `_local`, so CLAP embedding just works)
alongside the fetched clips before `augment_manifest`, then upload with ship_corpus. No
runtime schema changes are needed: a pad is an ordinary `kind="music"`, `loopable=True`
audio asset.

Run from pipeline/:
    python -m audio.granulate --count 8 --out out/pads --seed dreamreel --rows 40
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import time
import wave
from pathlib import Path

import numpy as np
import requests

from .transcode_audio import LOUDNORM

# Same Archive.org endpoints + politeness conventions as audio.build_corpus.
ARCHIVE_SEARCH = "https://archive.org/advancedsearch.php"
ARCHIVE_META = "https://archive.org/metadata"
ARCHIVE_DL = "https://archive.org/download"
USER_AGENT = "DREAMREEL-corpus/0.1 (+https://dreamreel.example; respectful crawler)"
COLLECTION = "georgeblood"  # the Great 78 Project: PD 78rpm transfers
MP3_FORMATS = {"VBR MP3", "MP3", "128Kbps MP3", "64Kbps MP3", "32Kbps MP3"}

# Snippet window: skip the 78rpm needle lead-in, grab enough material to granulate.
SNIPPET_START = 8.0
SNIPPET_SEC = 25.0
SNIPPET_SR = 22050
# Pad output: one minute of loopable ghost-music bed per source recording.
PAD_SEC = 60.0
# Grains shorter than this (in samples) are too small to pitch-shift meaningfully.
MIN_SHIFT_SAMPLES = 256
# A near-empty m4a means ffmpeg produced silence/failure; treat as a miss (build_corpus parity).
MIN_M4A_BYTES = 8192


# ---------------------------------------------------------------------------
# Pure, seeded granular core
# ---------------------------------------------------------------------------


def _stable_seed_int(seed: str) -> int:
    """Stable 64-bit integer from a seed string (process-hash-independent)."""
    return int.from_bytes(hashlib.sha256(seed.encode("utf-8")).digest()[:8], "big")


def _librosa_or_none():
    """Lazy optional import (the `audio` extra) — None when librosa is unavailable."""
    try:
        import librosa  # noqa: PLC0415 — intentionally lazy / optional

        return librosa
    except ImportError:
        return None


def granulate_pad(
    samples: np.ndarray,
    sr: int,
    *,
    seed: str,
    duration_sec: float = 60.0,
    grain_sec: tuple[float, float] = (0.08, 0.45),
    density: float = 24.0,
    pitch_spread: float = 2.0,
) -> np.ndarray:
    """Granulate `samples` into a seeded ambient pad. Pure: same inputs+seed -> identical output.

    Hann-windowed grains with rng-drawn source positions and lengths are overlap-added at
    ~`density` grains/second into a `duration_sec` buffer. Each grain draws a pitch offset in
    +/-`pitch_spread` semitones; the shift is applied via librosa (lazy import) and silently
    skipped — no crash, positions unchanged — when librosa is absent or the shift fails.
    The mix is soft-clipped (tanh) and normalized to a 0.98 peak. Returns mono float32.
    """
    if sr <= 0:
        raise ValueError("sr must be positive")
    src = np.asarray(samples, dtype=np.float64)
    if src.ndim == 2:  # stereo -> mono
        src = src.mean(axis=1)
    src = np.ravel(src)

    n_out = int(round(duration_sec * sr))
    out = np.zeros(n_out, dtype=np.float64)
    if n_out == 0 or src.size == 0 or not np.any(src):
        return out.astype(np.float32)

    rng = np.random.default_rng(_stable_seed_int(seed))
    librosa = _librosa_or_none() if pitch_spread > 0 else None
    lo, hi = grain_sec
    n_grains = max(1, int(round(density * duration_sec)))

    for _ in range(n_grains):
        # Draw order is fixed (glen, s0, o0, semis) and every value is ALWAYS drawn, so the
        # grain layout is identical whether or not librosa/pitch-shifting is in play.
        glen = max(8, int(round(rng.uniform(lo, hi) * sr)))
        glen = max(1, min(glen, src.size, n_out))
        s0 = int(rng.integers(0, src.size - glen + 1))
        o0 = int(rng.integers(0, n_out - glen + 1))
        semis = float(rng.uniform(-pitch_spread, pitch_spread))

        grain = src[s0 : s0 + glen]
        if librosa is not None and glen >= MIN_SHIFT_SAMPLES and semis != 0.0:
            try:
                # n_fft: largest power of two <= glen, capped at 2048, so short grains
                # don't underfill the STFT window.
                n_fft = 1 << min(11, glen.bit_length() - 1)
                shifted = librosa.effects.pitch_shift(
                    grain.astype(np.float32), sr=sr, n_steps=semis, n_fft=n_fft
                )
                shifted = np.asarray(shifted, dtype=np.float64)
                # pitch_shift preserves length in modern librosa; pad/trim defensively.
                if shifted.size < glen:
                    shifted = np.pad(shifted, (0, glen - shifted.size))
                grain = shifted[:glen]
            except Exception:
                pass  # degrade to the unshifted grain — never crash the pad build

        out[o0 : o0 + glen] += grain * np.hanning(glen)

    # Soft-clip the grain pile-up, then normalize to a 0.98 peak (<= 1.0 guaranteed).
    out = np.tanh(out)
    peak = float(np.max(np.abs(out)))
    if peak > 0.0:
        out *= 0.98 / peak
    return out.astype(np.float32)


# ---------------------------------------------------------------------------
# Operational driver: georgeblood -> snippets -> pads -> m4a candidates
# ---------------------------------------------------------------------------


def _search_georgeblood(rows: int) -> list[dict]:
    """advancedsearch over the Great 78 collection (same pattern as build_corpus.fetch_archive)."""
    try:
        r = requests.get(
            ARCHIVE_SEARCH,
            params={
                "q": f"collection:({COLLECTION}) AND mediatype:audio",
                "fl[]": ["identifier", "title", "creator"],
                "sort[]": "downloads desc",
                "rows": rows,
                "page": 1,
                "output": "json",
            },
            headers={"User-Agent": USER_AGENT},
            timeout=40,
        )
        r.raise_for_status()
        return r.json().get("response", {}).get("docs", [])
    except (requests.RequestException, ValueError) as exc:
        print(f"[granulate] archive search failed: {exc}")
        return []


def _pick_mp3(files: list[dict]) -> dict | None:
    """First mp3 derivative in an item's file list (build_corpus's pick rule)."""
    for f in files:
        if f.get("format") in MP3_FORMATS or str(f.get("name", "")).lower().endswith(".mp3"):
            return f
    return None


def _parse_length(val) -> float:
    """Archive file `length` is seconds ('201.4') or 'M:SS'/'H:MM:SS'. Returns seconds (0.0 unknown)."""
    if val is None:
        return 0.0
    s = str(val).strip()
    if not s:
        return 0.0
    try:
        if ":" in s:
            sec = 0.0
            for p in (float(p) for p in s.split(":")):
                sec = sec * 60 + p
            return sec
        return float(s)
    except ValueError:
        return 0.0


def snippet_cmd(url: str, dst: Path) -> list[str]:
    """ffmpeg stream-trim: ~25s mono 16-bit wav snippet from 8s into the remote mp3."""
    return [
        "ffmpeg", "-y",
        "-ss", str(SNIPPET_START),
        "-i", url,
        "-t", str(SNIPPET_SEC),
        "-vn", "-ac", "1", "-ar", str(SNIPPET_SR),
        "-c:a", "pcm_s16le", "-f", "wav",
        str(dst),
    ]


def encode_cmd(src: Path, dst: Path) -> list[str]:
    """ffmpeg encode of a rendered pad wav to .m4a: aac 128k, loudnorm, +faststart."""
    return [
        "ffmpeg", "-y",
        "-i", str(src),
        "-af", LOUDNORM,
        "-vn", "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        str(dst),
    ]


def _run_ffmpeg(cmd: list[str]) -> bool:
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=300)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return False


def _read_wav_mono(path: Path) -> tuple[np.ndarray, int]:
    """Read a 16-bit PCM wav (stdlib wave; no librosa/soundfile needed) as mono float32."""
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        n_ch = w.getnchannels()
        if w.getsampwidth() != 2:
            raise ValueError(f"expected 16-bit PCM wav, got sampwidth={w.getsampwidth()}")
        raw = w.readframes(w.getnframes())
    y = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if n_ch > 1:
        y = y.reshape(-1, n_ch).mean(axis=1)
    return y, sr


def _write_wav_mono(path: Path, samples: np.ndarray, sr: int) -> None:
    """Write mono float samples as a 16-bit PCM wav (stdlib wave)."""
    pcm = (np.clip(np.asarray(samples, dtype=np.float64), -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def build_pad_stems(count: int, out_dir: Path, *, seed: str, rows: int = 40) -> list[dict]:
    """Search georgeblood, granulate `count` recordings into 60s pads, return audio candidates.

    Each returned dict is EXACTLY build_corpus's audio-candidate shape (with `_local` set to
    the encoded m4a), ready to feed into build_audio_assets / augment_manifest / ship_corpus.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    headers = {"User-Agent": USER_AGENT}
    pads: list[dict] = []

    for doc in _search_georgeblood(rows):
        if len(pads) >= count:
            break
        ident = doc.get("identifier")
        if not ident:
            continue
        try:
            m = requests.get(f"{ARCHIVE_META}/{ident}", headers=headers, timeout=40).json()
        except (requests.RequestException, ValueError):
            continue
        time.sleep(0.4)  # be polite to the metadata API
        pick = _pick_mp3(m.get("files", []))
        if not pick:
            continue
        # Need real content past the needle lead-in skip.
        length = _parse_length(pick.get("length"))
        if 0.0 < length < SNIPPET_START + 2.0:
            continue
        url = f"{ARCHIVE_DL}/{ident}/{requests.utils.quote(pick['name'])}"

        snip = out_dir / f"snip-{ident}.wav"
        pad_wav = out_dir / f"pad-{ident}.wav"
        dst = out_dir / f"aud-pad-{ident}.m4a"
        try:
            if not _run_ffmpeg(snippet_cmd(url, snip)) or not snip.exists():
                print(f"[granulate] snippet failed {ident}")
                continue
            try:
                y, sr = _read_wav_mono(snip)
            except (wave.Error, ValueError, EOFError):
                continue
            if y.size == 0:
                continue

            pad = granulate_pad(y, sr, seed=f"{seed}:{ident}", duration_sec=PAD_SEC)
            _write_wav_mono(pad_wav, pad, sr)
            if not _run_ffmpeg(encode_cmd(pad_wav, dst)):
                print(f"[granulate] encode failed {ident}")
                continue
            if not dst.exists() or dst.stat().st_size <= MIN_M4A_BYTES:
                continue
        finally:
            snip.unlink(missing_ok=True)
            pad_wav.unlink(missing_ok=True)

        title = doc.get("title") or ident
        creator = doc.get("creator")
        creator = creator[0] if isinstance(creator, list) and creator else creator
        words = [w.lower() for w in str(title).replace("-", " ").split()[:7]]
        pads.append(
            {
                "id": f"aud-pad-{ident}",
                "kind": "music",
                "source_url": url,
                "source": "Archive.org / Great 78 Project (granulated)",
                "license": "PD",
                "tags": ["pad", "ghost-music", "granulated", *words][:10],
                "duration_sec": float(PAD_SEC),
                "loopable": True,
                **({"attribution": str(creator)} if creator else {}),
                "attribution_url": f"https://archive.org/details/{ident}",
                "_local": str(dst),
            }
        )
        print(f"[granulate] built pad {len(pads)}/{count}: {ident}")

    print(f"[granulate] {len(pads)}/{count} pad stems built")
    return pads


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Granulate Great 78 recordings into ambient ghost-music pad stems"
    )
    ap.add_argument("--count", type=int, default=8, help="pad stems to build")
    ap.add_argument("--out", type=Path, default=Path("out/pads"))
    ap.add_argument("--seed", type=str, default="dreamreel")
    ap.add_argument("--rows", type=int, default=40, help="archive search rows to consider")
    args = ap.parse_args()

    pads = build_pad_stems(args.count, args.out, seed=args.seed, rows=args.rows)
    jsonl = args.out / "pad_stems.jsonl"
    jsonl.write_text("".join(json.dumps(p) + "\n" for p in pads), encoding="utf-8")
    print(f"[granulate] wrote {jsonl} ({len(pads)} rows) — feed these rows through "
          f"audio.build_corpus/ship_corpus (build_audio_assets reads _local) to embed + ship")


if __name__ == "__main__":
    main()
