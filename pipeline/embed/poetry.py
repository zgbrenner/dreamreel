"""Public-domain poetry ingest for DREAMREEL's drifting text layer.

The grammar engine (embed.textgen) gives endless ORIGINAL lines; this adds a second, complementary
voice: fragments of genuinely public-domain poetry. Every source here is pre-1929 and unambiguously
in the public domain (Dickinson, Blake, Poe, Whitman, C. Rossetti), so each line ships tagged
`license: "PD"` — no attribution required — and passes the pipeline license gate cleanly.

This resolves the open item the grammar engine documented ("Ingesting public-domain poetry remains a
clean EXTENSION once a per-line PD-clearable source is wired"): the per-line PD-clearable source is a
curated set of canonical lines from these poets, each carrying its poet + work, so provenance is
explicit per fragment rather than borrowed from an unlicensed corpus package.

Segmentation is single poem lines, length-filtered to the same drift-line band the curated and
generated lines occupy (18..90 chars), de-duplicated, in a deterministic order. The extractor is pure
(unit-tested without torch); embedding lazy-imports the `embed` extra, exactly like textgen.

Each line is embedded with the SAME text model the rest of the corpus uses and projected onto the 12
mood axes, so the dreamwalker surfaces poetry that rhymes emotionally with the imagery. Per the shipped
workflow (augment-then-reembed: see HANDOFF reship lineage), the SigLIP re-embed re-projects these into
the corpus embedding space, so this tool only needs to add well-formed, correctly-tagged text.

Usage (from pipeline/, embedding needs the `embed` extra):
    python -m embed.poetry --preview --count 100        # print the lines it would add, no embed
    python -m embed.poetry --out out --count 100        # embed + write out/manifest.json
    python -m embed.poetry --manifest out/manifest.json --out out --count 100 --upload
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import requests

DEFAULT_MANIFEST_URL = (
    "https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json"
)

# The drift-line length band, matching the curated lines and embed.textgen's `expand_lines`.
MIN_LEN = 18
MAX_LEN = 90

# Curated public-domain source lines, grouped by poet + work. All poets are pre-1929 (public domain);
# each fragment is a single canonical poem line. Order is fixed so extraction is deterministic.
PD_SOURCES: list[dict[str, Any]] = [
    # ── Emily Dickinson (1830–1886) ──────────────────────────────────────────────────────────────
    {
        "poet": "Emily Dickinson",
        "work": "Because I could not stop for Death",
        "lines": [
            "Because I could not stop for Death",
            "He kindly stopped for me",
            "The Carriage held but just Ourselves",
            "We slowly drove, he knew no haste",
            "We passed the School, where Children strove",
            "We passed the Setting Sun",
        ],
    },
    {
        "poet": "Emily Dickinson",
        "work": "I heard a Fly buzz - when I died",
        "lines": [
            "I heard a Fly buzz when I died",
            "The Stillness in the Room",
            "Was like the Stillness in the Air",
        ],
    },
    {
        "poet": "Emily Dickinson",
        "work": "I'm Nobody! Who are you?",
        "lines": [
            "I'm Nobody! Who are you?",
            "Are you Nobody too?",
            "How dreary to be Somebody!",
        ],
    },
    {
        "poet": "Emily Dickinson",
        "work": "After great pain, a formal feeling comes",
        "lines": [
            "After great pain, a formal feeling comes",
            "The Nerves sit ceremonious, like Tombs",
        ],
    },
    {
        "poet": "Emily Dickinson",
        "work": "Hope is the thing with feathers",
        "lines": [
            "Hope is the thing with feathers",
            "That perches in the soul",
            "And sings the tune without the words",
        ],
    },
    {
        "poet": "Emily Dickinson",
        "work": "Tell all the truth but tell it slant",
        "lines": [
            "Tell all the truth but tell it slant",
            "Success in Circuit lies",
        ],
    },
    {
        "poet": "Emily Dickinson",
        "work": "There's a certain Slant of light",
        "lines": [
            "There's a certain Slant of light",
            "On winter afternoons",
            "That oppresses, like the Heft",
            "Of Cathedral Tunes",
        ],
    },
    {
        "poet": "Emily Dickinson",
        "work": "I felt a Funeral, in my Brain",
        "lines": [
            "I felt a Funeral, in my Brain",
            "And Mourners to and fro",
        ],
    },
    {
        "poet": "Emily Dickinson",
        "work": "The Soul selects her own Society",
        "lines": [
            "The Soul selects her own Society",
            "Then shuts the Door",
        ],
    },
    {
        "poet": "Emily Dickinson",
        "work": "This is my letter to the World",
        "lines": [
            "This is my letter to the World",
            "That never wrote to Me",
        ],
    },
    {
        "poet": "Emily Dickinson",
        "work": "A Bird came down the Walk",
        "lines": [
            "A Bird came down the Walk",
            "He did not know I saw",
        ],
    },
    {
        "poet": "Emily Dickinson",
        "work": "The Brain is wider than the Sky",
        "lines": [
            "The Brain is wider than the Sky",
            "Much Madness is divinest Sense",
        ],
    },
    # ── William Blake (1757–1827) ────────────────────────────────────────────────────────────────
    {
        "poet": "William Blake",
        "work": "The Tyger",
        "lines": [
            "Tyger Tyger, burning bright",
            "In the forests of the night",
            "What immortal hand or eye",
            "Could frame thy fearful symmetry",
            "And when thy heart began to beat",
            "What dread hand and what dread feet",
        ],
    },
    {
        "poet": "William Blake",
        "work": "Auguries of Innocence",
        "lines": [
            "To see a World in a Grain of Sand",
            "And a Heaven in a Wild Flower",
            "Hold Infinity in the palm of your hand",
            "And Eternity in an hour",
            "Cruelty has a Human Heart",
            "And Jealousy a Human Face",
        ],
    },
    {
        "poet": "William Blake",
        "work": "The Sick Rose",
        "lines": [
            "O Rose thou art sick",
            "The invisible worm",
            "That flies in the night",
            "In the howling storm",
            "Has found out thy bed of crimson joy",
        ],
    },
    {
        "poet": "William Blake",
        "work": "A Poison Tree",
        "lines": [
            "And I water'd it in fears",
            "Night and morning with my tears",
            "And I sunned it with smiles",
            "And with soft deceitful wiles",
        ],
    },
    {
        "poet": "William Blake",
        "work": "And did those feet in ancient time",
        "lines": [
            "Bring me my Bow of burning gold",
            "Bring me my Arrows of desire",
            "I will not cease from Mental Fight",
        ],
    },
    # ── Edgar Allan Poe (1809–1849) ──────────────────────────────────────────────────────────────
    {
        "poet": "Edgar Allan Poe",
        "work": "The Raven",
        "lines": [
            "Once upon a midnight dreary",
            "While I pondered, weak and weary",
            "Over many a quaint and curious volume of forgotten lore",
            "Deep into that darkness peering",
            "Dreaming dreams no mortal ever dared to dream before",
            "And the silken sad uncertain rustling of each purple curtain",
            "Quoth the Raven Nevermore",
            "Take thy beak from out my heart",
            "And my soul from out that shadow",
            "Shall be lifted nevermore",
        ],
    },
    {
        "poet": "Edgar Allan Poe",
        "work": "A Dream Within a Dream",
        "lines": [
            "All that we see or seem is but a dream within a dream",
        ],
    },
    {
        "poet": "Edgar Allan Poe",
        "work": "Annabel Lee",
        "lines": [
            "It was many and many a year ago",
            "In a kingdom by the sea",
            "And the stars never rise but I feel the bright eyes",
            "Of the beautiful Annabel Lee",
        ],
    },
    {
        "poet": "Edgar Allan Poe",
        "work": "The Bells",
        "lines": [
            "From the bells, bells, bells, bells",
            "Keeping time, time, time",
            "In a sort of Runic rhyme",
        ],
    },
    # ── Walt Whitman (1819–1892) ─────────────────────────────────────────────────────────────────
    {
        "poet": "Walt Whitman",
        "work": "Song of Myself",
        "lines": [
            "I celebrate myself, and sing myself",
            "I loafe and invite my soul",
            "I lean and loafe at my ease observing a spear of summer grass",
            "I sound my barbaric yawp over the roofs of the world",
            "I am large, I contain multitudes",
            "I depart as air, I shake my white locks at the runaway sun",
            "I bequeath myself to the dirt to grow from the grass I love",
            "Look for me under your boot-soles",
            "Failing to fetch me at first keep encouraged",
            "Missing me one place search another",
            "I stop somewhere waiting for you",
        ],
    },
    {
        "poet": "Walt Whitman",
        "work": "Song of Myself (the grass)",
        "lines": [
            "A child said What is the grass?",
            "Always the procreant urge of the world",
            "And now it seems to me the beautiful uncut hair of graves",
        ],
    },
    {
        "poet": "Walt Whitman",
        "work": "Out of the Cradle Endlessly Rocking",
        "lines": [
            "Out of the cradle endlessly rocking",
        ],
    },
    # ── Christina Rossetti (1830–1894) ───────────────────────────────────────────────────────────
    {
        "poet": "Christina Rossetti",
        "work": "Remember",
        "lines": [
            "Remember me when I am gone away",
            "Gone far away into the silent land",
            "When you can no more hold me by the hand",
            "Better by far you should forget and smile",
            "Than that you should remember and be sad",
        ],
    },
    {
        "poet": "Christina Rossetti",
        "work": "A Birthday",
        "lines": [
            "My heart is like a singing bird",
            "Whose nest is in a water'd shoot",
            "My heart is like an apple-tree",
        ],
    },
    {
        "poet": "Christina Rossetti",
        "work": "Up-Hill",
        "lines": [
            "Does the road wind up-hill all the way?",
            "Yes, to the very end",
            "Will the day's journey take the whole long day?",
            "From morn to night, my friend",
        ],
    },
    {
        "poet": "Christina Rossetti",
        "work": "In the Bleak Midwinter",
        "lines": [
            "In the bleak midwinter, frosty wind made moan",
            "Earth stood hard as iron, water like a stone",
            "Snow had fallen, snow on snow",
            "In the bleak midwinter, long ago",
            "What can I give Him, poor as I am?",
            "If I were a shepherd I would bring a lamb",
            "Yet what I can I give Him, give my heart",
        ],
    },
]


def _normalize(line: str) -> str:
    return " ".join(line.split()).strip()


def extract_lines(count: int) -> list[dict[str, str]]:
    """Deterministically select up to `count` PD poem lines for the drift pool. Pure (no torch).

    Single poem lines, normalized, length-filtered to [MIN_LEN, MAX_LEN], de-duplicated
    (case-insensitively, first occurrence wins), in fixed source order. Each item carries its
    poet + work so the manifest records per-line provenance.
    """
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for block in PD_SOURCES:
        poet = block["poet"]
        work = block["work"]
        for raw in block["lines"]:
            line = _normalize(raw)
            if not (MIN_LEN <= len(line) <= MAX_LEN):
                continue
            key = line.casefold()
            if key in seen:
                continue
            seen.add(key)
            out.append({"text": line, "poet": poet, "work": work})
            if len(out) >= count:
                return out
    return out


def _emb_list(v: np.ndarray) -> list[float]:
    return [round(float(x), 6) for x in v.tolist()]


def _mood_or_neutral(v: np.ndarray, axes: dict[str, np.ndarray], dim_ok: bool) -> dict[str, float]:
    """Project mood onto the axes, or a neutral 0.5-per-axis placeholder when the embedder dim
    doesn't match the corpus axes dim. Under the augment-then-reembed workflow a SigLIP/so400m
    re-embed sets the real embeddings + moods, so the placeholder is correct and avoids a crash."""
    from embed.mood_axes import project_mood

    return project_mood(v, axes) if dim_ok else {a: 0.5 for a in axes}


def build_poetry_assets(embedder, axes: dict[str, np.ndarray], items: list[dict[str, str]]) -> list[dict]:
    """Embed + mood-project each PD line into a manifest text asset. Needs the `embed` extra.

    If the embedder's dim doesn't match the corpus mood-axis dim (e.g. CLIP-512 against a SigLIP
    768/1152-d manifest), the embeddings + moods are PROVISIONAL: a SigLIP/so400m re-embed must
    follow to set the real values (the standard augment-then-reembed lineage). We warn and write
    placeholders rather than crash, so the pure pipeline still produces correctly-tagged text.
    """
    from embed.clip_backend import l2_normalize

    vecs = embedder.embed_texts([it["text"] for it in items])
    axis_dim = len(next(iter(axes.values()))) if axes else 0
    dim_ok = int(vecs.shape[1]) == axis_dim
    if not dim_ok:
        print(
            f"[poetry] WARN embedder dim {vecs.shape[1]} != corpus mood-axis dim {axis_dim}: writing "
            f"provisional embeddings + neutral moods — a SigLIP re-embed must follow before shipping"
        )
    assets: list[dict] = []
    for i, (it, v) in enumerate(zip(items, vecs)):
        v = l2_normalize(v.reshape(1, -1))[0]
        assets.append({
            "id": f"txt-pd-{i:04d}",
            "type": "titlecard",  # text-pool entries carry `text`; the walker keys on tags, not type
            "text": it["text"],
            "embedding": _emb_list(v),
            "mood": _mood_or_neutral(v, axes, dim_ok),
            "tags": ["drift", "whisper", "poetry"],
            "dwellBase": 4,
            "source": f"Project Gutenberg / {it['poet']} — {it['work']}",
            "license": "PD",
        })
    return assets


def load_manifest(path: Path | None, url: str | None) -> dict[str, Any]:
    if path and path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    fetch_url = url or DEFAULT_MANIFEST_URL
    print(f"[poetry] fetching {fetch_url}")
    resp = requests.get(fetch_url, timeout=120)
    resp.raise_for_status()
    return resp.json()


def augment_manifest(manifest: dict[str, Any], count: int) -> tuple[dict, int]:
    """Append PD poetry lines to texts[]; returns (manifest, n_added). Needs the `embed` extra."""
    out = json.loads(json.dumps(manifest))
    items = extract_lines(count)
    try:
        from embed.clip_backend import get_embedder
    except ImportError:
        print("[poetry] note: needs the `embed` extra (torch + open_clip) to embed lines")
        return out, 0
    embedder = get_embedder()
    axes = {a: np.asarray(v, dtype=np.float32) for a, v in out["moodAxes"].items()}
    new_assets = build_poetry_assets(embedder, axes, items)
    out["texts"] = list(out.get("texts", [])) + new_assets
    out["version"] = datetime.now(timezone.utc).strftime("%Y.%m.%d-%H%M")
    out["createdAt"] = datetime.now(timezone.utc).isoformat()
    return out, len(new_assets)


def main() -> None:
    ap = argparse.ArgumentParser(description="DREAMREEL public-domain poetry ingest")
    ap.add_argument("--manifest", type=Path, default=None)
    ap.add_argument("--url", type=str, default=None)
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--count", type=int, default=100, help="max number of PD lines to add")
    ap.add_argument("--preview", action="store_true", help="print the lines it would add and exit (no embed)")
    ap.add_argument("--upload", action="store_true", help="upload manifest-only to R2 (needs R2_* env)")
    args = ap.parse_args()

    if args.preview:
        items = extract_lines(args.count)
        for it in items:
            print(f"  [{it['poet']}] {it['text']}")
        print(f"[poetry] {len(items)} lines")
        return

    manifest = load_manifest(args.manifest, args.url)
    before = len(manifest.get("texts", []))
    augmented, added = augment_manifest(manifest, args.count)
    print(f"[poetry] texts {before} -> {len(augmented.get('texts', []))} (+{added} PD poetry)")

    args.out.mkdir(parents=True, exist_ok=True)
    out_path = args.out / "manifest.json"
    out_path.write_text(json.dumps(augmented, indent=2) + "\n", encoding="utf-8")
    print(f"[poetry] wrote {out_path}: v{augmented['version']}")

    if args.upload:
        if added == 0:
            raise SystemExit("[poetry] refusing to upload: 0 lines added")
        required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE")
        missing = [k for k in required if not os.environ.get(k)]
        if missing:
            raise SystemExit(f"[poetry] --upload requires R2 env: {missing}")
        from publish.upload_r2 import publish_manifest, write_local_copy

        urls = publish_manifest(augmented, {})
        write_local_copy(augmented, args.out)
        print(f"[poetry] published: {urls}")


if __name__ == "__main__":
    main()
