"""Run all ingesters, apply the license gate, and write candidates + a rejections report.

Usage:
    python -m ingest.run --out out/ [--no-archive] [--museums]
"""

from __future__ import annotations

import argparse
from pathlib import Path

from . import archive_org, museums, openverse
from .normalize import Candidate, Rejection, write_candidates, write_rejections


def main() -> None:
    ap = argparse.ArgumentParser(description="DREAMREEL ingest")
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--no-openverse", action="store_true")
    ap.add_argument("--no-archive", action="store_true")
    ap.add_argument("--museums", action="store_true", help="include Met/Smithsonian CC0")
    ap.add_argument("--per-theme", type=int, default=60)
    args = ap.parse_args()

    kept: list[Candidate] = []
    rejected: list[Rejection] = []

    def drain(pairs):
        for cand, rej in pairs:
            if cand is not None:
                kept.append(cand)
            elif rej is not None:
                rejected.append(rej)

    if not args.no_openverse:
        print("ingesting Openverse images…")
        drain(openverse.ingest(per_theme=args.per_theme, media="images"))
        print("ingesting Openverse audio…")
        drain(openverse.ingest(per_theme=max(10, args.per_theme // 3), media="audio"))
    if not args.no_archive:
        print("ingesting Archive.org film…")
        drain(archive_org.ingest())
    if args.museums:
        print("ingesting Met + Smithsonian CC0…")
        drain(museums.ingest_met())
        drain(museums.ingest_smithsonian())

    n_kept = write_candidates(kept, args.out / "candidates.jsonl")
    n_rej = write_rejections(rejected, args.out / "rejections.jsonl")
    print(f"kept {n_kept} candidates, rejected {n_rej} (see {args.out}/rejections.jsonl)")
    # surface the top rejection reasons
    reasons: dict[str, int] = {}
    for r in rejected:
        reasons[r.reason] = reasons.get(r.reason, 0) + 1
    for reason, count in sorted(reasons.items(), key=lambda kv: -kv[1])[:10]:
        print(f"  {count:5d}  {reason}")


if __name__ == "__main__":
    main()
