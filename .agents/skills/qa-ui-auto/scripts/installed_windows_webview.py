"""Attach EdgeDriver to the WebView of a runner-owned installed app."""

from contextlib import ExitStack, contextmanager, suppress
import os
import socket
import subprocess
import time

from modular_bundle_inventory import write_json
from qa_ui_auto.deadline import Deadline
from qa_ui_auto.fixtures.module_legacy_mfa import legacy_driver
from tauri_webdriver import NativeSession


def wait_for_owned_webview(owner, port, deadline):
    import psutil

    root = psutil.Process(owner.pid)
    while time.monotonic() < deadline:
        if owner.poll() is not None:
            raise RuntimeError(f"The installed application exited before starting WebView2 ({owner.returncode})")
        children = set()
        with suppress(psutil.NoSuchProcess):
            for child in root.children(recursive=True):
                with suppress(psutil.NoSuchProcess):
                    if child.name().casefold() == "msedgewebview2.exe":
                        children.add(child.pid)
        for endpoint in psutil.net_connections(kind="tcp"):
            if endpoint.status != psutil.CONN_LISTEN or endpoint.laddr.port != port:
                continue
            if endpoint.laddr.ip not in {"127.0.0.1", "::1"}:
                raise RuntimeError("WebView2 debugging listener must be local to the runner")
            if endpoint.laddr.ip == "127.0.0.1" and endpoint.pid in children:
                return endpoint.pid
        time.sleep(0.25)
    raise RuntimeError(f"Windows application PID {owner.pid} did not open its loopback WebView2 port {port}")


def stop(owner):
    if owner.poll() is None:
        owner.kill()
    owner.wait(timeout=15)


@contextmanager
def installed_windows_desktop(ctx, executable, work, evidence, label):
    webview = work / f"{label}-webview"
    webview.mkdir()
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    environment = {
        **os.environ,
        "WEBVIEW2_USER_DATA_FOLDER": str(webview),
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS": (
            f"--remote-debugging-address=127.0.0.1 --remote-debugging-port={port} --force-color-profile=srgb"
        ),
    }
    stage = evidence / label
    stage.mkdir()
    observation = {"webviewDataFolder": str(webview), "debuggerPort": port, "attached": False}
    try:
        with ExitStack() as cleanup, (stage / "application.log").open("xb") as output:
            owner = subprocess.Popen([str(executable)], stdin=subprocess.DEVNULL, stdout=output,
                                     stderr=subprocess.STDOUT, env=environment)
            cleanup.callback(stop, owner)
            observation["installedPid"] = owner.pid
            observation["webviewPid"] = wait_for_owned_webview(owner, port, time.monotonic() + 60)
            driver = legacy_driver(ctx, executable, stage)
            cleanup.callback(driver.stop)
            driver.start()
            session = NativeSession(driver.url, executable)
            session.deadline = Deadline(120)
            session.pointer_observations_path = stage / "pointer-clicks.jsonl"
            cleanup.callback(session.close)
            session.start(webview_debugger_port=port)
            observation["attached"] = True
            yield owner, session
    finally:
        write_json(stage / "webview-attachment.json", observation)
