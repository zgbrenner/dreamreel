"""Normalize raw audio candidates into the manifest-builder shape, applying the same license
gate as the visual pipeline (ingest/licenses.py). Drops disallowed licenses, unknown kinds, and
clips shorter than their kind's minimum window."""

from __future__ import annotations

from ingest.licenses import evaluate

from .transcode_audio import AUDIO_WINDOWS


def normalize_audio(raw: list[dict]) -> list[dict]:
    out: list[dict] = []
    for r in raw:
        kind = r.get("kind")
        if kind not in AUDIO_WINDOWS:
            continue
        decision = evaluate(r.get("license", ""), attribution=r.get("attribution"))
        if not decision.keep:
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
