"""Release a Linux native driver's private process group, including its adapter."""
from __future__ import annotations

from contextlib import suppress
import os
import platform
import signal
import socket
import subprocess
import time


def windows_listeners(ports: tuple[int, ...]) -> list[dict]:
    """Read the OS TCP table; Windows may silently drop closed-port SYNs."""
    import json
    script = (
        "$ErrorActionPreference = 'Stop'; "
        f"$ports = @({','.join(str(int(port)) for port in ports)}); "
        "$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | "
        "Where-Object { $_.LocalPort -in $ports } | Select-Object LocalAddress,LocalPort,OwningProcess); "
        "ConvertTo-Json -InputObject $listeners -Compress"
    )
    result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                            check=True, capture_output=True, text=True, timeout=10)
    listeners = json.loads(result.stdout)
    if not isinstance(listeners, list) or any(not isinstance(row, dict) or row.get("LocalPort") not in ports
                                             or not isinstance(row.get("OwningProcess"), int) for row in listeners):
        raise RuntimeError("Windows TCP listener observation is invalid")
    return listeners


def wait_for_driver_ports(host: str, ports: tuple[int, ...], timeout: float = 5) -> dict | None:
    """After stopping an owned driver, wait for its adapters to release TCP."""
    deadline = time.monotonic() + timeout
    if platform.system() == "Windows":
        while True:
            listeners = windows_listeners(ports)
            if not listeners:
                return {"transport": "Windows TCP listener table", "ports": list(ports), "listeners": []}
            if time.monotonic() >= deadline:
                raise RuntimeError(f"Owned native driver ports still have listeners: {listeners}")
            time.sleep(0.1)
    for port in ports:
        while True:
            try:
                # Windows can take about a second to reject a closed loopback
                # port. A 100ms probe keeps timing out before ECONNREFUSED and
                # incorrectly reports an already stopped driver as listening.
                with socket.create_connection((host, port), timeout=min(2, max(0.1, deadline - time.monotonic()))):
                    pass
                last_probe = "connection opened"
            except ConnectionRefusedError:
                break
            except ConnectionResetError:
                # A closing adapter can reset the probe during its TCP
                # handshake. Only a later refusal proves the port is free.
                last_probe = "connection reset while the adapter was closing"
            except TimeoutError:
                last_probe = "connection timed out without a refusal"
            if time.monotonic() >= deadline:
                raise RuntimeError(f"Owned native driver did not release port {port}: {last_probe}")
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
