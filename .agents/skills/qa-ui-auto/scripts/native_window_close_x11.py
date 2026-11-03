"""Request normal closure of one X11 window owned by this QA launcher only."""
from __future__ import annotations

from pathlib import Path
import subprocess

from native_webdriver_transport import WebDriverError


def owned_application_pid(application: Path, processes: dict[int, str],
                          proc_root: Path = Path("/proc")) -> int:
    owners = []
    application = application.resolve()
    for pid, started in processes.items():
        try:
            entry = proc_root / str(pid)
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
            executable = (entry / "exe").resolve(strict=True)
            owned = fields[0] != "Z" and fields[19] == started and executable == application
        except (OSError, ValueError, IndexError):
            continue
        if owned:
            owners.append(pid)
    if len(owners) != 1:
        raise WebDriverError("No unique live QA executable in the owned launcher group")
    return owners[0]


def managed_windows() -> list[tuple[str, int]]:
    result = subprocess.run(["wmctrl", "-lp"], capture_output=True, text=True,
                            timeout=5, check=True)
    windows = []
    for line in result.stdout.splitlines():
        fields = line.split(None, 4)
        if len(fields) < 4:
            raise WebDriverError("Malformed X11 managed-window observation")
        try:
            xid, pid = int(fields[0], 16), int(fields[2])
        except ValueError as error:
            raise WebDriverError("Malformed X11 window identity") from error
        if xid <= 0 or pid < 0:
            raise WebDriverError("Invalid X11 window identity")
        windows.append((f"0x{xid:x}", pid))
    return windows


def close_x11_application_window(application: Path, processes: dict[int, str]) -> dict:
    pid = owned_application_pid(application, processes)
    windows = [xid for xid, owner in managed_windows() if owner == pid]
    if len(windows) != 1:
        raise WebDriverError("No unique managed X11 window owned by the QA executable")
    # Recheck the kernel start identity after enumeration, before sending input.
    if owned_application_pid(application, processes) != pid:
        raise WebDriverError("QA executable ownership changed before X11 close")
    xid = windows[0]
    # EWMH normal close raises the same Tauri CloseRequested/confirmation path
    # as a native titlebar close. Never use windowkill, destroy or a process signal.
    subprocess.run(["wmctrl", "-ic", xid], capture_output=True, text=True,
                   timeout=5, check=True)
    return {"transport": "X11 window-manager close", "application": str(application.resolve()),
            "pid": pid, "window_id": xid, "window_closed": False}


def x11_window_closed(observation: dict) -> bool:
    # XID reuse by another owner is not proof that the old window disappeared.
    # Require that exact native surface to be absent, not just its title or PID.
    observation["window_closed"] = all(
        xid != observation["window_id"] for xid, _ in managed_windows())
    return observation["window_closed"]
