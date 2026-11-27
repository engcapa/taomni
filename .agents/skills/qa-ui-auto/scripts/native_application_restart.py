"""Restart only this run's owned QA application, retaining its isolated profile."""
from __future__ import annotations

from collections.abc import Callable
from functools import partial
import json
import os
from pathlib import Path
import platform
import subprocess
import time
from typing import TypedDict

from native_process_group import wait_for_driver_ports
from native_application_shutdown import (
    ApplicationShutdownTimeout, linux_storage_processes, wait_for_application_shutdown,
)
from native_webdriver_transport import WebDriverError
from native_restart_failure import capture as capture_restart_failure
from native_window_close_x11 import close_x11_application_window, x11_window_closed


class ExitConfirmation(TypedDict):
    title: str
    message: str
    confirm_label: str


CONFIRM_SELECTOR = '[data-testid="confirm-dialog"] [data-testid="confirm-dialog-confirm"]'
KEEP_DRAFT_SELECTOR = '[data-testid="viewer-close-dialog"] [data-testid="viewer-close-keep-draft"]'
DIALOG_NAME = r"""
const title = (dialog.getAttribute('aria-labelledby') || '').trim().split(/\s+/)
  .filter(Boolean).map(id => document.getElementById(id)?.textContent.trim() || '').filter(Boolean).join(' ')
  || dialog.getAttribute('aria-label') || '';
"""
EXIT_DIALOG_OBSERVATION = """
const visible = el => {
  if (!el) return false;
  const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.display !== 'none'
    && style.visibility !== 'hidden' && style.visibility !== 'collapse' && Number(style.opacity) !== 0;
};
const dialogs = [...document.querySelectorAll('[data-testid="confirm-dialog"]')].filter(visible);
if (!dialogs.length) return null;
const dialog = dialogs[0];
""" + DIALOG_NAME + """
const buttons = dialog.querySelectorAll('[data-testid="confirm-dialog-confirm"]');
const button = buttons[0];
return {
  count: dialogs.length,
  title,
  message: dialog.querySelector('[data-testid="confirm-dialog-message"]')?.textContent?.trim() ?? '',
  confirm_label: button?.textContent?.trim() ?? '',
  confirm_count: buttons.length,
  confirm_visible: visible(button),
  confirm_enabled: !!button && !button.disabled && button.getAttribute('aria-disabled') !== 'true'
};
"""
VIEWER_CLOSE_DIALOG_OBSERVATION = """
const visible = el => {
  if (!el) return false;
  const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.display !== 'none'
    && style.visibility !== 'hidden' && style.visibility !== 'collapse' && Number(style.opacity) !== 0;
};
const dialogs = [...document.querySelectorAll('[data-testid="viewer-close-dialog"]')].filter(visible);
if (!dialogs.length) return null;
const dialog = dialogs[0];
""" + DIALOG_NAME + """
const buttons = dialog.querySelectorAll('[data-testid="viewer-close-keep-draft"]');
const button = buttons[0];
return {
  count: dialogs.length,
  title,
  paths: [...dialog.querySelectorAll('p span')].map((node) => node.textContent?.trim() ?? ''),
  keep_count: buttons.length,
  keep_label: button?.textContent?.trim() ?? '',
  keep_visible: visible(button),
  keep_enabled: !!button && !button.disabled && button.getAttribute('aria-disabled') !== 'true'
};
"""


def validate_exit_confirmation(value: object) -> ExitConfirmation:
    fields = {"title", "message", "confirm_label"}
    if not isinstance(value, dict) or set(value) != fields or any(
        not isinstance(value.get(field), str) or not value[field].strip() for field in fields
    ):
        raise ValueError("expect_exit_confirmation requires exactly nonempty title, message and confirm_label strings")
    return ExitConfirmation(title=value["title"], message=value["message"], confirm_label=value["confirm_label"])


def bind_application_restarter(driver, session) -> None:
    session.application_restarter = partial(restart_owned_application, driver, session)
    from native_restore_relaunch import confirm_restore_relaunch
    from native_mfa_upgrade_relaunch import confirm_mfa_upgrade_relaunch
    session.restore_relauncher = partial(confirm_restore_relaunch, driver, session)
    session.mfa_upgrade_relauncher = partial(confirm_mfa_upgrade_relaunch, driver, session)


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


def uses_x11_window_close() -> bool:
    return (platform.system() == "Linux" and not os.environ.get("WAYLAND_DISPLAY")
            and os.environ.get("XDG_SESSION_TYPE", "").lower() != "wayland")


