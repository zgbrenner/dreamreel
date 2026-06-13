"""License policy — the single backstop the whole pipeline enforces.

This is a commercial product: only assets we may ship in the bundle are kept. Everything
else is rejected with a logged reason. This mirrors the hard constraints in CLAUDE.md and
is one of three independent backstops (the others: the CI dependency-license scan and the
on-screen CC-BY attribution rendering).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class LicenseClass(str, Enum):
    CC0 = "CC0"
    PUBLIC_DOMAIN = "PD"
    CC_BY = "CC-BY"


# Allowed media licenses. CC-BY is allowed ONLY when attribution is captured (enforced below).
_ALLOWED_PREFIXES = ("cc0", "publicdomain", "public domain", "pdm", "cc-pdm")
_CC_BY_PREFIXES = ("cc-by", "by")  # plain attribution license
_REJECT_TOKENS = ("nc", "nd", "sa")  # NonCommercial / NoDerivatives / ShareAlike-incompatible


@dataclass(frozen=True)
class LicenseDecision:
    keep: bool
    normalized: str  # e.g. "CC0", "PD", "CC-BY-4.0"
    reason: str = ""
    requires_attribution: bool = False


def normalize_license(raw: str | None, version: str | None = None) -> str:
    """Normalize a source's license string to our canonical token."""
    s = (raw or "").strip().lower()
    if not s:
        return "UNKNOWN"
    if any(s.startswith(p) or p in s for p in _ALLOWED_PREFIXES):
        if "cc0" in s:
            return "CC0"
        return "PD"
    if s.startswith("cc-by") or s == "by" or s.startswith("by-"):
        # Reject any NC / ND / SA variant.
        tail = s.replace("cc-by", "").replace("by", "", 1)
        if any(tok in tail for tok in _REJECT_TOKENS):
            return f"CC-BY-{tail}".upper()  # carry the bad variant for the reason log
        v = (version or "").strip()
        return f"CC-BY-{v}" if v else "CC-BY"
    return raw.strip() if raw else "UNKNOWN"


def evaluate(
    raw_license: str | None,
    version: str | None = None,
    attribution: str | None = None,
) -> LicenseDecision:
    """Decide whether an asset may be shipped, and how to normalize its license."""
    norm = normalize_license(raw_license, version)
    low = norm.lower()

    # CC0 / public domain — always keep, no attribution required.
    if norm in ("CC0", "PD"):
        return LicenseDecision(keep=True, normalized=norm, requires_attribution=False)

    # CC-BY (plain) — keep ONLY if attribution present.
    if low.startswith("cc-by") and not any(tok in low.split("cc-by", 1)[-1] for tok in _REJECT_TOKENS):
        if attribution and attribution.strip():
            return LicenseDecision(keep=True, normalized=norm, requires_attribution=True)
        return LicenseDecision(
            keep=False,
            normalized=norm,
            reason="CC-BY without attribution (attribution is mandatory)",
        )

    # Explicit NC / ND / SA-incompatible.
    if any(tok in low for tok in _REJECT_TOKENS):
        return LicenseDecision(keep=False, normalized=norm, reason=f"non-commercial/restricted: {norm}")

    return LicenseDecision(keep=False, normalized=norm, reason=f"unknown or disallowed license: {norm}")
