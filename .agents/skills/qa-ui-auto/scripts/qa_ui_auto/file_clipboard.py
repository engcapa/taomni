"""Scoped fixture file lists and independent native-format observations."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .deadline import budget_time as time
from .steps import StepError


def append(ctx, name: str, record: dict) -> None:
    ctx.case_dir.mkdir(parents=True, exist_ok=True)
    with (ctx.case_dir / name).open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def validate(args: Any) -> tuple[str, list[str]]:
    if (not isinstance(args, dict) or set(args) != {"action", "paths"}
            or args["action"] not in {"seed", "assert"}
            or not isinstance(args["paths"], list)
            or any(not isinstance(path, str) or not path for path in args["paths"])):
        raise StepError("file_clipboard: expected {action: seed|assert, paths: string[]}")
    return args["action"], args["paths"]


def scoped(ctx, paths: list[str], mode: str) -> list[str]:
    result = []
    for raw in paths:
        if mode == "browser":
            if not raw.startswith("/preview/workspace-drop-import-") or "/../" in raw:
                raise StepError("file_clipboard: browser paths must belong to the fixture VFS")
            result.append(raw)
        else:
            path = Path(raw)
            if not path.is_absolute() or not path.resolve().is_relative_to(ctx.case_dir.parent.resolve()):
                raise StepError("file_clipboard: paths must stay within the current retained run")
            if not path.exists() or path.is_symlink():
                raise StepError("file_clipboard: expected an existing nonsymlink fixture path")
            result.append(str(path.resolve()))
    return result


def digests(paths: list[str]) -> dict:
    from .workspace_drop_observation import host_snapshot
    result = {}
    for raw in paths:
        path = Path(raw)
        result[raw] = host_snapshot(path) if path.is_dir() else {"sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    return result


def run(ctx, args: Any, *, mode: str) -> str:
    action, paths = validate(args)
    if getattr(ctx, "dry_run", False):
        return "file clipboard dry-run; no OS access"
    paths = scoped(ctx, paths, mode)
    record = {"mode": mode, "action": action, "expectedPaths": paths,
              "independentNativeOracle": mode == "native", "passed": False}
    try:
        if mode == "browser":
            result = ctx.page.evaluate("""async ({action, paths}) => {
              const clipboard = await import('/src/stubs/fileClipboard.ts');
              if (action === 'seed') clipboard.writeFiles(paths);
              return {paths: clipboard.readFiles(), nativeFormat: false};
            }""", {"action": action, "paths": paths})
        else:
            from . import file_clipboard_native as native
            if action == "seed":
                native.seed(ctx, paths)
            deadline = time.monotonic() + 5
            record["samples"] = []
            while True:
                result = native.read(require_files=bool(paths))
                record["samples"].append(result)
                record["observation"] = result
                if result.get("paths") == paths or time.monotonic() >= deadline:
                    break
                time.sleep(.1)
            record["fileHashes"] = digests(paths)
        record["observation"] = result
        if not isinstance(result, dict) or result.get("paths") != paths:
            raise StepError(f"file_clipboard: exact native/VFS path list mismatch: {result!r}")
        record["passed"] = True
        return f"{mode} file-list {action}: {len(paths)} path(s) (no product read IPC)"
    except Exception as error:
        record["error"] = str(error)
        raise
    finally:
        append(ctx, "file-clipboard-observations.jsonl", record)


def browser(ctx, args):
    return run(ctx, args, mode="browser")


def native(ctx, args):
    return run(ctx, args, mode="native")
