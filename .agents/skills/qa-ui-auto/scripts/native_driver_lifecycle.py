"""Restore an owned native driver before creating the next isolated session."""
from __future__ import annotations

import subprocess
import time
from typing import Callable, Protocol

from native_process_group import wait_for_driver_ports
from native_webdriver_transport import WebDriverError


class DriverOwner(Protocol):
    host: str
    port: int
    native_port: int
    startup_timeout: float
    proc: subprocess.Popen | None
    _restart_required: bool

    def start(self) -> None: ...
    def stop(self) -> None: ...


def ensure_owned_driver_running(
    driver: DriverOwner, *, system: str, tcp_probe: Callable[[str, int], bool],
) -> None:
    if system == "Linux":
        # Linux normally reuses tauri-driver across cases. An explicit app
        # restart releases it too; a failed restart must not strand later
        # cases on a stopped driver. Wait for both old adapters before launch.
        if driver.proc is not None and driver.proc.poll() is None:
            return
        if driver.proc is not None:
            driver.stop()
        wait_for_driver_ports(driver.host, (driver.port, driver.native_port))
        driver.start()
        return
    if system not in ("Darwin", "Windows"):
        return

    # macOS owns the app itself; Windows must release its profile-owning tree.
    if driver._restart_required:
        driver.stop()
        driver._restart_required = False

    if driver.proc is not None and driver.proc.poll() is None and tcp_probe(driver.host, driver.port):
        return
    if driver.proc is not None and driver.proc.poll() is None:
        driver.stop()

    deadline = time.time() + driver.startup_timeout
    while tcp_probe(driver.host, driver.port) and time.time() < deadline:
        time.sleep(0.1)
    if tcp_probe(driver.host, driver.port):
        raise WebDriverError(f"native driver port {driver.port} did not become available")
    driver.start()
