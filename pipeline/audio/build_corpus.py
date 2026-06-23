"""One-shot operational corpus builder for the Round 5 sampled-audio medium.

Fetches PD/CC0/CC-BY audio from the Openverse audio API, maps each item's category to our
AudioKind (music/voice/foley), downloads + transcodes it per-kind, CLAP-embeds it, and AUGMENTS
the existing live manifest in place: it adds `audioEmbeddingDim`, the `audio[]` pool, and a
`claptext` bridge vector to every visual asset — WITHOUT re-embedding or disturbing the shipped
visual corpus (images/videos keep their exact embeddings + R2 srcs).

This is an operational driver (like ingest/run.py), not a unit under test. Run from pipeline/:
    python -m audio.build_corpus --manifest out/manifest.json --out out/ \
        --music 20 --voice 15 --foley 20

Then upload with audio.ship_corpus (uploads the new audio derivatives + the augmented manifest).
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

from embed.mood_axes import build_axes
from .build_audio import build_audio_assets, claptext_for
from .clap_backend import get_audio_embedder
from .clap_transformers import get_transformers_audio_embedder
from .ingest import normalize_audio
from .transcode_audio import AUDIO_WINDOWS


def _best_embedder():
    """Prefer real transformers-CLAP embeddings; fall back to the hash embedder."""
    emb = get_transformers_audio_embedder()
    return emb if emb is not None else get_audio_embedder()

ARCHIVE_SEARCH = "https://archive.org/advancedsearch.php"
ARCHIVE_META = "https://archive.org/metadata"
ARCHIVE_DL = "https://archive.org/download"
USER_AGENT = "DREAMREEL-corpus/0.1 (+https://dreamreel.example; respectful crawler)"

# Each AudioKind sourced from a public-domain Archive.org collection (no auth required):
#   music  <- Great 78 Project (georgeblood): PD 78rpm recordings
#   voice  <- LibriVox: PD audiobook readings
#   foley  <- NASA audio: US-government public-domain mission/atmosphere audio
KIND_COLLECTION = {
    "music": "georgeblood",
    "voice": "librivoxaudio",
    "foley": "nasa",
}
# Seconds to skip into each source so the trimmed snippet is real content, not boilerplate:
# LibriVox opens with a ~30s public-domain disclaimer; 78rpm has needle lead-in; NASA reels
# open with titles. The snippet needs duration >= start + a couple seconds of content.
KIND_START = {"music": 8.0, "voice": 45.0, "foley": 15.0}
# These collections are public domain; record the canonical license + a human source label.
KIND_SOURCE = {
    "music": "Archive.org / Great 78 Project",
    "voice": "Archive.org / LibriVox",
    "foley": "Archive.org / NASA Audio Collection",
}
MP3_FORMATS = {"VBR MP3", "MP3", "128Kbps MP3", "64Kbps MP3", "32Kbps MP3"}


def _parse_length(val) -> float:
    """Archive file `length` is seconds ('201.4') or 'M:SS'/'H:MM:SS'. Returns seconds (0.0 unknown)."""
    if val is None:
        return 0.0
    s = str(val).strip()
    if not s:
        return 0.0
    try:
        if ":" in s:
            parts = [float(p) for p in s.split(":")]
            sec = 0.0
            for p in parts:
                sec = sec * 60 + p
            return sec
        return float(s)
    except ValueError:
        return 0.0


def fetch_archive(kind: str, target: int) -> list[dict]:
    """Search a PD Archive.org collection, pick one mp3 per item, return raw audio candidates."""
    collection = KIND_COLLECTION[kind]
    headers = {"User-Agent": USER_AGENT}
    out: list[dict] = []
    try:
        r = requests.get(
            ARCHIVE_SEARCH,
            params={
                "q": f"collection:({collection}) AND mediatype:audio",
                "fl[]": ["identifier", "title", "creator"],
                "sort[]": "downloads desc",
                "rows": target * 3,
                "page": 1,
                "output": "json",
            },
            headers=headers,
            timeout=40,
        )
        r.raise_for_status()
        docs = r.json().get("response", {}).get("docs", [])
    except (requests.RequestException, ValueError) as exc:
        print(f"[build_corpus] archive search {kind} failed: {exc}")
        return out

    for doc in docs:
        if len(out) >= target * 2:
            break
        ident = doc.get("identifier")
        if not ident:
            continue
        try:
            m = requests.get(f"{ARCHIVE_META}/{ident}", headers=headers, timeout=40).json()
        except (requests.RequestException, ValueError):
            continue
        files = m.get("files", [])
        pick = None
        for f in files:
            if f.get("format") in MP3_FORMATS or str(f.get("name", "")).lower().endswith(".mp3"):
                pick = f
                break
        if not pick:
            continue
        name = pick["name"]
        title = doc.get("title") or ident
        creator = doc.get("creator")
        creator = creator[0] if isinstance(creator, list) and creator else creator
        words = [w.lower() for w in str(title).replace("-", " ").split()[:8]]
        out.append(
            {
                "id": f"aud-{kind}-{ident}",
                "kind": kind,
                "source_url": f"{ARCHIVE_DL}/{ident}/{requests.utils.quote(name)}",
                "source": KIND_SOURCE[kind],
                "license": "PD",
                "tags": [kind, *words][:10],
                "duration_sec": _parse_length(pick.get("length")),
                "loopable": kind == "foley",
                **({"attribution": str(creator)} if creator else {}),
                "attribution_url": f"https://archive.org/details/{ident}",
            }
        )
        time.sleep(0.4)  # be polite to the metadata API
    print(f"[build_corpus] archive {kind} ({collection}): {len(out)} raw candidates")
    return out


def transcode_remote(url: str, dst_dir: Path, kind: str, asset_id: str) -> Path | None:
    """ffmpeg stream-trims the remote URL directly (no full download) into a per-kind .m4a.

    Seeks KIND_START[kind] in (before -i, fast range seek) so the snippet skips intro boilerplate.
    """
    import subprocess

    from .transcode_audio import AUDIO_WINDOWS as _W, LOUDNORM

    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / f"{asset_id}.m4a"
    cmd = [
        "ffmpeg", "-y",
        "-ss", str(KIND_START[kind]),
        "-i", url,
        "-t", str(_W[kind][1]),
        "-af", LOUDNORM,
        "-vn", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
        str(dst),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=180)
        # a near-empty file means the seek ran past the end — treat as failure.
        return dst if dst.exists() and dst.stat().st_size > 8192 else None
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return None


def build_fetched_audio(cands: list[dict], work: Path, per_kind: dict[str, int]) -> list[dict]:
    """ffmpeg stream-trim each normalized candidate, capped per kind. Returns rows with _local."""
    der_dir = work / "audio_derivatives"
    kept: dict[str, int] = {k: 0 for k in AUDIO_WINDOWS}
    rows: list[dict] = []
    for c in cands:
        kind = c["kind"]
        if kept[kind] >= per_kind.get(kind, 0):
            continue
        # need enough runtime past the intro skip to yield real content
        if c.get("duration_sec", 0.0) < KIND_START[kind] + 2.0:
            continue
        der = transcode_remote(c["source_url"], der_dir, kind, c["id"])
        if not der:
            print(f"[build_corpus] transcode failed {c['id']}")
            continue
        row = dict(c)
        row["_local"] = str(der)
        rows.append(row)
        kept[kind] += 1
        print(f"[build_corpus] kept {c['id']} ({kept[kind]}/{per_kind.get(kind,0)} {kind})")
    print(f"[build_corpus] transcoded kept counts: {kept}")
    return rows


def augment_manifest(manifest: dict, embedder, audio_assets: list[dict]) -> dict:
    """Add audioEmbeddingDim + audio[] and a claptext bridge vector to every visual asset.

    Visual embeddings/srcs are left exactly as-is; only the additive Round 5 fields are written.
    """
    for a in manifest.get("assets", []):
        a["claptext"] = claptext_for(embedder, a.get("tags", []))
    manifest["audioEmbeddingDim"] = int(embedder.dim)
    manifest["audio"] = audio_assets
    manifest["version"] = datetime.now(timezone.utc).strftime("%Y.%m.%d-%H%M")
    manifest["createdAt"] = datetime.now(timezone.utc).isoformat()
    return manifest


def build(manifest_path: Path, out_dir: Path, per_kind: dict[str, int]) -> Path:
    embedder = _best_embedder()
    print(f"[build_corpus] CLAP embedder backend: {embedder.backend}, dim={embedder.dim}")
    audio_axes = build_axes(embedder)

    raw: list[dict] = []
    for kind, n in per_kind.items():
        if n > 0:
            raw.extend(fetch_archive(kind, n))
    cands = normalize_audio(raw)
    print(f"[build_corpus] {len(cands)}/{len(raw)} candidates passed the license/kind/duration gate")

    rows = build_fetched_audio(cands, out_dir, per_kind)
    (out_dir / "fetched_audio.jsonl").write_text(
        "".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8"
    )

    # build_audio_assets reads _local for the embedding; the candidate dicts already carry it.
    audio_assets = build_audio_assets(embedder, audio_axes, rows)
    print(f"[build_corpus] built {len(audio_assets)} audio assets")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest = augment_manifest(manifest, embedder, audio_assets)

    out_path = out_dir / f"manifest.{manifest['version']}.json"
    out_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    # also refresh the canonical out/manifest.json
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(
        f"[build_corpus] wrote {out_path}: version {manifest['version']}, "
        f"{len(manifest['assets'])} visual assets (+claptext), {len(audio_assets)} audio"
    )
    return out_path


def main() -> None:
    ap = argparse.ArgumentParser(description="DREAMREEL Round 5 audio corpus builder")
    ap.add_argument("--manifest", type=Path, default=Path("out/manifest.json"))
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--music", type=int, default=20)
    ap.add_argument("--voice", type=int, default=15)
    ap.add_argument("--foley", type=int, default=20)
    args = ap.parse_args()
    build(args.manifest, args.out, {"music": args.music, "voice": args.voice, "foley": args.foley})


if __name__ == "__main__":
    main()
