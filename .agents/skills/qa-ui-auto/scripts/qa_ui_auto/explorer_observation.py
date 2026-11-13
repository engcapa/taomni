"""Read-only Explorer fixture byte oracle, shared by browser/native dispatch."""
from __future__ import annotations

import configparser
import hashlib
import json
import os
from pathlib import Path
import platform
from typing import Any
from urllib.parse import unquote

from .deadline import budget_time as time
from .steps import StepError
from .workspace_drop_observation import READ_VFS, host_snapshot

STATES = {"seeded", "copied", "moved", "renamed", "trashed", "restored", "permanent", "external", "recursive", "drag-folder", "drag-breadcrumb", "drag-tree", "partial"}


def linux_trash(ctx: Any, original: str, expected_sha256: str) -> dict:
    """Inspect the real run-owned freedesktop trash, never a product IPC read."""
    root = Path(os.environ.get("XDG_DATA_HOME", "")).resolve()
    if not root.is_relative_to(ctx.case_dir.parent.resolve()) or root == Path.cwd().resolve():
        raise StepError("assert_explorer_files: refusing trash outside the isolated run")
    info = root / "Trash" / "info"
    for entry in info.glob("*.trashinfo"):
        parser = configparser.ConfigParser(interpolation=None)
        parser.read(entry, encoding="utf-8")
        if unquote(parser.get("Trash Info", "Path", fallback="")) != original:
            continue
        file = root / "Trash" / "files" / entry.name.removesuffix(".trashinfo")
        if not file.is_file() or file.is_symlink():
            raise StepError("assert_explorer_files: real trashed file is missing")
        digest = hashlib.sha256(file.read_bytes()).hexdigest()
        if digest != expected_sha256:
            raise StepError("assert_explorer_files: real trash bytes differ from the original")
        return {"trashInfo": str(entry), "trashFile": str(file), "sha256": digest, "originalPath": original}
    raise StepError("assert_explorer_files: no freedesktop trash metadata for the removed original")


def run(ctx: Any, args: Any, *, mode: str) -> str:
    state = args.get("state") if isinstance(args, dict) and set(args) == {"state"} else None
    if state not in STATES:
        raise StepError("assert_explorer_files: expected one registered state")
    if getattr(ctx, "dry_run", False):
        return "dry-run only; no Explorer filesystem observation"
    record: dict[str, Any] = {"state": state, "mode": mode, "passed": False, "samples": []}
    try:
        manifest = json.loads((ctx.case_dir / "explorer-files-fixture.json").read_text(encoding="utf-8"))
        if manifest.get("schema") != "qa.explorer-files.v1" or manifest.get("mode") != mode:
            raise StepError("assert_explorer_files: fixture schema or mode differs")
        base = manifest["base"]
        expected = manifest["states"][state]
        if mode == "native":
            path = Path(base).resolve()
            if not path.is_relative_to(ctx.case_dir.parent.resolve()) or path.name != "operations" or not path.parent.name.startswith("workspace-drop-import-explorer-"):
                raise StepError("assert_explorer_files: native files outside retained fixture")
            observe = lambda: host_snapshot(path)
        else:
            if not base.startswith("/preview/workspace-drop-import-explorer-") or not base.endswith("/operations"):
                raise StepError("assert_explorer_files: browser files outside VFS fixture")
            observe = lambda: ctx.page.evaluate(READ_VFS, base)
        started = time.monotonic()
        while True:
            observed = observe()
            elapsed = time.monotonic() - started
            record["samples"].append({"elapsedMs": elapsed * 1000, "observed": observed})
            if observed != expected:
                raise StepError(f"assert_explorer_files: {state} complete source/target SHA256 or empty-directory set differs")
            if elapsed >= 0.5:
                break
            time.sleep(min(0.1, 0.5 - elapsed))
        if state == "trashed" and mode == "native" and platform.system() == "Linux":
            original = str(Path(base) / "trash/delete-me.txt")
            record["realTrash"] = linux_trash(ctx, original, manifest["states"]["seeded"]["files"]["trash/delete-me.txt"])
        record["passed"] = True
        return f"{mode} Explorer {state}: independent full-tree SHA256 and empty directories, 500ms quiet interval"
    except Exception as error:
        record["error"] = str(error)
        raise
    finally:
        with (ctx.case_dir / "explorer-files-observations.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def native(ctx: Any, args: Any) -> str:
    return run(ctx, args, mode="native")
