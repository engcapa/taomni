"""Attach EdgeDriver to the WebView of the MSI executable launched by this run."""
from contextlib import ExitStack, contextmanager
import json
import os
from pathlib import Path
import socket
import subprocess
import time
from types import SimpleNamespace

import psutil

from qa_ui_auto.deadline import Deadline
from tauri_webdriver import NativeSession


def owned_listener(connections, pids, port):
    return next((c.pid for c in connections if c.pid in pids and c.status == psutil.CONN_LISTEN
                 and c.laddr.port == port and c.laddr.ip in ("127.0.0.1", "::1")), None)


def webview_processes(app, webview):
    """WebView2 may start its browser through the runtime broker on Windows."""
    children = {p.pid for p in app.children(recursive=True)}
    owned = set(children)
    observations = []
    for process in psutil.process_iter(["pid", "name", "cmdline"], ad_value=None):
        if (process.info["name"] or "").casefold() != "msedgewebview2.exe":
            continue
        arguments = process.info["cmdline"] or []
        data = next((arg.partition("=")[2] for arg in arguments if arg.startswith("--user-data-dir=")), "")
        same_profile = bool(data and (Path(data) == webview or Path(data).is_relative_to(webview)))
        if same_profile:
            owned.add(process.pid)
        observations.append({"pid": process.pid, "child": process.pid in children, "expectedProfile": same_profile,
                             "debugPort": next((arg.partition("=")[2] for arg in arguments
                                                if arg.startswith("--remote-debugging-port=")), None)})
    return owned, observations


def stop_child(process):
    if process.poll() is None:
        process.terminate()
    process.wait(timeout=15)


@contextmanager
def installed_webview(executable, webview, evidence, timeout):
    evidence.mkdir(parents=True)
    Path(webview).mkdir(parents=True, exist_ok=True)
    with socket.socket() as app_socket, socket.socket() as driver_socket:
        app_socket.bind(("127.0.0.1", 0))
        driver_socket.bind(("127.0.0.1", 0))
        app_port, driver_port = app_socket.getsockname()[1], driver_socket.getsockname()[1]
    env = dict(os.environ, WEBVIEW2_USER_DATA_FOLDER=str(webview),
               WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=f"--remote-debugging-address=127.0.0.1 --remote-debugging-port={app_port}")
    with ExitStack() as stack:
        def launch(command, name, environment):
            log = stack.enter_context((evidence / name).open("wb"))
            process = subprocess.Popen(command, env=environment, stdout=log, stderr=subprocess.STDOUT)
            stack.callback(stop_child, process)
            return process

        owner = launch([str(executable)], "application.log", env)
        driver = launch(["msedgedriver.exe", f"--port={driver_port}"], "edgedriver.log", os.environ)
        deadline = Deadline(timeout)
        app = psutil.Process(owner.pid)
        observation = {"applicationPid": owner.pid, "driverPid": driver.pid, "requestedDebugPort": app_port,
                       "driverPort": driver_port, "webviewData": str(webview)}
        try:
            while True:
                if owner.poll() is not None or driver.poll() is not None:
                    raise RuntimeError(f"Installed app or EdgeDriver exited before attachment: {owner.returncode}, {driver.returncode}")
                pids, browsers = webview_processes(app, Path(webview))
                connections = psutil.net_connections(kind="tcp")
                browser_pid = owned_listener(connections, pids, app_port)
                adapter_pid = owned_listener(connections, {driver.pid}, driver_port)
                observation.update(browsers=browsers, browserPid=browser_pid, listeningDriver=adapter_pid,
                                   listeners=[{"pid": c.pid, "address": c.laddr.ip, "port": c.laddr.port}
                                              for c in connections if c.status == psutil.CONN_LISTEN
                                              and (c.pid in pids or c.laddr.port in (app_port, driver_port))])
                if browser_pid and adapter_pid:
                    break
                deadline.remaining()
                time.sleep(.25)
        finally:
            (evidence / "webview-startup.json").write_text(json.dumps(observation, indent=2), encoding="utf-8")
        session = NativeSession(f"http://127.0.0.1:{driver_port}", executable)
        session.deadline = deadline
        stack.callback(session.close)
        attached = session.request("POST", "/session", {"capabilities": {"alwaysMatch": {
            "browserName": "webview2", "ms:edgeOptions": {"debuggerAddress": f"127.0.0.1:{app_port}"},
        }}})
        session.session_id = attached["sessionId"]
        session.wait_for_app_ready()
        session.install_console_hook()
        (evidence / "attachment.json").write_text(json.dumps({
            "executable": str(executable), "applicationPid": owner.pid, "browserPid": browser_pid,
            "driverPid": driver.pid, "webviewData": str(webview),
        }, indent=2), encoding="utf-8")
        yield SimpleNamespace(application_process=owner), session
