"""Restart only this run's owned QA application, retaining its isolated profile."""
from __future__ import annotations

from native_process_group import wait_for_driver_ports


def restart_owned_application(driver, session) -> dict:
    deadline = session.deadline
    before = session.session_id
    application = str(session.application.resolve())
    # close() releases the WebView and its owner; stop() also releases the
    # launcher on macOS/Windows. Neither resets fixtures nor deletes the profile.
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
            "after_session": session.session_id, "profile_retained": True}
