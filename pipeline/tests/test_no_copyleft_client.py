"""Guard: archive.org (and every other) ingester must use plain HTTP, never the AGPL
`internetarchive` client. This codifies the 'no copyleft client — grep confirms' acceptance
durably in CI instead of relying on a one-off manual grep.
"""

from __future__ import annotations

import ast
from pathlib import Path

INGEST_DIR = Path(__file__).resolve().parent.parent / "ingest"

FORBIDDEN = {"internetarchive"}


def _imported_modules(src: str) -> set[str]:
    """Top-level package names referenced by import / from-import statements."""
    mods: set[str] = set()
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                mods.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module and node.level == 0:
                mods.add(node.module.split(".")[0])
    return mods


def test_no_copyleft_client_imported_anywhere_in_ingest():
    offenders: dict[str, set[str]] = {}
    for py in INGEST_DIR.glob("*.py"):
        bad = _imported_modules(py.read_text(encoding="utf-8")) & FORBIDDEN
        if bad:
            offenders[py.name] = bad
    assert not offenders, f"copyleft client imported (AGPL — not shippable): {offenders}"
