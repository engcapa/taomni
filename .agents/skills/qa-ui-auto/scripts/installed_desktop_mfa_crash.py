"""Verify signed MFA host recovery after killing an installed Windows/macOS app."""
from __future__ import annotations

from contextlib import suppress
import json
import os
from pathlib import Path
import platform
from types import SimpleNamespace

from installed_macos_host_signature import observe_hardened_host
from modular_bundle_inventory import digest, write_json
from qa_ui_auto.fixtures.module_legacy_mfa import (
    commit_mfa_upgrade, create_account, desktop_action, element, installed_desktop, open_unlocked_mfa,
)
from qa_ui_auto.fixtures.module_signed_archive import load_artifact, platform_key


def select_owned_process(processes, executable, process_errors, *, direct_child_command=False):
    expected = executable.resolve(strict=False)
    matching = []
    for process in processes:
        path = None
        with suppress(*process_errors):
            path = process.exe()
        if not path and direct_child_command:
            with suppress(*process_errors):
                command = process.cmdline()
                path = command[0] if command else None
        if path and Path(path).is_absolute() and Path(path).resolve() == expected:
            matching.append(process)
    if len(matching) != 1:
        raise RuntimeError(f"Expected exactly one owned process for {executable.name}")
    return matching[0]


def observe_abrupt_exit(driver, executable, module, observation):
    import psutil

    launcher = driver.proc
    root = psutil.Process(launcher.pid)
    process_errors = (psutil.NoSuchProcess, psutil.AccessDenied)
    direct = platform.system() == "Darwin"
    if direct:
        # The WKWebView bridge is in the exact executable this runner launched.
        # macOS can restrict inspection of a hardened process's executable.
        if launcher.args != [str(executable.resolve(strict=True))] or launcher.poll() is not None:
            raise RuntimeError("The macOS bridge launcher does not own the installed executable")
        core = root
        owner = launcher
    else:
        core = select_owned_process([root, *root.children(recursive=True)], executable, process_errors)
        owner = core
    host = select_owned_process(core.children(), module, process_errors, direct_child_command=direct)
    observation.update(
        core={"pid": core.pid, "createdAt": core.create_time(), "executable": str(executable)},
        host={"pid": host.pid, "createdAt": host.create_time(), "executable": str(module), "parent": core.pid},
        termination="TerminateProcess" if platform.system() == "Windows" else "SIGKILL",
        coreIdentity="owned-wkwebview-launch" if direct else "owned-driver-descendant",
    )
    if "macosHostExecution" in observation:
        observation["macosHostExecution"]["launched"] = True
    # The running processes are identified by executable, lineage and creation
    # time before the parent is killed. Driver teardown follows the host wait.
    owner.kill()
    observation["coreExitCode"] = owner.wait(timeout=10)
    observation["coreExited"] = True
    observation["hostExitCode"] = host.wait(timeout=10)
    observation["hostExitedBeforeDriverCleanup"] = True


def verify_crash_recovery(executable, profile, signed, source, evidence, work, *, macos_hardened_mfa=False):
    receipt, archive, _, _ = load_artifact(signed, source, platform_key(), "mfa")
    signature = archive.with_name(receipt["signature"])
    result = {
        "sourceSha": source,
        "installedBinarySha256": digest(executable),
        "modulePackageSha256": receipt["sha256"],
        "passed": False,
    }
    ctx = SimpleNamespace(cfg={"webdriver": {"startup_timeout": 60}})
    active_path = profile / "plugins/mfa/active.json"
    account = {"selector": element("mfa-account-code"), "equals": "287 082"}
    try:
        environment = {}
        if platform.system() == "Windows":
            webview = work / "mfa-webview"
            webview.mkdir()
            environment["TAOMNI_QA_WEBVIEW_DIR"] = str(webview)
            environment["WEBVIEW2_USER_DATA_FOLDER"] = str(webview)
            result["webviewDataFolder"] = str(webview)
        with installed_desktop(ctx, executable, work, evidence, "mfa-legacy-seed", environment=environment) as (_, session):
            create_account(session, ctx, evidence)
        result["legacyDatabaseSha256"] = digest(profile / "mfa.db")
        commit_mfa_upgrade(executable, profile, archive, signature, evidence)
        installed = json.loads(active_path.read_text(encoding="utf-8"))
        if installed["activeVersion"] != receipt["version"]:
            raise RuntimeError("The installed MFA version differs from the signed package")
        directory = active_path.parent / "versions" / receipt["version"]
        if digest(directory / ".taomni-trust/package.taomni-plugin") != receipt["sha256"]:
            raise RuntimeError("The installed MFA package differs from the signed artifact")
        suffix = ".exe" if platform.system() == "Windows" else ""
        module = (directory / f"taomni-plugin-mfa{suffix}").resolve(strict=True)
        if not module.is_relative_to(profile.resolve(strict=True)):
            raise RuntimeError("The installed MFA executable is outside the owned profile")
        if macos_hardened_mfa:
            result["macosHostExecution"] = observe_hardened_host(
                executable, module, evidence, os.environ.get("MACOS_SIGNING_CERT_SHA1", "").upper(),
            )
        with installed_desktop(ctx, executable, work, evidence, "mfa-before-kill", environment=environment) as (driver, session):
            steps = open_unlocked_mfa(ctx, session, evidence)
            desktop_action(steps, "assert_text_equals", account)
            active = json.loads(active_path.read_text(encoding="utf-8"))
            if active["activeVersion"] != installed["activeVersion"]:
                raise RuntimeError("Opening MFA selected a different installed version")
            result.update(moduleBinarySha256=digest(module), hotpBeforeExit=account["equals"])
            observe_abrupt_exit(driver, executable, module, result)
            session.session_id = None
        with installed_desktop(ctx, executable, work, evidence, "mfa-after-kill", environment=environment) as (_, session):
            steps = open_unlocked_mfa(ctx, session, evidence)
            desktop_action(steps, "assert_text_equals", account)
            desktop_action(steps, "click", element("mfa-account-hotp-next"))
            desktop_action(steps, "assert_text_equals", {**account, "equals": "359 152"})
            desktop_action(steps, "assert_no_runtime_errors", None)
        if json.loads(active_path.read_text(encoding="utf-8")) != active or digest(module) != result["moduleBinarySha256"]:
            raise RuntimeError("Recovery changed the active MFA version or module binary")
        result.update(passed=True, hotpAfterReopen=account["equals"], nextHotp="359 152")
        return result
    finally:
        write_json(evidence / "installed-desktop-mfa-crash.json", result)
