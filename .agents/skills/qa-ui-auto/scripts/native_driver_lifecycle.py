"""Restore an owned native driver before creating the next isolated session."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import time
from typing import Callable, Protocol

from native_build import QA_APP_ID
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


def driver_start_environment(driver: DriverOwner) -> dict[str, str]:
    """Remember executable lookup inherited by the app's driver parent."""
    environment = dict(os.environ)
    driver._inherited_path = environment.get("PATH")
    return environment


def _windows_webview_options() -> dict[str, str | list[str]]:
    """Keep EdgeDriver and the application on the same run-owned profile."""
    data_root = os.environ.get("NEWMOB_DATA_DIR")
    if not data_root:
        raise WebDriverError("Windows WebView2 session requires the QA data directory")
    return {
        "userDataFolder": os.environ.get("TAOMNI_QA_WEBVIEW_DIR") or str(Path(data_root) / QA_APP_ID / "webview"),
        # Match the canvas color space independently of the runner's monitor profile.
        "additionalBrowserArguments": ["--force-color-profile=srgb"],
    }


def session_payload(application: Path, system: str, webview_debugger_port: int | None) -> dict:
    if webview_debugger_port is not None:
        if system != "Windows" or not 0 < webview_debugger_port <= 65535:
            raise WebDriverError("WebView2 attachment requires a Windows loopback port")
        options = {
            "browserName": "webview2",
            "ms:edgeChromium": True,
            "ms:edgeOptions": {"debuggerAddress": f"127.0.0.1:{webview_debugger_port}"},
        }
    else:
        application_options = {"application": str(application.resolve())}
        if system == "Windows":
            application_options["webviewOptions"] = _windows_webview_options()
        options = {"tauri:options": application_options}
    return {"capabilities": {"alwaysMatch": options}}


def ensure_owned_driver_running(
    driver: DriverOwner, *, system: str, tcp_probe: Callable[[str, int], bool],
) -> None:
    # Fixtures may temporarily prepend a disposable executable. A reused
    # tauri-driver otherwise keeps its old PATH when spawning the next app.
    if (hasattr(driver, "_inherited_path")
            and driver._inherited_path != os.environ.get("PATH")):
        driver.stop()
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
        if system == "Windows":
            from native_windows_integrity import ensure_medium_driver_tree
            ensure_medium_driver_tree(driver.proc.pid)
        return
    if driver.proc is not None and driver.proc.poll() is None:
        driver.stop()

    deadline = time.time() + driver.startup_timeout
    while tcp_probe(driver.host, driver.port) and time.time() < deadline:
        time.sleep(0.1)
    if tcp_probe(driver.host, driver.port):
        raise WebDriverError(f"native driver port {driver.port} did not become available")
    driver.start()
    if system == "Windows":
        if driver.proc is None:
            raise WebDriverError("Owned Windows native driver did not start")
        from native_windows_integrity import ensure_medium_driver_tree
        ensure_medium_driver_tree(driver.proc.pid)
