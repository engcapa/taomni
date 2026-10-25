"""Release a Linux native driver's private process group, including its adapter."""
from __future__ import annotations

from contextlib import suppress
import os
import signal
import socket
import subprocess
import time


def wait_for_driver_ports(host: str, ports: tuple[int, ...], timeout: float = 5) -> None:
    """After stopping an owned driver, wait for its adapters to release TCP."""
    deadline = time.monotonic() + timeout
    for port in ports:
        while True:
            try:
                with socket.create_connection((host, port), timeout=0.1):
                    pass
            except ConnectionRefusedError:
                break
            except TimeoutError:
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError(f"Owned native driver did not release port {port}")
            time.sleep(0.02)


def stop_owned_process_group(proc: subprocess.Popen, timeout: float = 5) -> None:
    # start_new_session gives this launch a dedicated group whose id is the
    # launcher's pid. Never signal a caller's or another driver's process group.
    if proc.pid == os.getpgrp():
        raise RuntimeError("Refusing to terminate the runner's process group")
    with suppress(ProcessLookupError):
        if os.getpgid(proc.pid) != proc.pid:
            raise RuntimeError("Native driver was not started in an owned process group")
    with suppress(ProcessLookupError):
        os.killpg(proc.pid, signal.SIGTERM)
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        pass
    # The adapter can outlive a launcher which exited successfully. Release
    # those owned children too before the next application restart binds ports.
    with suppress(ProcessLookupError):
        os.killpg(proc.pid, signal.SIGKILL)
    proc.wait(timeout=timeout)
