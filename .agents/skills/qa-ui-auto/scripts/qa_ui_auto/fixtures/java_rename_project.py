"""Isolated, compilable two-file rename input; no action/provider result is seeded."""

import hashlib
from pathlib import Path
import re
from typing import Any

from . import java_sample_projects


def setup(ctx: Any) -> None:
    java_sample_projects.setup(ctx)
    root = Path(ctx.values["maven_single_root"])
    paths = {
        "app": root / "src/main/java/com/example/single/App.java",
        "test": root / "src/test/java/com/example/single/AppTest.java",
    }
    for name, path in paths.items():
        text = path.read_text(encoding="utf-8")
        for marker in ("Stri", "Arrays.", "new StringBuilder().appen", "StringUti", "Asser"):
            text = re.sub(r"(?m)^(\s*)" + re.escape(marker) + r"\s*$", r"\1// completion probe", text)
        if name == "test":
            text = text.replace("Assert.assertTrue", "new App().signatureTargets();\n        Assert.assertTrue")
        before = text.encode("utf-8")
        after = text.replace("signatureTargets", "executeWorkflow").encode("utf-8")
        path.write_bytes(before)
        ctx.values[f"rename_{name}_file"] = path.as_posix()
        ctx.values[f"rename_{name}_pre_hash"] = hashlib.sha256(before).hexdigest()
        ctx.values[f"rename_{name}_post_hash"] = hashlib.sha256(after).hexdigest()
        if name == "app":
            lines = text.splitlines()
            line = next(i for i, value in enumerate(lines) if "void signatureTargets()" in value)
            ctx.values["rename_caret"] = f"{line + 1}:{lines[line].index('signatureTargets') + 3}"
            ctx.values["rename_cursor_status"] = f"Ln {line + 1}, Col {lines[line].index('signatureTargets') + 4}"
    # This completion fixture is deliberately invalid and outside the rename scenario.
    (root / "src/main/java/com/example/single/QuickFixTarget.java").unlink()
