"""Create deterministic native editor-performance fixtures."""

from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path
from typing import Any


TARGET_BYTES = {
    "small": 16 * 1024,
    "one_mib": 1 * 1024 * 1024,
    "five_mib": 5 * 1024 * 1024,
}
FILE_NAMES = {
    "small": "small.java",
    "one_mib": "one-mib.java",
    "five_mib": "five-mib.java",
}
HEADER = (
    "package perf;\n\n"
    "public final class EditorPerformanceFixture {\n"
    "    public static void run() {\n"
)
FOOTER = "    }\n}\n"
LINE_TEMPLATE = "        // Java-like fixture line {index:08d}: stable editor workload\n"


def java_like_bytes(target_bytes: int) -> bytes:
    """Return an ASCII Java-like document with an exact byte length."""
    if target_bytes <= len((HEADER + FOOTER).encode("ascii")):
        raise ValueError("target fixture is too small for the Java-like wrapper")
    chunks = [HEADER]
    current = len(HEADER.encode("ascii"))
    index = 0
    footer_bytes = len(FOOTER.encode("ascii"))
    while current + footer_bytes + len(LINE_TEMPLATE.format(index=index).encode("ascii")) <= target_bytes:
        line = LINE_TEMPLATE.format(index=index)
        chunks.append(line)
        current += len(line.encode("ascii"))
        index += 1

    remaining = target_bytes - current - footer_bytes
    if remaining:
        # Whitespace keeps the wrapper valid even when the exact target falls
        # between two repeated fixture lines.
        chunks.append(" " * remaining)
    chunks.append(FOOTER)
    result = "".join(chunks).encode("ascii")
    if len(result) != target_bytes:
        raise AssertionError(f"fixture length {len(result)} != requested {target_bytes}")
    return result


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    cfg = getattr(ctx, "cfg", {}) or {}
    if (cfg.get("app") or {}).get("mode", "browser") != "native":
        raise FixtureSkip("editor_performance requires the native host filesystem")

    report_root = Path(getattr(ctx, "report_root", Path("qa-ui-auto-report"))).resolve()
    base = report_root / "native-workspaces"
    base.mkdir(parents=True, exist_ok=True)
    case_id = str(getattr(ctx, "case_id", "case"))
    worker = int(getattr(ctx, "worker_id", 0))
    root = Path(tempfile.mkdtemp(prefix=f"{case_id}-w{worker}-editor-perf-", dir=str(base)))

    files: dict[str, dict[str, Any]] = {}
    for key, target_bytes in TARGET_BYTES.items():
        payload = java_like_bytes(target_bytes)
        path = root / FILE_NAMES[key]
        path.write_bytes(payload)
        files[key] = {
            "path": path.as_posix(),
            "byteLength": len(payload),
            "sha256": _sha256(payload),
        }

    case_dir = Path(getattr(ctx, "case_dir", report_root))
    (case_dir / "editor-performance-fixture.json").write_text(
        json.dumps({
            "schemaVersion": 1,
            "fixtureId": "ED-AUDIT-005-editor-input",
            "root": root.as_posix(),
            "files": files,
        }, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    values: dict[str, str] = getattr(ctx, "values")
    values.update({
        "editor_performance_root": root.as_posix(),
        "editor_performance_small": files["small"]["path"],
        "editor_performance_one_mib": files["one_mib"]["path"],
        "editor_performance_five_mib": files["five_mib"]["path"],
        "editor_performance_small_bytes": str(TARGET_BYTES["small"]),
        "editor_performance_one_mib_bytes": str(TARGET_BYTES["one_mib"]),
        "editor_performance_five_mib_bytes": str(TARGET_BYTES["five_mib"]),
    })
