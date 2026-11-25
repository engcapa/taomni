"""Observe normal application/storage shutdown before releasing its driver."""
from __future__ import annotations

from pathlib import Path
import time


class ApplicationShutdownTimeout(RuntimeError):
    def __init__(self, processes: list[dict]):
        self.processes = processes
        pids = [process["pid"] for process in processes]
        super().__init__(f"QA application/storage processes did not exit normally: {pids}")


def linux_storage_processes(driver, application: Path, proc_root: Path = Path("/proc")) -> dict[int, str]:
    """Snapshot only application/WebKit processes in this launcher's group.

    A closed WebDriver context does not establish that WebKit's storage
    process has flushed localStorage. Killing the group at that point turns
    a normal-close persistence scenario into a crash scenario.
    """
    if not proc_root.is_dir() or not driver.proc:
        return {}
    result = {}
    for entry in proc_root.iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
            if int(fields[2]) != driver.proc.pid or fields[0] == "Z":
                continue
            executable = (entry / "exe").resolve(strict=True)
            storage_child = executable.name in {"WebKitNetworkProcess", "WebKitWebProcess", "WebKitGPUProcess"}
            if executable == application.resolve() or storage_child:
                result[int(entry.name)] = fields[19]  # kernel start time protects PID reuse
        except (OSError, ValueError, IndexError):
            continue
    return result


def wait_for_application_shutdown(driver, session, processes: dict[int, str], timeout: float = 15) -> dict:
    started = time.monotonic()
    if session.transport == "macOS WKWebView bridge":
        # The macOS bridge owner is the app itself, rather than tauri-driver.
        budget = min(timeout, session.deadline.remaining()) if session.deadline else timeout
        code = driver.proc.wait(timeout=budget)
        if code != 0:
            raise RuntimeError(f"QA application did not exit normally (exit {code})")
        return {"exit_code": code, "duration_sec": time.monotonic() - started}
    remaining = dict(processes)
    while remaining:
        survivors = []
        for pid, identity in list(remaining.items()):
            try:
                command, fields_text = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)
                fields = fields_text.split()
                alive = fields[0] != "Z" and fields[19] == identity
                parent, group = int(fields[1]), int(fields[2])
            except (OSError, ValueError, IndexError):
                alive = False
            if alive:
                survivors.append({
                    "pid": pid, "name": command.partition("(")[2], "state": fields[0],
                    "parent_pid": parent, "process_group": group,
                    "kernel_start_time": fields[19],
                })
            else:
                del remaining[pid]
        if not remaining:
            break
        if session.deadline:
            session.deadline.remaining()
        if time.monotonic() - started >= timeout:
            raise ApplicationShutdownTimeout(sorted(survivors, key=lambda process: process["pid"]))
        time.sleep(0.05)
    return {"process_ids": sorted(processes), "duration_sec": time.monotonic() - started}