def close_application_window(session, timeout: float = 15,
                             processes: dict[int, str] | None = None, *,
                             expect_exit_confirmation: ExitConfirmation | None = None,
                             preserve_dirty_drafts: bool = False) -> dict | None:
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

    confirmation = None
    draft_confirmation = None
    if expect_exit_confirmation is not None:
        expected = validate_exit_confirmation(expect_exit_confirmation)
        confirmation = {"expected": expected, "selector": CONFIRM_SELECTOR,
                        "input": "session.click", "click_attempted": False,
                        "click_returned": False, "closed_after_confirmation": False,
                        "status": "waiting"}
        if not isinstance(getattr(session, "application_restart_observation", None), dict):
            session.application_restart_observation = {}
        session.application_restart_observation["exit_confirmation"] = confirmation
        # Never approve a dialog left by an earlier action (delete, backup, etc.).
        confirmation["before_close"] = session.execute(EXIT_DIALOG_OBSERVATION)
        if confirmation["before_close"] is not None:
            raise RuntimeError("QA application exit confirmation was already open before the close request")
    if preserve_dirty_drafts:
        draft_confirmation = {"selector": KEEP_DRAFT_SELECTOR,
                              "input": "session.click", "click_attempted": False,
                              "click_returned": False, "closed_after_confirmation": False,
                              "status": "waiting"}
        if not isinstance(getattr(session, "application_restart_observation", None), dict):
            session.application_restart_observation = {}
        session.application_restart_observation["viewer_close"] = draft_confirmation
        # A pre-existing viewer close prompt belongs to an earlier action and
        # must never be approved as part of this restart request.
        draft_confirmation["before_close"] = session.execute(VIEWER_CLOSE_DIALOG_OBSERVATION)
        if draft_confirmation["before_close"] is not None:
            raise RuntimeError("QA viewer close dialog was already open before the close request")

    def observed_close():
        if confirmation is not None:
            if not confirmation["click_attempted"]:
                raise RuntimeError("QA application closed without the expected exit confirmation")
            confirmation.update(closed_after_confirmation=True, status="closed")
        if draft_confirmation is not None:
            if not draft_confirmation["click_attempted"]:
                raise RuntimeError("QA application closed without preserving dirty drafts")
            draft_confirmation.update(closed_after_confirmation=True, status="closed")
        return observation

    observation = None
    try:
        if session.transport == "macOS WKWebView bridge":
            observation = close_macos_application_window(session.application)
        elif processes is not None and uses_x11_window_close():
            observation = close_x11_application_window(session.application, processes)
            # Preserve independent native evidence even if WebDriver loses its
            # reply while the normal close handler destroys the WebView.
            session.application_restart_observation["native_close"] = observation
        else:
            session.click('[data-testid="window-close"]')
    except (WebDriverError, OSError) as error:
        if closed(error):
            return observed_close()
        # Interception/uncertain input stays a failure, never a synthetic click.
        raise
    native_x11 = observation is not None and observation.get("transport") == "X11 window-manager close"
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if session.deadline:
            session.deadline.remaining()
        if native_x11 and observation is not None and x11_window_closed(observation):
            return observed_close()
        try:
            kind = None
            dialog = None
            if confirmation is not None:
                dialog = session.execute(EXIT_DIALOG_OBSERVATION)
                if dialog:
                    kind = "exit"
            if not dialog and draft_confirmation is not None:
                dialog = session.execute(VIEWER_CLOSE_DIALOG_OBSERVATION)
                if dialog:
                    kind = "viewer"
            if not dialog and confirmation is None:
                unexpected = session.execute('return document.querySelector("[data-testid=confirm-dialog]")?.textContent ?? null;')
                if unexpected:
                    kind = "unexpected"
                    dialog = unexpected
        except (WebDriverError, OSError) as error:
            if native_x11 and observation is not None:
                # No transport error proves closure. Observe this exact XID
                # independently, without replaying input or killing its owner.
                observation["webdriver_close_error"] = str(error)
                time.sleep(0.05)
                continue
            if closed(error):
                return observed_close()
            raise
        if dialog:
            if kind == "unexpected":
                raise RuntimeError("QA application close needs confirmation; declare expect_exit_confirmation explicitly before restarting")
            record = confirmation if kind == "exit" else draft_confirmation
            if record is None:
                raise RuntimeError("QA application close produced an unsupported confirmation dialog")
            record["observed"] = dialog
            if record["click_attempted"]:
                # It may still be the clicked dialog while React commits; only
                # observe it. Any replacement prompt must fail without a click.
                if record.get("dialog_dismissed") or dialog != record["clicked_dialog"]:
                    raise RuntimeError("QA application showed another confirmation after the exit confirmation")
            else:
                if kind == "exit":
                    if not isinstance(dialog, dict) or any(dialog.get(key) != value for key, value in expected.items()):
                        raise RuntimeError("QA application exit confirmation did not match the expected title, message and confirm label")
                    if (dialog.get("count") != 1 or dialog.get("confirm_count") != 1
                            or dialog.get("confirm_visible") is not True or dialog.get("confirm_enabled") is not True):
                        raise RuntimeError("QA application exit confirmation must have one visible enabled confirm button")
                    selector = CONFIRM_SELECTOR
                else:
                    if (not isinstance(dialog, dict) or dialog.get("count") != 1
                            or dialog.get("keep_count") != 1 or dialog.get("keep_visible") is not True
                            or dialog.get("keep_enabled") is not True):
                        raise RuntimeError("QA viewer close dialog must have one visible enabled keep-draft button")
                    selector = KEEP_DRAFT_SELECTOR
                record.update(click_attempted=True, clicked_dialog=dict(dialog), status="clicking")
                try:
                    session.click(selector)
                except (WebDriverError, OSError) as error:
                    record["click_error"] = str(error)
                    request = getattr(session, "last_request", {})
                    action_attempted = (request.get("method") in {"POST", "DELETE"}
                                        and str(request.get("path", "")).endswith("/actions")
                                        and (request.get("phase") in {"response_headers", "response_body",
                                                                      "decode_response", "complete"}
                                             or (request.get("method") == "DELETE" and request.get("phase") == "send_request")))
                    if not closed(error) or not action_attempted:
                        raise
                    # Only an action/release reply may be lost as the clicked
                    # WebView closes. A lost preparation read is not input proof.
                    # Never replay it; still require closure and normal shutdown.
                else:
                    record["click_returned"] = True
                finally:
                    record["click_request"] = dict(getattr(session, "last_request", {}))
                record["status"] = "waiting-for-close"
        else:
            if confirmation is not None and confirmation["click_attempted"]:
                confirmation["dialog_dismissed"] = True
            if draft_confirmation is not None and draft_confirmation["click_attempted"]:
                draft_confirmation["dialog_dismissed"] = True
        time.sleep(0.05)
    raise RuntimeError("QA application did not close through its window control")


