"""A dependency-free Node project for real Run discovery from ordinary docs."""
import json
from pathlib import Path
from typing import Any

from . import platform_workspace_root


def setup(ctx: Any) -> None:
    if (ctx.cfg.get("app") or {}).get("mode") != "native":
        raise RuntimeError("workspace_execution_documents requires real native process execution")
    platform_workspace_root.setup(ctx)
    root = Path(ctx.values["platform_workspace_root"])
    (root / "package.json").write_text(json.dumps({
        "name": "qa-public-execution", "private": True,
        "scripts": {"start": "node run.cjs"},
    }) + "\n", encoding="utf-8")
    (root / "run.cjs").write_text('console.log("QA_EXECUTION_DOCUMENT_OK");\n', encoding="utf-8")
    (root / "notes.txt").write_text("Public project notes\n", encoding="utf-8")
