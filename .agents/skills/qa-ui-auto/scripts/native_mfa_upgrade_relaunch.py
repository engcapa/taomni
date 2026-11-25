"""Observe the upgrade's native handoff using the already owned macOS bridge."""
from __future__ import annotations

from contextlib import closing
import hashlib
import json
from pathlib import Path
import platform
import sqlite3
import time

from native_build import QA_APP_ID
from native_macos_process import listener_pid
from native_restore_relaunch import attach_after_exit, expected_environment, require_process
from qa_ui_auto.mfa_relaunch_owner import observe_foreign_executable

CONFIRM = '[data-testid="module-upgrade-mfa-submit"]'
STATE = """
const buttons = [...document.querySelectorAll('[data-testid="module-upgrade-mfa-submit"]')];
const button = buttons[0];
const rect = button?.getBoundingClientRect();
return {count: buttons.length, enabled: !!button && !button.matches(':disabled'),
        visible: !!rect && rect.width > 0 && rect.height > 0};
"""


def profile_root(data_dir):
    root = Path(data_dir)
    return root if root.name == QA_APP_ID else root / QA_APP_ID


def account_rows(path):
    if not path.is_file() or path.resolve() != path:
        raise RuntimeError("MFA upgrade account database is absent or linked")
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as database:
        return database.execute("SELECT id, issuer, counter FROM mfa_accounts ORDER BY id").fetchall()


def verify_commit(root, original):
    journal = json.loads((root / "migration/journal.json").read_text(encoding="utf-8"))
    entries = [row for row in journal["entries"] if row["item"] == "mfa"]
    if len(entries) != 1 or entries[0]["state"] != "committed" or entries[0]["target"] != "plugins/mfa/data/mfa.db":
        raise RuntimeError("The original process did not commit one MFA migration")
    state = json.loads((root / "plugins/state.json").read_text(encoding="utf-8"))
    if state.get("mfa") is not True:
        raise RuntimeError("The committed profile did not enable the signed module")
    if account_rows(root / "mfa.db") != original or account_rows(root / entries[0]["target"]) != original:
        raise RuntimeError("Original or migrated MFA account metadata and counter changed")
    return {"account_count": len(original), "counter": original[0][2], "module_enabled": True,
            "journal_state": entries[0]["state"]}


def executable_digest(application):
    with application.open("rb") as binary:
        return hashlib.file_digest(binary, "sha256").hexdigest()


def confirm_mfa_upgrade_relaunch(driver, session, *, expected_issuer):
    observed = {"schema": "taomni.qa.mfa-upgrade-relaunch.v1", "passed": False,
                "stage": "preflight", "manual_launch": False, "click_attempted": False}
    session.mfa_upgrade_relaunch_observation = observed
    if platform.system() != "Darwin" or session.transport != "macOS WKWebView bridge" or driver.macos_lldb:
        raise RuntimeError("MFA upgrade relaunch needs the directly owned macOS QA bridge")
    application = session.application.resolve(strict=True)
    expected_env = expected_environment(driver)
    original = driver.proc
    if original is None or original.poll() is not None or listener_pid(driver.port) != original.pid:
        raise RuntimeError("MFA upgrade requires this run's live application")
    before = require_process(original.pid, application, expected_env)
    observed.update(application=str(application), before=before, isolation=expected_env,
                    before_session=session.session_id)
    state = session.execute(STATE)
    observed["before_confirmation"] = state
    if state.get("count") != 1 or not state.get("visible") or not state.get("enabled"):
        raise RuntimeError("MFA upgrade needs one visible enabled confirmation")
    root = profile_root(expected_env["NEWMOB_DATA_DIR"])
    accounts = account_rows(root / "mfa.db")
    if len(accounts) != 1 or accounts[0][1:] != (expected_issuer, 1):
        raise RuntimeError("MFA upgrade needs the original counter-one test account")
    observed["stage"] = "verify-executable-guard"
    guard = observe_foreign_executable(application, root, driver.report_root)
    observed["foreign_executable"] = guard
    if not guard["rejected"]:
        raise RuntimeError("The MFA upgrade helper did not reject a different executable")
    observed["binary_sha256"] = executable_digest(application)

    observed.update(stage="click-confirm", click_attempted=True)
    try:
        session.click(CONFIRM)
    finally:
        observed["click_request"] = dict(getattr(session, "last_request", {}))
    observed["click_returned"] = True
    end = time.monotonic() + 90
    observed["stage"] = "wait-original-exit"
    while original.poll() is None:
        if session.deadline:
            session.deadline.remaining()
        if time.monotonic() >= end:
            raise RuntimeError("MFA confirmation did not exit its original application")
        time.sleep(.05)
    code = original.wait(timeout=1)
    observed["original_exit_code"] = code
    if code != 0:
        raise RuntimeError("MFA upgrade requires a normal original exit")
    attach_after_exit(driver, session, application, expected_env, before, observed, end)
    observed.update(stage="verify-committed-data", passed=False)
    if executable_digest(application) != observed["binary_sha256"]:
        raise RuntimeError("The same core executable must own both sides of the relaunch")
    observed["committed_data"] = verify_commit(root, accounts)
    observed.update(stage="complete", passed=True)
    return observed
