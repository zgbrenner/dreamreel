"""Run all ingesters, apply the license gate, and write candidates + a rejections report.

Usage:
    python -m ingest.run --out out/ [--no-archive] [--no-loc] [--no-wellcome] [--no-museums]
"""

from __future__ import annotations

import argparse
from pathlib import Path

from . import archive_org, commons, loc, museums, openverse, wellcome
from .normalize import Candidate, Rejection, write_candidates, write_rejections


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="DREAMREEL ingest")
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--no-openverse", action="store_true")
    ap.add_argument("--no-archive", action="store_true")
    ap.add_argument("--no-loc", action="store_true", help="skip LoC National Screening Room film")
    ap.add_argument("--no-commons", action="store_true", help="skip Wikimedia Commons PD/CC video")
    ap.add_argument("--no-wellcome", action="store_true")
    ap.add_argument("--no-museums", action="store_true", help="skip Met/Smithsonian CC0")
    # Video-first direction (CLAUDE.md): film volume knob for the LoC National Screening Room.
    ap.add_argument("--loc", type=int, default=40, help="max LoC National Screening Room items")
    # Video-first direction (CLAUDE.md): Wikimedia Commons PD/CC film + animation volume knob.
    ap.add_argument("--commons", type=int, default=40, help="max Wikimedia Commons video items")
    # Video-first direction (CLAUDE.md): images are now flash-frame/ghost-only, never primary, so
    # the default Openverse image volume is cut (was 60) in favour of archive_org's film volume.
    ap.add_argument("--per-theme", type=int, default=20)
    return ap


def main() -> None:
    args = build_parser().parse_args()

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
    if not args.no_wellcome:
        print("ingesting Wellcome Collection images…")
        drain(wellcome.ingest())
    if not args.no_archive:
        print("ingesting Archive.org film…")
        drain(archive_org.ingest())
    if not args.no_loc and args.loc > 0:
        print("ingesting Library of Congress National Screening Room film…")
        drain(loc.ingest(count=args.loc))
    if not args.no_commons and args.commons > 0:
        print("ingesting Wikimedia Commons PD/CC video…")
        drain(commons.ingest(limit=args.commons))
    if not args.no_museums:
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