def restart_owned_application(driver, session, *,
                              expect_exit_confirmation: ExitConfirmation | None = None,
                              preserve_dirty_drafts: bool = False,
                              before_relaunch: Callable[[], None] | None = None) -> dict:
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
        close_observation = close_application_window(session, processes=processes,
            expect_exit_confirmation=expect_exit_confirmation,
            preserve_dirty_drafts=preserve_dirty_drafts)
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
        if isinstance(error, ApplicationShutdownTimeout):
            observation["shutdown_remaining_processes"] = error.processes
        observation["close_request"] = dict(getattr(session, "last_request", {}))
        # Session deletion/driver.stop removes the failed window. Capture it
        # now so the runner can diagnose a blocked close without losing DOM.
        capture_restart_failure(session, observation)
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
    observation["driver_port_release"] = wait_for_driver_ports(driver.host, ports)
    if before_relaunch is not None:
        observation["stage"] = "before-relaunch"
        before_relaunch()
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
    if "exit_confirmation" in observation:
        observation["exit_confirmation"]["status"] = "verified"
    if "viewer_close" in observation:
        observation["viewer_close"]["status"] = "verified"
    return {"application": application, "before_session": before,
            "after_session": session.session_id, "profile_retained": True,
            "shutdown": "application-window-close",
            "native_shutdown": observation["native_shutdown"],
            **({"exit_confirmation": observation["exit_confirmation"]} if "exit_confirmation" in observation else {}),
            **({"viewer_close": observation["viewer_close"]} if "viewer_close" in observation else {}),
            **({"driver_port_release": observation["driver_port_release"]} if observation["driver_port_release"] else {}),
            **({"before_owner_pid": before_owner, "after_owner_pid": after_owner} if macos_bridge else {}),
            **({"native_close": close_observation} if close_observation else {})}
