"""Owned native Save/Open/Folder chooser actions; never replace plugin-dialog results."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess

from .deadline import remaining_timeout
from .steps import StepError

TITLES = {"save": "Save as", "open": "Select file to open", "folder": "Select save directory"}


def validate(ctx, args):
    if not isinstance(args, dict) or set(args) - {"kind", "action", "path", "trigger", "title"}:
        raise StepError("native_file_dialog: expected kind, action, path?, trigger?, title?")
    if args.get("kind") not in TITLES or args.get("action") not in {"choose", "cancel"}:
        raise StepError("native_file_dialog: kind save|open|folder and action choose|cancel required")
    if args.get("title") is not None and (not isinstance(args["title"], str) or not args["title"].strip() or any(ch in args["title"] for ch in "\r\n\0")):
        raise StepError("native_file_dialog: title must be one nonempty native dialog title")
    if args.get("trigger") is not None and (not isinstance(args["trigger"], str) or not args["trigger"].strip()):
        raise StepError("native_file_dialog: trigger must be a selector")
    if args.get("action") == "cancel" and "path" not in args:
        return None
    raw = args.get("path")
    if not isinstance(raw, str) or not raw or not Path(raw).is_absolute():
        raise StepError("native_file_dialog: choose requires an absolute retained QA path")
    requested = Path(raw)
    path = requested.resolve()
    if not path.is_relative_to(ctx.case_dir.parent.resolve()) or requested.is_symlink():
        raise StepError("native_file_dialog: destination must stay inside this QA run")
    if args["kind"] == "folder":
        valid = path.is_dir()
    elif args["kind"] == "open":
        valid = path.is_file()
    else:
        # No overwrite acceptance is automated: use a fresh filename. A valid
        # destination may still be refused by the product after chooser return.
        valid = path.parent.is_dir() and not path.exists()
    if not valid:
        raise StepError("native_file_dialog: target kind/parent is invalid or Save would overwrite")
    return path


def operate(ctx, args, path, click=None):
    from .folder_dialog import command, linux_dialog
    title = args.get("title", TITLES[args["kind"]])
    record = {"kind": args["kind"], "action": args["action"], "path": str(path) if path else None,
              "title": title, "trigger": args.get("trigger"), "passed": False}
    try:
        system = platform.system()
        if system == "Linux":
            record.update(linux_dialog(ctx, path, title=title, kind=args["kind"], cancel_after_path=args["action"] == "cancel" and path is not None))
        else:
            helper = Path(__file__).parent
            env = {**os.environ, "QA_PICKER_APPLICATION": str(Path(ctx.session.application).resolve()),
                   "QA_PICKER_KIND": args["kind"], "QA_PICKER_ACTION": args["action"], "QA_PICKER_TITLE": title,
                   "QA_PICKER_PATH": str(path) if path else "", "QA_PICKER_DIRECTORY": str(path.parent) if path else "",
                   "QA_PICKER_FILENAME": path.name if path else "", "QA_PICKER_CANCEL_AFTER_PATH": "1" if args["action"] == "cancel" and path else "",
                   "QA_PICKER_SCREENSHOT": str(ctx.case_dir / f"native-file-dialog-{getattr(ctx, 'step_index', 0)}.png")}
            if system == "Windows":
                runtime = shutil.which("pwsh")
                if not runtime:
                    raise StepError("native_file_dialog: PowerShell 7 required")
                argv = [runtime, "-NoProfile", "-NonInteractive", "-File", str(helper / "folder_dialog_windows.ps1")]
            elif system == "Darwin":
                argv = ["osascript", "-l", "JavaScript", str(helper / "folder_dialog_macos.js")]
            else:
                raise StepError("native_file_dialog: unsupported platform")
            result = subprocess.run(argv, env=env, text=True, capture_output=True, timeout=60)
            (ctx.case_dir / f"native-file-dialog-{getattr(ctx, 'step_index', 0)}.log").write_text(result.stderr, encoding="utf-8")
            if result.returncode:
                raise StepError("native_file_dialog: " + (result.stderr or result.stdout).strip())
            record.update(json.loads(result.stdout))
        if click is not None:
            click.result(timeout=remaining_timeout(120))
        record["passed"] = True
        return "Actual OS " + args["kind"] + " chooser " + args["action"] + " completed"
    except Exception as error:
        record["error"] = str(error)
        raise
    finally:
        with (ctx.case_dir / "native-file-dialogs.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record) + "\n")


def run(ctx, args):
    path = validate(ctx, args)
    if getattr(ctx, "dry_run", False):
        return "dry-run; no OS chooser operated"
    if not args.get("trigger"):
        return operate(ctx, args, path)
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="qa-file-dialog") as executor:
        click = executor.submit(copy_context().run, ctx.session.click, args["trigger"])
        return operate(ctx, args, path, click)
