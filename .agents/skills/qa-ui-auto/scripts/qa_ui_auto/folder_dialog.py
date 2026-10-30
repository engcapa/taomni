"""Operate the QA application's actual OS folder chooser; never mock its result."""
from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
from concurrent.futures import Future, ThreadPoolExecutor
from contextvars import copy_context
from pathlib import Path

from .deadline import budget_time as time, remaining_timeout
from .native_steps import _verb
from .steps import StepError

TITLE = "Select folder to open"


def command(*args: str, check: bool = True) -> str:
    result = subprocess.run(args, text=True, capture_output=True, timeout=10)
    if check and result.returncode:
        raise StepError(f"native_folder_dialog: {args[0]}: {result.stderr.strip()}")
    return result.stdout.strip()


def selected_path(ctx, args: dict) -> Path | None:
    if not isinstance(args, dict) or set(args) - {"action", "path", "trigger"}:
        raise StepError("native_folder_dialog: expected {action: choose|cancel, path?, trigger?}")
    if "trigger" in args and (not isinstance(args["trigger"], str) or not args["trigger"].strip()):
        raise StepError("native_folder_dialog: trigger must be a non-empty selector")
    if args.get("action") == "cancel" and "path" not in args:
        return None
    if args.get("action") != "choose" or not isinstance(args.get("path"), str):
        raise StepError("native_folder_dialog: choose requires a directory path")
    path = Path(args["path"]).resolve()
    if not path.is_relative_to(ctx.case_dir.parent.resolve()) or not path.is_dir():
        raise StepError("native_folder_dialog: directory must exist inside this QA run")
    return path


def linux_dialog(ctx, path: Path | None) -> dict:
    if not os.environ.get("DISPLAY") or os.environ.get("GDK_BACKEND") == "wayland":
        raise StepError("native_folder_dialog: Linux OS chooser automation requires X11")
    application = Path(ctx.session.application).resolve()
    deadline = time.monotonic() + 20
    window = None
    pid = None
    while time.monotonic() < deadline:
        windows = command("xdotool", "search", "--onlyvisible", "--name", "^" + TITLE + "$", check=False).splitlines()
        owned = []
        for candidate in windows:
            owner = command("xdotool", "getwindowpid", candidate, check=False)
            try:
                if Path(f"/proc/{int(owner)}/exe").resolve() == application:
                    owned.append((candidate, int(owner)))
            except (ValueError, OSError):
                continue
        if len(owned) == 1:
            window, pid = owned[0]
            break
        time.sleep(0.1)
    if not window:
        raise StepError("native_folder_dialog: no unique visible chooser owned by the QA binary")
    command("xdotool", "windowactivate", "--sync", window)
    # Capture the real desktop, including the toolkit-owned chooser. Pillow is
    # already a runner dependency; ImageMagick's `import` is not installed on
    # every supported Linux host.
    from PIL import ImageGrab
    ImageGrab.grab(xdisplay=os.environ["DISPLAY"]).save(ctx.case_dir / "native-folder-dialog.png")
    if path is None:
        command("xdotool", "key", "--clearmodifiers", "Escape")
    else:
        # GTK disables Open on Recent until an item is selected. Start from
        # the filesystem view, then submit the location entry directly so
        # navigating cannot accidentally select the first child directory.
        command("xdotool", "key", "--clearmodifiers", "alt+Home")
        time.sleep(0.25)
        command("xdotool", "key", "--clearmodifiers", "ctrl+l")
        command("xdotool", "type", "--clearmodifiers", "--delay", "15", "--", str(path))
        # Activate Open while the location entry still owns the typed path.
        # Enter followed by Open can navigate first, then select its first
        # child directory instead of the requested folder.
        command("xdotool", "key", "--clearmodifiers", "alt+o")
    deadline = time.monotonic() + 10
    while window in command("xdotool", "search", "--onlyvisible", "--name", "^" + TITLE + "$", check=False).splitlines():
        if time.monotonic() > deadline:
            ImageGrab.grab(xdisplay=os.environ["DISPLAY"]).save(ctx.case_dir / "native-folder-dialog-timeout.png")
            raise StepError("native_folder_dialog: chooser did not close")
        # GTK validates a location asynchronously. Open can still be disabled
        # immediately after typing, especially when Recent contains a folder
        # removed by a preceding case. Retry the same explicit selection while
        # this owned chooser remains visible; do not navigate into its children.
        time.sleep(0.25)
        if path is not None and window in command("xdotool", "search", "--onlyvisible", "--name", "^" + TITLE + "$", check=False).splitlines():
            command("xdotool", "key", "--clearmodifiers", "alt+o")
    return {"transport": "X11 OS keyboard", "window": window, "pid": pid, "application": str(application)}


