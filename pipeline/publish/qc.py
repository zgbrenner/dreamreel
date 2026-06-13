"""Quality control: drop corrupt / duplicate / near-black / tiny assets, re-confirm the
license policy, and emit a QC report of counts kept/dropped by reason."""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from ingest.licenses import evaluate

MIN_SIDE = 200
NEAR_BLACK_MEAN = 12  # 0..255


@dataclass
class QCReport:
    kept: int = 0
    dropped: Counter = field(default_factory=Counter)

    def to_dict(self) -> dict:
        return {"kept": self.kept, "dropped": dict(self.dropped)}


def _phash(path: Path):
    try:
        import imagehash
        from PIL import Image

        with Image.open(path) as im:
            return str(imagehash.phash(im))
    except Exception:  # noqa: BLE001
        return None


def _is_bad_image(path: Path) -> str | None:
    """Return a drop-reason string, or None if the image passes."""
    try:
        from PIL import Image, ImageStat
    except ImportError:
        return None
    try:
        with Image.open(path) as im:
            im.verify()
        with Image.open(path) as im:
            im = im.convert("L")
            if min(im.size) < MIN_SIDE:
                return "too-small"
            if ImageStat.Stat(im).mean[0] < NEAR_BLACK_MEAN:
                return "near-black"
        return None
    except Exception:  # noqa: BLE001
        return "corrupt"


def run_qc(assets: list[dict], image_root: Path | None = None) -> tuple[list[dict], QCReport]:
    """Filter a list of manifest asset dicts; image_root locates local files for pixel checks."""
    report = QCReport()
    seen_hashes: set[str] = set()
    kept: list[dict] = []

    for a in assets:
        # license re-confirmation (independent backstop)
        decision = evaluate(a.get("license"), attribution=a.get("attribution"))
        if not decision.keep:
            report.dropped[f"license:{decision.reason or 'disallowed'}"] += 1
            continue

        # pixel-level QC only for local images
        local = None
        if image_root and a.get("type") == "image":
            cand = image_root / Path(a.get("_local", "")).name if a.get("_local") else None
            local = cand if cand and cand.exists() else None
        if local:
            bad = _is_bad_image(local)
            if bad:
                report.dropped[bad] += 1
                continue
            h = _phash(local)
            if h is not None:
                if h in seen_hashes:
                    report.dropped["duplicate"] += 1
                    continue
                seen_hashes.add(h)

        kept.append(a)
        report.kept += 1

    return kept, report


def write_report(report: QCReport, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report.to_dict(), indent=2) + "\n", encoding="utf-8")
