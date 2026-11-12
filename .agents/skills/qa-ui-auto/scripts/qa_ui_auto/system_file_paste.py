"""Actual file-manager Paste with independent target bytes, no host copy API."""
from __future__ import annotations

import json
from pathlib import Path
import platform

from .deadline import budget_time as time
from .file_clipboard import append, scoped
from .steps import StepError
from .workspace_drop_observation import host_snapshot

FINDER = """on run argv
  set destination to POSIX file (item 1 of argv) as alias
  tell application "Finder"
    activate
    set targetWindow to make new Finder window
    set target of targetWindow to destination
    set windowId to id of targetWindow
  end tell
  try
    tell application "System Events"
      tell process "Finder"
        set frontmost to true
        set pasteItem to menu item "Paste Item" of menu "Edit" of menu bar 1
        if not enabled of pasteItem then error "Finder Paste Item is disabled"
        click pasteItem
      end tell
    end tell
    return windowId as text
  on error messageText
    tell application "Finder" to close targetWindow
    error messageText
  end try
end run
"""


def expected_snapshot(paths: list[str]) -> dict:
    files, directories = {}, [""]
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            snapshot = host_snapshot(path)
            directories.extend(path.name + ("/" + value if value else "") for value in snapshot["directories"])
            files.update({path.name + "/" + name: digest for name, digest in snapshot["files"].items()})
        else:
            import hashlib
            files[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return {"files": files, "directories": sorted(directories)}


def run(ctx, args):
    if not isinstance(args, dict) or set(args) != {"directory", "paths"} or not isinstance(args["paths"], list) or not args["paths"]:
        raise StepError("system_file_paste: expected {directory, paths: nonempty string[]}")
    paths = scoped(ctx, args["paths"], "native")
    directory = Path(args["directory"]).resolve()
    if not directory.is_relative_to(ctx.case_dir.parent.resolve()) or not directory.is_dir() or any(directory.iterdir()):
        raise StepError("system_file_paste: target must be an empty retained run directory")
    for raw in paths:
        if directory.is_relative_to(Path(raw)):
            raise StepError("system_file_paste: target cannot be inside a copied source")
    record = {"directory": str(directory), "paths": paths, "realFileManagerAction": True, "passed": False}
    manager_cleanup = lambda: None
    try:
        from . import file_clipboard_native as clipboard
        from . import host_clipboard as host
        before = clipboard.read()
        record["clipboardBefore"] = before
        if before["paths"] != paths:
            raise StepError("system_file_paste: independent native clipboard is not the requested file list")
        expected = expected_snapshot(paths)
        record["expected"] = expected
        system = platform.system()
        if system == "Linux":
            from . import file_manager_x11
            manager_cleanup = lambda: file_manager_x11.stop(ctx)
            record["action"] = file_manager_x11.paste(ctx, directory)
        elif system == "Windows":
            record["action"] = {"transport": "Windows Shell FolderItem InvokeVerb(paste)"}
            host._ps("$shell=New-Object -ComObject Shell.Application;"
                     "$folder=$shell.Namespace($arg); if($null -eq $folder){throw 'Shell target missing'};"
                     "$folder.Self.InvokeVerb('paste'); 'dispatched'", str(directory))
        elif system == "Darwin":
            record["action"] = {"transport": "Finder System Events real Edit/Paste Item"}
            output = host._run(["osascript", "-e", FINDER, str(directory)]).decode().strip()
            if not output.isdigit():
                raise StepError("system_file_paste: Finder did not identify its owned window")
            record["action"]["windowId"] = int(output)
            manager_cleanup = lambda: host._run(["osascript", "-e", f'tell application "Finder" to close window id {output}'])
        else:
            raise StepError("system_file_paste: unsupported platform")
        deadline = time.monotonic() + 20
        while True:
            actual = host_snapshot(directory)
            record["observed"] = actual
            if actual == expected:
                break
            if time.monotonic() > deadline:
                raise StepError("system_file_paste: real file manager did not create the exact expected bytes/empty directories")
            time.sleep(.1)
        record["clipboardAfter"] = clipboard.read()
        if record["clipboardAfter"]["paths"] != paths:
            raise StepError("system_file_paste: file manager unexpectedly changed the copied file references")
        record["passed"] = True
        return "real file-manager Paste produced exact SHA256 and empty-directory set"
    except Exception as error:
        record["error"] = str(error)
        raise
    finally:
        try:
            manager_cleanup()
            session = getattr(ctx, "session", None)
            if session:
                session.activate_linux_window()
        finally:
            append(ctx, "system-file-paste.jsonl", record)
