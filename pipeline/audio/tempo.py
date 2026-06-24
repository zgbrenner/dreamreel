"""Offline rhythmic analysis of audio clips via librosa (ISC) — tempo + normalized energy.

librosa is a heavy, OPTIONAL dependency (the `audio` extra). It is imported lazily so the
license/manifest test suite — and CI, which installs only the core deps — never need it. When
librosa is unavailable or analysis fails for a clip, `analyze_audio` returns None and the caller
simply omits the fields; the runtime then degrades gracefully to its un-quantized behaviour.

The two baked fields:
  - bpm:    detected tempo (beats/min). The app snaps each sampled clip's dwell to a whole number
            of bars at this tempo, so clip swaps land on a musical boundary.
  - energy: RMS loudness normalized to 0..1. The audio walk leans toward louder clips when the
            dream's mood is high-arousal and gentler clips when it is calm.
"""

from __future__ import annotations

# RMS of full-scale-ish program material sits well below 1.0; this reference maps a healthy,
# present mix to ~1.0 while leaving headroom. Tuned so quiet ambience lands low, not at zero.
ENERGY_REF = 0.2

# librosa's beat tracker can wander on a-rhythmic material; clamp to a sane musical band.
BPM_MIN = 50.0
BPM_MAX = 200.0

# Analyse at most this many seconds — enough to fix a stable tempo without decoding long files.
MAX_ANALYZE_SEC = 60.0


def normalize_energy(rms_mean: float, ref: float = ENERGY_REF) -> float:
    """Map a mean RMS amplitude to a 0..1 energy. Pure; testable without librosa."""
    if ref <= 0 or rms_mean <= 0:
        return 0.0
    return max(0.0, min(1.0, float(rms_mean) / ref))


def _sane_bpm(bpm: float) -> float | None:
    """Keep a detected tempo only if finite and inside the musical band, else None."""
    try:
        b = float(bpm)
    except (TypeError, ValueError):
        return None
    if b != b or b <= 0:  # NaN or non-positive
        return None
    # Fold octave errors (e.g. 240 -> 120, 40 -> 80) into the band before rejecting.
    while b > BPM_MAX:
        b /= 2.0
    while b < BPM_MIN:
        b *= 2.0
    if BPM_MIN <= b <= BPM_MAX:
        return round(b, 2)
    return None


def analyze_audio(path: str) -> dict | None:
    """Return {"bpm"?: float, "energy": float} for a local audio file, or None on any failure.

    Lazy-imports librosa; returns None if it is not installed so the pipeline runs without the
    `audio` extra. Always returns at least `energy` on success; `bpm` is included only when a
    sane tempo is found.
    """
    try:
        import librosa  # noqa: PLC0415 — intentionally lazy / optional
    except ImportError:
        return None

    try:
        y, sr = librosa.load(path, sr=22050, mono=True, duration=MAX_ANALYZE_SEC)
    except Exception:
        return None
    if y is None or len(y) == 0:
        return None

    out: dict = {}
    try:
        import numpy as np

        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        # beat_track returns a 0-d / 1-element ndarray; ravel+index to a clean Python scalar.
        bpm = _sane_bpm(float(np.ravel(np.asarray(tempo))[0]))
        if bpm is not None:
            out["bpm"] = bpm
    except Exception:
        pass

    try:
        rms_mean = float(librosa.feature.rms(y=y).mean())
        out["energy"] = round(normalize_energy(rms_mean), 4)
    except Exception:
        # Energy is the cheaper, more robust signal; if even this fails there is nothing to bake.
        if "bpm" not in out:
            return None

    return out or None
