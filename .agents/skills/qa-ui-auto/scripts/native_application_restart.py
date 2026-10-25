"""Restart only this run's owned QA application, retaining its isolated profile."""
from __future__ import annotations

import time

from native_process_group import wait_for_driver_ports
from native_webdriver_transport import WebDriverError


def close_application_window(session, timeout: float = 15) -> None:
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

    try:
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
                    return
                raise
            if dispatched is not True:
                raise error
        elif closed(error):
            return
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
                return
            raise
        if dialog:
            raise RuntimeError("QA application close needs confirmation; handle the exit dialog explicitly before restarting")
        time.sleep(0.05)
    raise RuntimeError("QA application did not close through its window control")


def restart_owned_application(driver, session) -> dict:
    deadline = session.deadline
    before = session.session_id
    application = str(session.application.resolve())
    try:
        close_application_window(session)
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
    if not session.session_id or session.session_id == before:
        raise RuntimeError("QA application restart did not create a new native session")
    return {"application": application, "before_session": before,
            "after_session": session.session_id, "profile_retained": True,
            "shutdown": "application-window-close"}
