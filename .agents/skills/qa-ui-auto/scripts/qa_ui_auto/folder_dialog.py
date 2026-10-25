"""Operate the QA application's actual OS folder chooser; never mock its result."""
from __future__ import annotations

import json
import os
import platform
import subprocess
from pathlib import Path

from .deadline import budget_time as time
from .native_steps import _verb
from .steps import StepError

TITLE = "Select folder to open"


def command(*args: str, check: bool = True) -> str:
    result = subprocess.run(args, text=True, capture_output=True, timeout=10)
    if check and result.returncode:
        raise StepError(f"native_folder_dialog: {args[0]}: {result.stderr.strip()}")
    return result.stdout.strip()


def selected_path(ctx, args: dict) -> Path | None:
    if not isinstance(args, dict) or set(args) - {"action", "path"}:
        raise StepError("native_folder_dialog: expected {action: choose|cancel, path?}")
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


@_verb("native_folder_dialog")
def run_folder_dialog(ctx, args) -> str:
    path = selected_path(ctx, args)
    observation = {"action": args["action"], "path": str(path) if path else None, "platform": platform.system()}
    try:
        if platform.system() == "Linux":
            observation.update(linux_dialog(ctx, path))
        else:
            env = os.environ.copy()
            env.update(QA_PICKER_APPLICATION=str(Path(ctx.session.application).resolve()),
                       QA_PICKER_TITLE=TITLE, QA_PICKER_PATH=str(path) if path else "",
                       QA_PICKER_ACTION=args["action"])
            helper = Path(__file__).parent
            if platform.system() == "Windows":
                cmd = ["powershell", "-NoProfile", "-NonInteractive", "-File", str(helper / "folder_dialog_windows.ps1")]
            elif platform.system() == "Darwin":
                cmd = ["osascript", "-l", "JavaScript", str(helper / "folder_dialog_macos.js")]
            else:
                raise StepError("native_folder_dialog: unsupported OS")
            result = subprocess.run(cmd, env=env, text=True, capture_output=True, timeout=40)
            if result.returncode:
                raise StepError(f"native_folder_dialog: {result.stderr.strip() or result.stdout.strip()}")
            observation.update(json.loads(result.stdout))
        observation["passed"] = True
    except Exception as error:
        observation.update(passed=False, error=str(error))
        raise
    finally:
        with (ctx.case_dir / "native-folder-dialogs.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(observation) + "\n")
    return f"OS directory chooser {args['action']} completed"