def _operate_folder_dialog(ctx, args, trigger_click: Future | None = None) -> str:
    path = selected_path(ctx, args)
    observation = {"action": args["action"], "path": str(path) if path else None, "platform": platform.system()}
    if args.get("trigger"):
        observation["trigger"] = args["trigger"]
    try:
        if platform.system() == "Linux":
            observation.update(linux_dialog(ctx, path))
        else:
            env = os.environ.copy()
            env.update(QA_PICKER_APPLICATION=str(Path(ctx.session.application).resolve()),
                       QA_PICKER_TITLE=TITLE, QA_PICKER_PATH=str(path) if path else "",
                       QA_PICKER_ACTION=args["action"],
                       QA_PICKER_SCREENSHOT=str((ctx.case_dir / "native-folder-dialog.png").resolve()))
            helper = Path(__file__).parent
            if platform.system() == "Windows":
                # Use the maintained runner runtime to compile and invoke
                # the typed Common Item Dialog helper.
                runtime = shutil.which("pwsh")
                if not runtime:
                    raise StepError("native_folder_dialog: PowerShell 7 (pwsh) is required for Windows chooser automation")
                cmd = [runtime, "-NoProfile", "-NonInteractive", "-File", str(helper / "folder_dialog_windows.ps1")]
            elif platform.system() == "Darwin":
                cmd = ["osascript", "-l", "JavaScript", str(helper / "folder_dialog_macos.js")]
            else:
                raise StepError("native_folder_dialog: unsupported OS")
            try:
                result = subprocess.run(cmd, env=env, text=True, capture_output=True, timeout=60)
            except subprocess.TimeoutExpired as error:
                output = error.stderr or error.stdout or ""
                if isinstance(output, bytes):
                    output = output.decode("utf-8", errors="replace")
                (ctx.case_dir / "native-folder-dialog-helper.log").write_text(output, encoding="utf-8")
                raise
            (ctx.case_dir / "native-folder-dialog-helper.log").write_text(result.stderr, encoding="utf-8")
            if result.returncode:
                raise StepError(f"native_folder_dialog: {result.stderr.strip() or result.stdout.strip()}")
            observation.update(json.loads(result.stdout))
        if trigger_click is not None:
            trigger_click.result(timeout=remaining_timeout(120))
        observation["passed"] = True
    except Exception as error:
        observation.update(passed=False, error=str(error))
        # WebView screenshots exclude system sheets/dialogs. Retain the actual
        # desktop after a failed native operation, before teardown closes it.
        try:
            destination = ctx.case_dir / "native-folder-dialog-failure.png"
            if platform.system() == "Darwin":
                command("screencapture", "-x", str(destination), check=False)
            elif platform.system() == "Windows":
                from PIL import ImageGrab
                ImageGrab.grab(all_screens=True).save(destination)
        except Exception as capture_error:
            observation["desktop_capture_error"] = str(capture_error)
        raise
    finally:
        with (ctx.case_dir / "native-folder-dialogs.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(observation) + "\n")
    return f"OS directory chooser {args['action']} completed"


@_verb("native_folder_dialog")
def run_folder_dialog(ctx, args) -> str:
    selected_path(ctx, args)  # Validate owned paths and arguments before input.
    if not args.get("trigger"):
        return _operate_folder_dialog(ctx, args)
    # A modal NSOpenPanel can hold the WebView click response until it closes.
    # Operate the actual owned OS chooser while that one real click is pending;
    # join it before returning, and preserve both operations' failures.
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="qa-folder-click") as executor:
        click = executor.submit(copy_context().run, ctx.session.click, args["trigger"])
        return _operate_folder_dialog(ctx, args, click)
