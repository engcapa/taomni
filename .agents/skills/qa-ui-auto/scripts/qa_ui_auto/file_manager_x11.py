"""A private PCManFM-Qt window, real X11 Paste; no filesystem copy shortcut."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import signal
import subprocess

from .deadline import budget_time as time
from .steps import StepError


def command(*args, check=True):
    result = subprocess.run(args, capture_output=True, text=True, timeout=10)
    if check and result.returncode:
        raise StepError(f"system_file_paste: {args[0]}: {result.stderr.strip()}")
    return result.stdout.strip()


def paste(ctx, directory: Path) -> dict:
    if not os.environ.get("DISPLAY") or os.environ.get("GDK_BACKEND") == "wayland":
        raise StepError("system_file_paste: Linux requires X11; Wayland file-manager action remains a manual gap")
    executable = shutil.which("pcmanfm-qt")
    if not executable or not shutil.which("xdotool") or not shutil.which("dbus-run-session"):
        raise StepError("system_file_paste: PCManFM-Qt, xdotool and private DBus are required")
    root = ctx.case_dir / "file-manager-private"
    root.mkdir(exist_ok=True)
    environment = {**os.environ, "QT_QPA_PLATFORM": "xcb"}
    for name in ("CONFIG", "DATA", "CACHE"):
        path = root / name.lower()
        path.mkdir(exist_ok=True)
        environment[f"XDG_{name}_HOME"] = str(path)
    observation = {"transport": "PCManFM-Qt real X11 Ctrl+V", "privateConfig": str(root), "directory": str(directory)}
    log = (root / "process.log").open("ab")
    process = subprocess.Popen(["dbus-run-session", "--", executable, "--new-window", str(directory)],
                               env=environment, stdout=log, stderr=log, start_new_session=True)
    try:
        deadline = time.monotonic() + 15
        owned = []
        while time.monotonic() < deadline and process.poll() is None:
            owned = []
            for window in command("xdotool", "search", "--onlyvisible", "--class", "[Pp][Cc][Mm]an[Ff][Mm]", check=False).splitlines():
                raw_pid = command("xdotool", "getwindowpid", window, check=False)
                try:
                    pid = int(raw_pid)
                    if os.getpgid(pid) == process.pid and Path(f"/proc/{pid}/exe").resolve() == Path(executable).resolve():
                        title = command("xdotool", "getwindowname", window)
                        if directory.name in title:
                            owned.append((window, pid, title))
                except (ValueError, OSError):
                    continue
            if len(owned) == 1:
                break
            time.sleep(.1)
        if len(owned) != 1:
            raise StepError("system_file_paste: no unique owned PCManFM-Qt target window; see private process log")
        window, pid, title = owned[0]
        observation.update(window=window, pid=pid, title=title)
        command("xdotool", "windowactivate", "--sync", window)
        geometry = command("xdotool", "getwindowgeometry", "--shell", window)
        fields = dict(line.split("=", 1) for line in geometry.splitlines() if "=" in line)
        x, y = int(fields["WIDTH"]) // 2, int(fields["HEIGHT"]) * 2 // 3
        command("xdotool", "mousemove", "--window", window, str(x), str(y))
        command("xdotool", "click", "1")
        if command("xdotool", "getactivewindow") != window:
            raise StepError("system_file_paste: owned file manager did not retain OS focus")
        # Exactly one actual keyboard action. Do not retry an uncertain Paste.
        command("xdotool", "key", "--clearmodifiers", "ctrl+v")
        observation["pasteDispatched"] = True
        return observation
    finally:
        # PCManFM performs an asynchronous copy. The caller's byte check runs
        # while this process is alive via the cleanup callback below.
        ctx._system_file_manager = (process, log)


def stop(ctx) -> None:
    owned = getattr(ctx, "_system_file_manager", None)
    if not owned:
        return
    process, log = owned
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=5)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)
    finally:
        log.close()
        ctx._system_file_manager = None
