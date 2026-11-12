"""Scoped fixture file lists and independent native-format observations."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import platform
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


def paths_match(actual: Any, expected: list[str], *, mode: str) -> bool:
    if not isinstance(actual, list) or any(not isinstance(path, str) for path in actual):
        return False
    if mode != "native" or platform.system() != "Windows":
        return actual == expected

    def spelling(path: str) -> str:
        # CF_HDROP preserves the writer's separators. Fold only the drive
        # letter, not case-sensitive filenames, whitespace, aliases or '..'.
        path = path.replace("\\", "/")
        if len(path) >= 3 and path[0].isascii() and path[0].isalpha() and path[1:3] == ":/":
            path = path[0].lower() + path[1:]
        return path

    return [spelling(path) for path in actual] == [spelling(path) for path in expected]


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
                if paths_match(result.get("paths"), paths, mode=mode) or time.monotonic() >= deadline:
                    break
                time.sleep(.1)
            record["fileHashes"] = digests(paths)
        record["observation"] = result
        if not isinstance(result, dict) or not paths_match(result.get("paths"), paths, mode=mode):
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
