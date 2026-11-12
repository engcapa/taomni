"""Synthetic system-file drag entry, never an OS gesture or an import shortcut.

Both runners execute the same hit-test/transport script. It dispatches DOM events
or targeted Tauri events only; product handlers, IPC and filesystem mutations
remain owned by the application. Per-phase evidence survives transport failures.
"""
from __future__ import annotations

import json
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Protocol

from .steps import StepError

SCRIPT = Path(__file__).with_suffix(".js").read_text(encoding="utf-8")
PHASES = {"enter", "over", "drop", "leave"}


class DragContext(Protocol):
    case_dir: Path


def validate(args: Any) -> dict[str, Any]:
    if not isinstance(args, dict) or set(args) - {"selector", "phase", "paths"}:
        raise StepError("os_file_drag: expected {selector?, phase, paths?}")
    phase = args.get("phase")
    if not isinstance(phase, str) or phase not in PHASES:
        raise StepError("os_file_drag: phase must be enter/over/drop/leave")
    selector = args.get("selector")
    if "selector" in args and (not isinstance(selector, str) or not selector.strip()):
        raise StepError("os_file_drag: selector must be a nonempty CSS selector")
    paths = args.get("paths", [])
    if not isinstance(paths, list) or any(not isinstance(path, str) or not path for path in paths):
        raise StepError("os_file_drag: paths must be an array of nonempty absolute paths")
    # Keep URI encoding platform-independent: Windows paths must not become
    # file:///C%3A/... simply because the tool unit tests are running on Linux.
    uris = [file_uri(path) for path in paths]
    if phase in {"enter", "drop"} and not paths:
        raise StepError(f"os_file_drag: {phase} requires nonempty paths")
    return {"selector": selector, "phase": phase, "paths": paths,
            "uriList": "\r\n".join(uris)}


def file_uri(path: str) -> str:
    if any(char in path for char in ("\x00", "\r", "\n")):
        raise StepError("os_file_drag: paths must not contain NUL/CR/LF")
    windows = PureWindowsPath(path)
    if windows.is_absolute() and (windows.drive.endswith(":") or path.startswith(("\\\\", "//"))):
        return windows.as_uri()
    posix = PurePosixPath(path)
    if posix.is_absolute():
        return posix.as_uri()
    raise StepError(f"os_file_drag: path must be absolute: {path!r}")


def _record(ctx: DragContext, entry: dict[str, Any]) -> None:
    ctx.case_dir.mkdir(parents=True, exist_ok=True)
    with (ctx.case_dir / "os-file-drag.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")


def run(ctx: DragContext, args: Any, *, mode: str, execute) -> str:
    request = {**validate(args), "mode": mode}
    entry = {"synthetic": True, "physicalOsGesture": False, "mode": mode,
             "request": request, "delivered": False}
    try:
        result = execute(request)
        entry["observation"] = result
        if not isinstance(result, dict) or result.get("ok") is not True:
            raise StepError(f"os_file_drag: synthetic event entry failed: {result!r}")
        entry["delivered"] = True
        return f"synthetic {mode} file drag {request['phase']} delivered (not an OS gesture)"
    except Exception as error:
        entry["error"] = str(error)
        raise
    finally:
        _record(ctx, entry)


def browser(ctx: Any, args: Any) -> None:
    validate(args)
    if ctx.dry_run:
        return
    run(ctx, args, mode="browser", execute=lambda request: ctx.page.evaluate(SCRIPT, request))


def native(ctx: Any, args: Any) -> str:
    # /execute/sync would serialize a Promise rather than settle emitTo. Use the
    # existing async endpoint and never retry uncertain native event delivery.
    script = (
        "const request = arguments[0]; const done = arguments[arguments.length - 1];\n"
        f"({SCRIPT})(request).then(done, error => done({{ok: false, error: String(error)}}));"
    )
    return run(ctx, args, mode="native", execute=lambda request: ctx.session.request(
        "POST", ctx.session.endpoint("/execute/async"), {"script": script, "args": [request]},
    ))
