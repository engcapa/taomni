"""Click the real restore confirmation once and observe its relaunch.

This observer never starts an application or calls the restore/restart IPC.
The QA bridge's POST /session attaches to the already running desktop.
"""
from __future__ import annotations

import os
from pathlib import Path
import platform
import time

import native_macos_process
import native_qa_bridge
from native_macos_process import AdoptedProcess

CONFIRM = '[data-testid="backup-restore-confirm"]'
STATE = """
const dialog = document.querySelector('[data-testid="backup-restore-dialog"]');
const buttons = [...document.querySelectorAll('[data-testid="backup-restore-confirm"]')];
const button = buttons[0];
const rect = button?.getBoundingClientRect();
return {dialog: !!dialog, count: buttons.length, enabled: !!button && !button.disabled,
 visible: !!rect && rect.width > 0 && rect.height > 0,
 staged: !!document.querySelector('[data-testid="backup-restore-staged"]'),
 error: document.querySelector('[data-testid="backup-restore-error"]')?.textContent ?? null};
"""


def process_probe():
    return native_macos_process if platform.system() == "Darwin" else native_qa_bridge


def identity(pid):
    return process_probe().identity(pid)


def environment(pid, keys):
    return process_probe().environment(pid, keys)


def listener_pid(port):
    return process_probe().listener_pid(port)


def expected_environment(driver):
    result = {key: os.environ.get(key, "") for key in (
        "NEWMOB_DATA_DIR", "NEWMOB_CONFIG_DIR", "NEWMOB_CACHE_DIR")}
    for path in result.values():
        if not path or Path(path).resolve() != Path(path) or not Path(path).is_relative_to(driver.report_root.resolve()):
            raise RuntimeError("Automatic relaunch requires exact run-owned QA isolation roots")
    return {**result, "TAOMNI_QA_WEBDRIVER_HOST": driver.host,
            "TAOMNI_QA_WEBDRIVER_PORT": str(driver.port)}


def require_process(pid, application, expected_env):
    current = identity(pid)
    if current is None or Path(current["executable"]).resolve() != application:
        raise RuntimeError("QA bridge listener is not the expected live application")
    if environment(pid, set(expected_env)) != expected_env or identity(pid) != current:
        raise RuntimeError("Relaunched application changed QA isolation or process identity")
    return current


def confirm_restore_relaunch(driver, session):
    observation = {"schema": "taomni.qa.restore-relaunch.v1", "passed": False,
                   "input": "session.click", "selector": CONFIRM,
                   "click_attempted": False, "manual_launch": False, "stage": "preflight"}
    session.restore_relaunch_observation = observation
    if (getattr(session, "transport", None) not in {"Taomni QA WebView bridge", "macOS WKWebView bridge"}
            or driver.macos_lldb):
        raise RuntimeError("Automatic relaunch observation requires a directly owned QA bridge")
    application = session.application.resolve(strict=True)
    expected_env = expected_environment(driver)
    original = driver.proc
    if original is None or original.poll() is not None or listener_pid(driver.port) != original.pid:
        raise RuntimeError("Restore confirmation requires this run's live application/bridge owner")
    before = require_process(original.pid, application, expected_env)
    observation.update(application=str(application), before=before, isolation=expected_env,
                       before_session=session.session_id)
    state = session.execute(STATE)
    observation["before_dialog"] = state
    if state != {"dialog": True, "count": 1, "enabled": True, "visible": True, "staged": False, "error": None}:
        raise RuntimeError("Restore needs one visible enabled confirmation and no earlier staging/error")

    observation["click_attempted"] = True
    observation["stage"] = "click-confirm"
    try:
        session.click(CONFIRM)
    finally:
        observation["click_request"] = dict(getattr(session, "last_request", {}))
    observation["click_returned"] = True
    observation["stage"] = "wait-original-exit"
    end = time.monotonic() + 45
    while original.poll() is None:
        if session.deadline:
            session.deadline.remaining()
        if time.monotonic() >= end:
            raise RuntimeError("Restore confirmation did not automatically exit its original application")
        if "staged_dialog" not in observation:
            state = session.execute(STATE)
            if state.get("error"):
                raise RuntimeError("Restore confirmation reported a staging error")
            if state.get("staged"):
                if state.get("enabled") or state.get("count") != 1:
                    raise RuntimeError("Staged restore still permits a duplicate confirmation")
                observation["staged_dialog"] = state
        time.sleep(.05)
    code = original.wait(timeout=1)
    observation["original_exit_code"] = code
    if code != 0 or "staged_dialog" not in observation:
        raise RuntimeError("Automatic relaunch requires observed staged success and a normal original exit")

    return attach_after_exit(driver, session, application, expected_env, before, observation, end)


def attach_after_exit(driver, session, application, expected_env, before, observation, end):
    # The HTTP/1.1 channel belongs to the exited process even when its child
    # binds the same bridge port and constant session ID. Never reuse it.
    session.discard_connection()
    observation["previous_connection_closed"] = True
    session.session_id = None  # Do not DELETE a restarted app's constant bridge session ID.
    observation["stage"] = "wait-new-listener"
    while time.monotonic() < end:
        if session.deadline:
            session.deadline.remaining()
        pid = listener_pid(driver.port)
        if pid is not None:
            after = require_process(pid, application, expected_env)
            if after == before or after["pid"] == before["pid"]:
                raise RuntimeError("Automatic relaunch did not create a different native application process")
            # Adopt before any WebView request so failure cleanup retains ownership.
            driver.proc = AdoptedProcess(after, inspect=identity)
            session.owned_app_pid = pid
            observation["after"] = after
            observation["stage"] = "attach-existing-process"
            session.start()  # Bind to the restarted application's existing bridge.
            if listener_pid(driver.port) != pid or identity(pid) != after:
                raise RuntimeError("QA process changed while attaching the relaunched WebView")
            observation.update(passed=True, reattached=True, after_session=session.session_id, stage="complete")
            return observation
        time.sleep(.1)
    raise RuntimeError("Automatic relaunch did not restore the owned QA bridge")
