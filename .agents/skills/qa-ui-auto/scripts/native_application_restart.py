"""Restart only this run's owned QA application, retaining its isolated profile."""
from __future__ import annotations

import json
import os
from pathlib import Path
import platform
import subprocess
import time

from native_process_group import wait_for_driver_ports
from native_application_shutdown import linux_storage_processes, wait_for_application_shutdown
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
        return (observation is not None and isinstance(error, (BrokenPipeError, ConnectionResetError))) \
            or any(message in str(error).lower() for message in closed_messages)

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
    observation = {"application": application, "before_session": before,
                   "before_owner_pid": before_owner, "stage": "close-window"}
    session.application_restart_observation = observation
    processes = linux_storage_processes(driver, session.application) if platform.system() == "Linux" else {}
    primary_error = None
    try:
        close_observation = close_application_window(session)
        observation["native_close"] = close_observation
        # The WebView has closed normally. Release transport/ownership without
        # sending DELETE to an already closed browsing context.
        session.session_id = None
        observation["stage"] = "wait-for-application-exit"
        observation["native_shutdown"] = wait_for_application_shutdown(driver, session, processes)
    except Exception as error:
        primary_error = error
        observation["error_stage"] = observation["stage"]
        observation["close_error"] = str(error)
        raise
    finally:
        observation["stage"] = "release-owner"
        release_error = None
        for release in (session.close, driver.stop):
            try:
                release()
            except Exception as error:
                observation.setdefault("cleanup_errors", []).append(str(error))
                if primary_error is not None:
                    primary_error.add_note("Restart cleanup: " + str(error))
                elif release_error is None:
                    release_error = error
        if release_error is not None:
            raise release_error
    # A reaped launcher does not establish that its adapter has released its
    # socket yet. Starting immediately races WebKitWebDriver on Linux.
    ports = (driver.port,) if session.transport == "macOS WKWebView bridge" else (driver.port, driver.native_port)
    observation["stage"] = "wait-for-old-ports"
    wait_for_driver_ports(driver.host, ports)
    driver._restart_required = False
    observation["stage"] = "start-owner"
    driver.start()
    session._on_close = driver.mark_session_closed
    session.deadline = deadline
    observation.update(stage="start-session", after_owner_pid=getattr(getattr(driver, "proc", None), "pid", None))
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
    observation["stage"] = "complete"
    return {"application": application, "before_session": before,
            "after_session": session.session_id, "profile_retained": True,
            "shutdown": "application-window-close",
            "native_shutdown": observation["native_shutdown"],
            **({"before_owner_pid": before_owner, "after_owner_pid": after_owner} if macos_bridge else {}),
            **({"native_close": close_observation} if close_observation else {})}
