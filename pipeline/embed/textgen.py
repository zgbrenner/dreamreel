"""Generative stream-of-consciousness text engine for DREAMREEL's drifting text layer.

The drifting text was a small hand-authored pool. This expands it into a large, varied, ORIGINAL
pool via a deterministic Tracery-style grammar written in the DREAMREEL voice (surreal, oceanic,
mechanical, elegiac). Each generated line is embedded with the SAME CLIP-text model the corpus uses
(OpenCLIP ViT-B/32, laion2b) and projected onto the manifest's 12 mood axes, so the dreamwalker can
surface text that rhymes emotionally with the imagery — exactly like the curated lines.

Why a grammar rather than sampling the Gutenberg Poetry Corpus: the corpus packaging carries no
license, and DREAMREEL clears rights per asset for a commercial product. Original grammar output is
unambiguously clean AND deterministic (a seeded expansion), and endless variety is on-brand. Ingesting
public-domain poetry remains a clean EXTENSION once a per-line PD-clearable source is wired.

The grammar + expander are pure (unit-tested without torch); embedding lazy-imports the `embed` extra.

Usage (from pipeline/, needs the `embed` extra):
    python -m embed.textgen --out out --count 200
    python -m embed.textgen --manifest out/manifest.json --out out --count 200 --upload
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import requests

DEFAULT_MANIFEST_URL = (
    "https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json"
)

# Original DREAMREEL-voice grammar. Symbols are expanded recursively; #sym# references another rule.
GRAMMAR: dict[str, list[str]] = {
    "origin": [
        "#the_subject# #predicate#",
        "#the_subject# #predicate#, and #the_subject# #predicate#",
        "somewhere #the_subject# #predicate#",
        "#time#, #the_subject# #predicate#",
        "#the_subject# #predicate# the way #the_subject# #soft_verb# #object#",
    ],
    "the_subject": [
        "the #noun#",
        "a #adj# #noun#",
        "every #noun#",
        "the #noun# of #noun#",
        "what is left of the #noun#",
    ],
    "predicate": [
        "#verb# #object#",
        "#verb# #object# in the #adj# #noun#",
        "is #adj# with #noun#",
        "#verb# until #clause#",
        "keeps #gerund# #object#",
        "#soft_verb# #object# and never #verb# again",
    ],
    "clause": [
        "the #noun# forgets its name",
        "the #noun# learns to #verb#",
        "no one is #gerund#",
        "the #adj# #noun# comes home",
        "morning #verb# the #noun#",
    ],
    "object": [
        "the #noun#",
        "every #noun#",
        "the #adj# #noun#",
        "a #noun# it cannot keep",
        "the names of the #noun#",
        "your #noun#",
    ],
    "noun": [
        "clock", "tide", "lighthouse", "wallpaper", "orchard", "staircase", "mirror", "comet",
        "ocean", "telegram", "chandelier", "snow", "harbor", "lantern", "wheatfield", "museum",
        "projector", "moth", "doorway", "rust", "gramophone", "meadow", "cathedral", "ledger",
        "wireless", "carousel", "almanac", "garden", "shoreline", "winter", "hourglass", "reef",
    ],
    "adj": [
        "drowned", "patient", "half-remembered", "amber", "unlit", "tidal", "forgotten", "slow",
        "salt", "borrowed", "vacant", "luminous", "rusted", "sleepless", "distant", "frostbitten",
        "hollow", "quiet", "lacquered", "wandering", "antique", "phantom", "gentle", "marbled",
    ],
    "verb": [
        "forgets", "rehearses", "memorizes", "dreams", "translates", "confesses", "swallows",
        "counts", "drafts", "mistakes", "keeps", "loses", "returns", "remembers", "practices",
        "buries", "answers", "mourns", "inherits", "abandons", "echoes",
    ],
    "soft_verb": [
        "drifts toward", "leans into", "settles over", "dissolves into", "reaches for", "folds into",
    ],
    "gerund": [
        "counting", "drowning", "rehearsing", "forgetting", "translating", "mourning", "keeping",
    ],
    "time": [
        "at the hour without a number", "long after the reel ends", "in the year that was never built",
        "between two winters", "while the projector sleeps", "on the far side of morning",
    ],
}

_TOKEN = re.compile(r"#(\w+)#")
_LEADING_ART = re.compile(r"^(the|a) (the|a) ", re.IGNORECASE)


def _resolve(symbol: str, rng: random.Random, depth: int = 0) -> str:
    """Expand one symbol deterministically: leftmost #token# first, one draw at a time."""
    options = GRAMMAR.get(symbol)
    if options is None:
        return symbol
    text = options[rng.randrange(len(options))]
    # Resolve nested tokens leftmost-first so the rng draw order is deterministic.
    guard = 0
    while True:
        m = _TOKEN.search(text)
        if m is None or depth > 12 or guard > 64:
            break
        repl = _resolve(m.group(1), rng, depth + 1)
        text = text[: m.start()] + repl + text[m.end() :]
        guard += 1
    return text


def _tidy(line: str) -> str:
    line = re.sub(r"\s+", " ", line).strip()
    line = _LEADING_ART.sub(lambda m: m.group(0).split()[0] + " ", line)  # collapse "the a"/"a the"
    # a → an before a vowel sound (all vowel-initial words in the grammar take "an").
    line = re.sub(
        r"\b([Aa]) ([aeiouAEIOU])",
        lambda m: ("an" if m.group(1) == "a" else "An") + " " + m.group(2),
        line,
    )
    return line


