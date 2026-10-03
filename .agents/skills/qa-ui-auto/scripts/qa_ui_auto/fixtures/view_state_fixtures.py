"""Long-file fixture for ED-IMPROVE-007 per-leaf view restore.

Provisions a disposable host directory with a 60-line ``Long.java`` carrying
multiple brace blocks (foldable regions) plus a second file. The consuming
native case seeds the layout snapshot with two leaves showing ``Long.java``
with different caret/scroll/fold view states, so a ``reload_window`` run can
prove each leaf restores its own caret, scroll and folds.

The file text below is the exact literal the case references; keep both in
sync (offsets are computed offline from this text).
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any

from .restore_24tab_fixtures import _hash_string, _normalize_workspace_path


def long_file_text() -> str:
    lines = [
        "package com.example.single;",
        "",
        "public class LongFile {",
    ]
    for index in range(10):
        lines.append(f"    void method{index}() {{")
        lines.append(f"        int value{index} = {index};")
        lines.append(f"        System.out.println(value{index});")
        lines.append("    }")
        lines.append("")
    lines.append("}")
    return "\n".join(lines) + "\n"


VIEW_STATE_INSTANCE_ID = "workspace-viewstate"


def _view_instance_id(root_path: str) -> str:
    identity = json.dumps(
        {
            "roots": [{"path": _normalize_workspace_path(root_path), "kind": "folder"}],
            "looseFiles": [],
        },
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return f"workspace-{_hash_string(identity)}"


def setup(ctx: Any) -> None:
    report_root = Path(getattr(ctx, "report_root", Path("qa-ui-auto-report"))).resolve()
    base = report_root / "native-workspaces"
    base.mkdir(parents=True, exist_ok=True)
    case_id = str(getattr(ctx, "case_id", "case"))
    worker = int(getattr(ctx, "worker_id", 0))
    root = Path(tempfile.mkdtemp(prefix=f"{case_id}-w{worker}-", dir=str(base)))
    (root / "Long.java").write_bytes(long_file_text().encode("utf-8"))
    (root / "Other.java").write_bytes(b"package com.example.single;\n\npublic class Other {\n}\n")
    values: dict[str, str] = getattr(ctx, "values")
    values["view_state_root"] = root.as_posix()
    values["view_state_instance_id"] = _view_instance_id(root.as_posix())
    text = long_file_text()
    lines = text.split("\n")
    # Offsets for the case's seeded viewStates: primary caret near line 41,
    # fold over the method4 block, secondary caret near line 6.
    line_starts = [0]
    for line in lines[:-1]:
        line_starts.append(line_starts[-1] + len(line) + 1)
    values["view_state_primary_head"] = str(line_starts[40])
    values["view_state_fold_from"] = str(line_starts[30])
    values["view_state_fold_to"] = str(line_starts[35])
    values["view_state_secondary_head"] = str(line_starts[5])
