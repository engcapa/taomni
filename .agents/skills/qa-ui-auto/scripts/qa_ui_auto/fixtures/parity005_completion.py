"""ED-PARITY-005 completion fixture metadata (browser + native).

Exposes the deterministic B-005 / M0 reference texts from
`docs-feature/code-workspace-idea-parity/references/ed-parity-005-reference.md#fixture`
so cases can type exact prefixes and assert exact post-images without
hard-coding bytes in YAML.

Browser cases drive the real UI (live templates / buffer completions) and use
these values as typed text and assertions; they never claim JDT LS semantics.
Native case TC-IDE-PARITY-005-05 uses the same values plus a real JDT LS
session for provider assertions.

This fixture provisions no host files and never skips: it only publishes
reference values and a manifest for evidence identity.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

B1_TEXT = (
    "package parity005;\n"
    "\n"
    "public class Main {\n"
    "    void sample() {\n"
    "        Stri;\n"
    "    }\n"
    "}\n"
)

B2_TEXT = (
    "package parity005;\n"
    "import java.lang.StringBuilder;\n"
    "\n"
    "public class Main {\n"
    "    void sample() {\n"
    '        StringBuilder("x", 1);\n'
    "    }\n"
    "}\n"
)

M0_BODY = "        StringUtiSuffix;"
M0_CARET_LINE = 4
M0_CARET_CHAR = 17


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def setup(ctx: Any) -> None:
    values: dict[str, str] = getattr(ctx, "values")
    values["parity005_b1"] = B1_TEXT
    values["parity005_b2"] = B2_TEXT
    values["parity005_b1_sha256"] = _sha256(B1_TEXT)
    values["parity005_b2_sha256"] = _sha256(B2_TEXT)
    values["parity005_m0_body"] = M0_BODY
    report_root = Path(getattr(ctx, "report_root", Path("qa-ui-auto-report"))).resolve()
    manifest_dir = report_root / "_fixtures" / "parity005_completion"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    case_id = str(getattr(ctx, "case_id", "case"))
    manifest = {
        "case": case_id,
        "b1_sha256": _sha256(B1_TEXT),
        "b2_sha256": _sha256(B2_TEXT),
        "m0_body": M0_BODY,
        "m0_caret": [M0_CARET_LINE, M0_CARET_CHAR],
        "note": "reference texts only; browser asserts UI behavior, native asserts provider semantics",
    }
    (manifest_dir / f"{case_id}.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def teardown(ctx: Any) -> None:
    return None
