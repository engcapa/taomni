"""File-move recovery fixture for ED-FOLLOW-001.

Builds a fresh plain-folder workspace and performs the simulated server-side
file move HOST-SIDE before the app opens it: ``Old.java`` (pre bytes, sha256
a749a308...) is renamed to ``New.java`` and given the post bytes (sha256
009a8da9...). A host-side fixture (not host_write_file) is required because
the runner has no file-delete verb, and the move's pre-state (old missing,
new present) must already hold when the seeded v2 recovery journal is
consumed after reload_window.

The byte literals below are the exact texts the consuming case references —
keep them in sync.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

OLD_NAME = "Old.java"
NEW_NAME = "New.java"

PRE_TEXT = (
    "public class Old {\n"
    "    int value = 1;\n"
    "}\n"
)

POST_TEXT = (
    "public class New {\n"
    "    int value = 1;\n"
    "}\n"
)


def setup(ctx: Any) -> None:
    destination = Path(ctx.case_dir) / "fixture-workspaces" / "file_move_root"
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    (destination / OLD_NAME).write_text(PRE_TEXT, encoding="utf-8", newline="")
    # Simulate the completed server-side move: old gone, new present with
    # the post bytes. The seeded journal entry then classifies restorable.
    (destination / OLD_NAME).rename(destination / NEW_NAME)
    (destination / NEW_NAME).write_text(POST_TEXT, encoding="utf-8", newline="")
    values: dict[str, str] = getattr(ctx, "values")
    values["file_move_root"] = destination.resolve().as_posix()
