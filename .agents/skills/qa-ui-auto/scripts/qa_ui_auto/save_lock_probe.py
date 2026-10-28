"""Real Windows reader lock, user save shortcut and responsive navigation proof."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import platform
import time
from typing import Any

from .host_file_observation import assert_file_sha256
from .steps import StepError


def _pending_file(path: Path, timeout: float = 5) -> Path:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        pending = list(path.parent.glob(".taomni-write-*"))
        if len(pending) == 1:
            return pending[0]
        if len(pending) > 1:
            raise StepError("save lock probe: ambiguous pending writes")
        time.sleep(0.01)
    raise StepError("save lock probe: the user save never reached atomic publication")


def run(ctx: Any, args: Any) -> str:
    if platform.system() != "Windows":
        raise StepError("native_save_reader_lock requires real Windows sharing semantics")
    if not isinstance(args, dict) or set(args) != {"path", "selector", "equals", "max_ui_ms"}:
        raise StepError("native_save_reader_lock: expected {path, selector, equals, max_ui_ms}")
    path = Path(args["path"]).resolve(strict=True)
    report_root = ctx.case_dir.parents[2].resolve()
    if not path.is_relative_to(report_root) or not path.is_file():
        raise StepError("native_save_reader_lock: file must be inside the retained report root")
    limit = float(args["max_ui_ms"])
    if not 0 < limit < 2000:
        raise StepError("native_save_reader_lock: UI budget must distinguish the 2s lock timeout")
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    record: dict[str, Any] = {"path": str(path), "beforeSha256": before, "maxUiMs": limit}
    reader = None
    try:
        ctx.session.focus(str(args["selector"]))
        # Python's ordinary Windows reader deliberately omits DELETE sharing.
        # It is scoped to this verb, including every error path; no timer or
        # detached lock owner can release it early and manufacture a pass.
        with path.open("rb") as reader:
            start = time.monotonic()
            ctx.session.press_combo("Control+s")
            record["shortcutMs"] = (time.monotonic() - start) * 1000
            if record["shortcutMs"] >= limit:
                raise StepError(f"save shortcut blocked for {record['shortcutMs']:.1f}ms")
            pending = _pending_file(path)
            # Let fsync complete, while retaining the lock throughout. A real
            # Windows rename cannot consume this file before the reader closes.
            time.sleep(0.1)
            start = time.monotonic()
            ctx.session.click('[data-testid="nav-mode-home"]')
            home = ctx.session.execute("return document.querySelector('[data-testid=\"welcome-panel\"]')?.getBoundingClientRect().width > 0")
            ctx.session.click('[data-testid="nav-mode-workspaces"]')
            editor = ctx.session.execute("return document.querySelector('[data-testid=\"workspace-file-editor\"]')?.getBoundingClientRect().width > 0")
            record["navigationMs"] = (time.monotonic() - start) * 1000
            record["homeVisible"], record["editorVisible"] = home, editor
            record["pendingWhileLocked"] = pending.exists()
            record["lockedSha256"] = hashlib.sha256(reader.read()).hexdigest()
            if record["navigationMs"] >= limit or not home or not editor:
                raise StepError(f"UI did not remain responsive during native save: {record}")
            if not record["pendingWhileLocked"] or record["lockedSha256"] != before:
                raise StepError("atomic save did not retain the complete old file and pending write")
        record["readerReleased"] = reader.closed
        result = assert_file_sha256(ctx, {"path": str(path), "equals": args["equals"], "timeout_sec": 10})
        if list(path.parent.glob(".taomni-write-*")):
            raise StepError("save lock probe: temporary write was not consumed after release")
        record["savedSha256"], record["passed"] = args["equals"], True
        return result + "; navigation remained responsive while atomic replacement was blocked"
    except BaseException as error:
        record["error"] = str(error)
        raise
    finally:
        if reader is not None:
            record["readerReleased"] = reader.closed
        (ctx.case_dir / "native-save-reader-lock.json").write_text(
            json.dumps(record, indent=2) + "\n", encoding="utf-8"
        )
