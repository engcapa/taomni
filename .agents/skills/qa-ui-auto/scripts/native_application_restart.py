"""Restart only this run's owned QA application, retaining its isolated profile."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import time

from native_process_group import wait_for_driver_ports
from native_webdriver_transport import WebDriverError


def close_macos_application_window(application: Path) -> dict:
    env = dict(os.environ, QA_CLOSE_APPLICATION=str(application.resolve()))
    result = subprocess.run(
        ["osascript", "-l", "JavaScript", str(Path(__file__).with_name("native_window_close_macos.js"))],
        env=env, text=True, capture_output=True, timeout=15,
    )
    if result.returncode:
        raise WebDriverError("Native QA window close failed: " + result.stderr.strip())
    observation = json.loads(result.stdout)
    if observation.get("application") != str(application.resolve()) or not isinstance(observation.get("pid"), int):
        raise WebDriverError("Native window close did not identify the owned QA executable")
    return observation


def close_application_window(session, timeout: float = 15) -> dict | None:
    """Use the production close path before releasing the owned driver tree.

    DELETE-session/kill is teardown, not a normal application close. In
    WebKitGTK it can discard the storage process's most recent transactions.
    Never replace that boundary with a delay or reseed the persisted values.
    """
    closed_messages = ("no such window", "browsing context not found", "invalid session id",
                       "disconnected", "not connected", "connection refused",
                       "remote end closed connection", "failed to connect",
                       "session terminated without a reply")

    def closed(error):
        return any(message in str(error).lower() for message in closed_messages)

    observation = None
    try:
        if session.transport == "macOS WKWebView bridge":
            observation = close_macos_application_window(session.application)
        else:
            session.click('[data-testid="window-close"]')
    except (WebDriverError, OSError) as error:
        if "element click intercepted" in str(error).lower():
            # A transient native overlay can cover the titlebar control while
            # a pane commits its last update. The production close handler is
            # still the boundary; dispatch it on the owned DOM node after the
            # real pointer action was rejected, then verify the context closes.
            try:
                dispatched = session.execute(
                    'const button = document.querySelector("[data-testid=window-close]");'
                    'if (!button) throw new Error("QA application close control is missing");'
                    'button.click(); return true;'
                )
            except (WebDriverError, OSError) as dispatch_error:
                # This is the same close handler: WebKit can terminate its
                # context before returning the script acknowledgement too.
                if closed(dispatch_error):
                    return observation
                raise
            if dispatched is not True:
                raise error
        elif closed(error):
            return observation
        else:
            raise
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if session.deadline:
            session.deadline.remaining()
        try:
            dialog = session.execute(
                'return document.querySelector("[data-testid=confirm-dialog]")?.textContent ?? null;'
            )
        except (WebDriverError, OSError) as error:
            if closed(error):
                return observation
            raise
        if dialog:
            raise RuntimeError("QA application close needs confirmation; handle the exit dialog explicitly before restarting")
        time.sleep(0.05)
    raise RuntimeError("QA application did not close through its window control")


def restart_owned_application(driver, session) -> dict:
    deadline = session.deadline
    before = session.session_id
    macos_bridge = session.transport == "macOS WKWebView bridge"
    before_owner = getattr(getattr(driver, "proc", None), "pid", None)
    application = str(session.application.resolve())
    try:
        close_observation = close_application_window(session)
        # The WebView has closed normally. Release transport/ownership without
        # sending DELETE to an already closed browsing context.
        session.session_id = None
    finally:
        try:
            session.close()
        finally:
            driver.stop()
    # A reaped launcher does not establish that its adapter has released its
    # socket yet. Starting immediately races WebKitWebDriver on Linux.
    ports = (driver.port,) if session.transport == "macOS WKWebView bridge" else (driver.port, driver.native_port)
    wait_for_driver_ports(driver.host, ports)
    driver._restart_required = False
    driver.start()
    session._on_close = driver.mark_session_closed
    session.deadline = deadline
    session.start()
    after_owner = getattr(getattr(driver, "proc", None), "pid", None)
    if not session.session_id:
        raise RuntimeError("QA application restart did not create a new native session")
    if macos_bridge:
        # The in-process bridge deliberately uses one protocol session ID.
        # A different owned launcher PID, after the old bridge socket closed,
        # proves a cold start without treating that constant ID as a reuse.
        if not isinstance(before_owner, int) or not isinstance(after_owner, int) or before_owner == after_owner:
            raise RuntimeError("QA application restart did not create a new owned macOS process")
    elif session.session_id == before:
        raise RuntimeError("QA application restart did not create a new native session")
    return {"application": application, "before_session": before,
            "after_session": session.session_id, "profile_retained": True,
            "shutdown": "application-window-close",
            **({"before_owner_pid": before_owner, "after_owner_pid": after_owner} if macos_bridge else {}),
            **({"native_close": close_observation} if close_observation else {})}
