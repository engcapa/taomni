"""Java rename-deleted recovery fixture for TC-IDE-JAVA-RENAME-DELETED-RECOVERY-WIN.

Builds a fresh plain-folder workspace staging the two seeded journal shapes
the Windows-native case consumes (no provider involved):

* ``MixNew.java`` present with the POST bytes, ``MixOld.java`` absent — the
  production mixed text+rename shape (``contentHash`` = pre-image hash) that
  must classify restorable and reverse home with byte-preservation proof.
* ``Gone.java`` / ``GoneRenamed.java`` absent at both ends — the
  deleted-after-rename shape that must stay pending as
  document-unreadable / move ``both-missing`` until explicitly abandoned.

A host-side fixture (not host_write_file) is required because the runner has
no file-delete verb, and absence must already hold when the seeded v2
recovery journals are consumed after reload_window.

The byte literals below are the exact texts the consuming case references —
keep them in sync.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

MIX_NEW_NAME = "MixNew.java"

MIX_PRE_TEXT = "public class MixOld {}\n"

MIX_POST_TEXT = "public class MixNew {}\n"

GONE_PRE_TEXT = "class Gone { int a = 1; }\n"

GONE_POST_TEXT = "class GoneRenamed { int a = 1; }\n"


def setup(ctx: Any) -> None:
    destination = Path(ctx.case_dir) / "fixture-workspaces" / "jrdr_root"
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    # Only the mixed-shape new path exists (with the POST bytes); every old
    # path and both gone ends are absent by construction.
    (destination / MIX_NEW_NAME).write_text(MIX_POST_TEXT, encoding="utf-8", newline="")
    values: dict[str, str] = getattr(ctx, "values")
    values["jrdr_root"] = destination.resolve().as_posix()