def expand_lines(seed: str, count: int, max_attempts: int | None = None) -> list[str]:
    """Deterministically generate `count` unique, well-formed lines for `seed`. Pure (no torch)."""
    rng = random.Random(f"{seed}:textgen")
    attempts = max_attempts if max_attempts is not None else count * 40
    seen: set[str] = set()
    out: list[str] = []
    for _ in range(attempts):
        line = _tidy(_resolve("origin", rng))
        if "#" in line or not (18 <= len(line) <= 90):
            continue
        if line in seen:
            continue
        seen.add(line)
        out.append(line)
        if len(out) >= count:
            break
    return out


def _emb_list(v: np.ndarray) -> list[float]:
    return [round(float(x), 6) for x in v.tolist()]


def _mood_or_neutral(v: np.ndarray, axes: dict[str, np.ndarray], dim_ok: bool) -> dict[str, float]:
    """Project mood onto the axes, or a neutral 0.5-per-axis placeholder when the embedder dim
    doesn't match the corpus axes dim — see build_text_assets."""
    from embed.mood_axes import project_mood

    return project_mood(v, axes) if dim_ok else {a: 0.5 for a in axes}


def build_text_assets(embedder, axes: dict[str, np.ndarray], lines: list[str]) -> list[dict]:
    """Embed + mood-project each line into a manifest text asset.

    If the embedder's dim doesn't match the corpus mood-axis dim (e.g. CLIP-512 against a SigLIP
    768/1152-d manifest), embeddings + moods are PROVISIONAL — a SigLIP/so400m re-embed must follow
    to set the real values. We warn and write placeholders rather than crash.
    """
    from embed.clip_backend import l2_normalize

    vecs = embedder.embed_texts(lines)
    axis_dim = len(next(iter(axes.values()))) if axes else 0
    dim_ok = int(vecs.shape[1]) == axis_dim
    if not dim_ok:
        print(
            f"[textgen] WARN embedder dim {vecs.shape[1]} != corpus mood-axis dim {axis_dim}: writing "
            f"provisional embeddings + neutral moods — a SigLIP re-embed must follow before shipping"
        )
    assets: list[dict] = []
    for i, (line, v) in enumerate(zip(lines, vecs)):
        v = l2_normalize(v.reshape(1, -1))[0]
        assets.append({
            "id": f"txt-gen-{i:04d}",
            "type": "titlecard",  # text-pool entries carry `text`; the walker treats tags, not type
            "text": line,
            "embedding": _emb_list(v),
            "mood": _mood_or_neutral(v, axes, dim_ok),
            "tags": ["drift", "whisper", "generated"],
            "dwellBase": 4,
            "source": "DREAMREEL / generative grammar",
            "license": "CC0",
        })
    return assets


def load_manifest(path: Path | None, url: str | None) -> dict[str, Any]:
    if path and path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    fetch_url = url or DEFAULT_MANIFEST_URL
    print(f"[textgen] fetching {fetch_url}")
    resp = requests.get(fetch_url, timeout=120)
    resp.raise_for_status()
    return resp.json()


def augment_manifest(manifest: dict[str, Any], count: int, seed: str) -> tuple[dict, int]:
    """Append generated lines to texts[]; returns (manifest, n_added). Needs the `embed` extra."""
    out = json.loads(json.dumps(manifest))
    lines = expand_lines(seed, count)
    try:
        from embed.clip_backend import get_embedder
    except ImportError:
        print("[textgen] note: needs the `embed` extra (torch + open_clip) to embed lines")
        return out, 0
    embedder = get_embedder()
    axes = {a: np.asarray(v, dtype=np.float32) for a, v in out["moodAxes"].items()}
    new_assets = build_text_assets(embedder, axes, lines)
    out["texts"] = list(out.get("texts", [])) + new_assets
    out["version"] = datetime.now(timezone.utc).strftime("%Y.%m.%d-%H%M")
    out["createdAt"] = datetime.now(timezone.utc).isoformat()
    return out, len(new_assets)


def main() -> None:
    ap = argparse.ArgumentParser(description="DREAMREEL generative text engine")
    ap.add_argument("--manifest", type=Path, default=None)
    ap.add_argument("--url", type=str, default=None)
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--count", type=int, default=200, help="number of lines to generate")
    ap.add_argument("--seed", type=str, default="dreamreel-text-v1", help="generation seed (deterministic)")
    ap.add_argument("--preview", action="store_true", help="print sample lines and exit (no embed)")
    ap.add_argument("--upload", action="store_true", help="upload manifest-only to R2 (needs R2_* env)")
    args = ap.parse_args()

    if args.preview:
        for line in expand_lines(args.seed, min(args.count, 30)):
            print("  " + line)
        return

    manifest = load_manifest(args.manifest, args.url)
    before = len(manifest.get("texts", []))
    augmented, added = augment_manifest(manifest, args.count, args.seed)
    print(f"[textgen] texts {before} -> {len(augmented.get('texts', []))} (+{added} generated)")

    args.out.mkdir(parents=True, exist_ok=True)
    out_path = args.out / "manifest.json"
    out_path.write_text(json.dumps(augmented, indent=2) + "\n", encoding="utf-8")
    print(f"[textgen] wrote {out_path}: v{augmented['version']}")

    if args.upload:
        if added == 0:
            raise SystemExit("[textgen] refusing to upload: 0 lines added")
        required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE")
        missing = [k for k in required if not os.environ.get(k)]
        if missing:
            raise SystemExit(f"[textgen] --upload requires R2 env: {missing}")
        from publish.upload_r2 import publish_manifest, write_local_copy

        urls = publish_manifest(augmented, {})
        write_local_copy(augmented, args.out)
        print(f"[textgen] published: {urls}")


if __name__ == "__main__":
    main()
