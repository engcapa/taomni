"""Verify abrupt exit of one owned installed desktop and its signed MFA host."""
from __future__ import annotations

from contextlib import ExitStack
from dataclasses import asdict, dataclass
import os
from pathlib import Path
import select
import signal


@dataclass(frozen=True)
class Process:
    pid: int
    parent: int
    group: int
    start_time: str
    executable: str


def read_process(entry: Path) -> Process | None:
    try:
        fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
        if fields[0] == "Z":
            return None
        return Process(int(entry.name), int(fields[1]), int(fields[2]), fields[19],
                       str((entry / "exe").resolve(strict=True)))
    except (OSError, ValueError, IndexError):
        return None


def identify(app: Path, module: Path, driver_group: int, proc: Path) -> tuple[Process, Process]:
    identities = (read_process(entry) for entry in proc.iterdir() if entry.name.isdecimal())
    processes = [process for process in identities if process is not None]
    owners = [p for p in processes if p.group == driver_group and p.executable == str(app)]
    if len(owners) != 1:
        raise RuntimeError("Expected one installed Taomni process in the owned driver group")
    core = owners[0]
    hosts = [p for p in processes if p.parent == core.pid and p.executable == str(module)]
    if len(hosts) != 1:
        raise RuntimeError("Expected one signed MFA host owned by the installed Taomni process")
    return core, hosts[0]


def watch_process(identity: Process, proc: Path, resources: ExitStack) -> int:
    fd = os.pidfd_open(identity.pid)
    resources.callback(os.close, fd)
    if read_process(proc / str(identity.pid)) != identity:
        raise RuntimeError("Installed process identity changed before opening its pidfd")
    return fd


def wait_for_exit(fd: int, label: str) -> None:
    poll = select.poll()
    poll.register(fd, select.POLLIN)
    if not any(event & select.POLLIN for _, event in poll.poll(10_000)):
        raise RuntimeError(f"Installed {label} process survived the abrupt exit")


def abrupt_exit(app: Path, module: Path, driver_group: int, observation: dict) -> None:
    proc = Path("/proc")
    core, host = identify(app.resolve(strict=True), module.resolve(strict=True), driver_group, proc)
    observation.update(core=asdict(core), host=asdict(host), signal="SIGKILL")
    with ExitStack() as resources:
        core_fd = watch_process(core, proc, resources)
        host_fd = watch_process(host, proc, resources)
        signal.pidfd_send_signal(core_fd, signal.SIGKILL)
        wait_for_exit(core_fd, "Taomni")
        observation["coreExited"] = True
        wait_for_exit(host_fd, "MFA host")
        observation["hostExitedBeforeDriverCleanup"] = True
