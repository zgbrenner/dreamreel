"""Python dependency license gate (the pipeline half of the policy).

Scans installed distributions and FAILS if any carries a copyleft / source-available license
(GPL/AGPL/LGPL/SSPL/BUSL). Intended to run in a CI venv that contains only the pipeline's
declared dependencies, so the scan is scoped to what we actually ship/use.
"""

from __future__ import annotations

import sys
from importlib import metadata

FORBIDDEN = (
    "agpl",
    "affero",
    "gpl",  # catches GPL and LGPL
    "sspl",
    "server side public license",
    "business source",
    "busl",
    "commons clause",
)

# Permissive licenses we expect; used only to print a friendly summary.
KNOWN_OK = ("mit", "bsd", "apache", "isc", "zlib", "psf", "hpnd", "python software foundation", "mpl")


def _license_text(dist: metadata.Distribution) -> str:
    meta = dist.metadata
    fields = [meta.get("License", "")]
    fields += meta.get_all("Classifier", []) or []
    return " ".join(f for f in fields if f).lower()


def main() -> int:
    offenders: list[str] = []
    count = 0
    for dist in metadata.distributions():
        count += 1
        name = dist.metadata.get("Name", "?")
        text = _license_text(dist)
        # 'gpl' must not match within 'mgplv'/etc; require word-ish boundary via spaces/hyphens
        if any(tok in text for tok in FORBIDDEN):
            # avoid false positive on 'gpl' appearing inside unrelated words
            if "gpl" in text and not any(
                k in text for k in ("gplv", "gpl-", "gpl ", "(gpl", "lgpl", "agpl", "general public")
            ):
                continue
            offenders.append(f"{name}: {text[:80]}")

    if offenders:
        print("✖ Forbidden (copyleft/source-available) Python licenses:")
        for o in offenders:
            print("  - " + o)
        print(f"\nPython license check FAILED: {len(offenders)} offender(s).")
        return 1
    print(f"✓ Python license check passed: scanned {count} distributions, none forbidden.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
