"""Activate the desktop window belonging to one native WebDriver session."""
from __future__ import annotations

import json
import os
from pathlib import Path
import platform
import socket
import sys
import time
from typing import Any, Mapping, Protocol

from native_webdriver_transport import WebDriverError


class FocusSession(Protocol):
    application: Path
    focus_warning: str

    def execute(self, script: str) -> Any: ...
    def request(self, method: str, path: str, payload: dict | None = None) -> Any: ...
    def endpoint(self, suffix: str) -> str: ...


class NativeWindowFocus:
    def __init__(self, session: FocusSession, environment: Mapping[str, str]):
        self.session = session
        # Capture the session's profile before a nested harness changes the
        # parent environment. Two QA processes can share a binary and desktop.
        self.data_home = environment.get("XDG_DATA_HOME")

    def activate_linux_window(self) -> None:
        """Give the fresh/reloaded QA document real desktop focus.

        X11 recovery stays best effort; a focus assertion belongs to the case.
        Wayland's broker must identify and activate this particular instance.
        """
        session = self.session
        session.focus_warning = ""
        if platform.system() != "Linux":
            return
        if os.environ.get("GDK_BACKEND", "").split(",")[0] == "wayland":
            self.activate_wayland_window()
            return
        if session.execute("return document.hasFocus();") is not True:
            try:
                from qa_ui_auto.native_steps import _activate_x11_application
                _activate_x11_application(session.application)
            except Exception as error:  # noqa: BLE001 - reported, never fatal
                session.focus_warning = f"X11 activation unavailable: {error}"
                print(f"[native] {session.focus_warning}", file=sys.stderr, flush=True)
                return
            handle = session.request("GET", session.endpoint("/window"))
            session.request("POST", session.endpoint("/window"), {"handle": handle})
            end = time.monotonic() + 5
            while session.execute("return document.hasFocus();") is not True:
                if time.monotonic() >= end:
                    session.focus_warning = "X11 QA document did not receive native focus"
                    print(f"[native] {session.focus_warning}", file=sys.stderr, flush=True)
                    return
                time.sleep(0.1)

    def activate_wayland_window(self, timeout: float = 5.0) -> None:
        # DOM focus can remain true while a Shell actor intercepts input.
        # Verify compositor activation, then refocus the WebDriver context.
        session = self.session
        input_socket = os.environ.get("QA_WAYLAND_INPUT_SOCKET")
        if input_socket:
            # A single app/profile can own both the main and detached windows.
            # Read the native title of the current WebDriver context, rather
            # than document.title (which is shared by all packaged pages).
            title = session.request("POST", session.endpoint("/execute/async"), {"script": (
                "const done = arguments[arguments.length - 1];"
                "const api = window.__TAURI_INTERNALS__;"
                "api.invoke('plugin:window|title', {label: api.metadata.currentWindow.label})"
                ".then(title => done({title}), error => done({error: String(error)}));"
            ), "args": []})
            if not isinstance(title, dict) or not isinstance(title.get("title"), str) or not title["title"]:
                raise WebDriverError(f"Wayland could not identify the native window title: {title!r}")
            request = {"command": "activate", "application": str(session.application.resolve()),
                       "title": title["title"]}
            if self.data_home:
                request["data_home"] = self.data_home
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(10)
                connection.connect(input_socket)
                connection.sendall(json.dumps(request).encode() + b"\n")
                response = b""
                while not response.endswith(b"\n") and len(response) < 4096:
                    chunk = connection.recv(4096)
                    if not chunk:
                        break
                    response += chunk
            result = json.loads(response)
            if result.get("ok") is not True:
                raise WebDriverError("Wayland desktop did not activate the QA app window: "
                                     + str(result.get("error", "missing acknowledgement")))
        handle = session.request("GET", session.endpoint("/window"))
        if not isinstance(handle, str) or not handle:
            raise WebDriverError("Wayland driver did not return a window handle")
        session.request("POST", session.endpoint("/window"), {"handle": handle})
        end = time.monotonic() + timeout
        while True:
            if session.execute("return document.hasFocus();") is True:
                return
            if time.monotonic() >= end:
                raise WebDriverError("Wayland WebView window did not receive focus")
            time.sleep(0.05)
