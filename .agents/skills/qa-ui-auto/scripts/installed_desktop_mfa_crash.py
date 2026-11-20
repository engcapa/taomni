"""Verify signed MFA host recovery after killing an installed Windows/macOS app."""
from __future__ import annotations

from contextlib import suppress
import json
from pathlib import Path
import platform
from types import SimpleNamespace

from modular_bundle_inventory import digest, write_json
from qa_ui_auto.fixtures.module_legacy_mfa import (
    create_account, desktop_action, element, installed_desktop, open_unlocked_mfa,
)
from qa_ui_auto.fixtures.module_signed_archive import load_artifact, platform_key
from qa_ui_auto.native_steps import NativeStepContext


def install_module(steps, archive, signature):
    desktop_action(steps, "wait_for", element("welcome-panel"))
    desktop_action(steps, "click", element("ribbon-settings"))
    desktop_action(steps, "wait_for", element("settings-panel"))
    desktop_action(steps, "fill", {"selector": element("settings-search-input"), "value": "module store"})
    desktop_action(steps, "wait_for", element("module-offline-install"))
    desktop_action(steps, "fill", {"selector": element("module-offline-archive"), "value": str(archive)})
    desktop_action(steps, "fill", {"selector": element("module-offline-signature"), "value": signature})
    desktop_action(steps, "press", {"selector": element("module-offline-submit"), "key": "Enter"})
    desktop_action(steps, "wait_for", element("module-offline-install") + '[data-phase="completed"]')
    desktop_action(steps, "press", {"selector": element("module-action-enable-mfa") + ":not([disabled])", "key": "Enter"})
    desktop_action(steps, "wait_for", element("module-action-disable-mfa"))
    desktop_action(steps, "click", element("nav-mode-home"))


def select_owned_process(processes, executable, process_errors):
    matching = []
    for process in processes:
        with suppress(*process_errors):
            path = process.exe()
            if path and Path(path).resolve() == executable:
                matching.append(process)
    if len(matching) != 1:
        raise RuntimeError(f"Expected exactly one owned process for {executable.name}")
    return matching[0]


def observe_abrupt_exit(driver, executable, module, observation):
    import psutil

    root = psutil.Process(driver.proc.pid)
    process_errors = (psutil.NoSuchProcess, psutil.AccessDenied)
    core = select_owned_process(
        [root, *root.children(recursive=True)], executable, process_errors,
    )
    host = select_owned_process(core.children(), module, process_errors)
    observation.update(
        core={"pid": core.pid, "createdAt": core.create_time(), "executable": str(executable)},
        host={"pid": host.pid, "createdAt": host.create_time(), "executable": str(module), "parent": core.pid},
        termination="TerminateProcess" if platform.system() == "Windows" else "SIGKILL",
    )
    # The running processes are identified by executable, lineage and creation
    # time before the parent is killed. Driver teardown follows the host wait.
    core.kill()
    observation["coreExitCode"] = core.wait(timeout=10)
    observation["coreExited"] = True
    observation["hostExitCode"] = host.wait(timeout=10)
    observation["hostExitedBeforeDriverCleanup"] = True


def verify_crash_recovery(executable, profile, signed, source, evidence):
    receipt, archive, signature, _ = load_artifact(signed, source, platform_key(), "mfa")
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
        with installed_desktop(ctx, executable, evidence, evidence, "mfa-before-kill", environment={}) as (driver, session):
            install_module(NativeStepContext(session, evidence, ctx.cfg), archive, signature)
            create_account(session, ctx, evidence)
            active = json.loads(active_path.read_text(encoding="utf-8"))
            if active["activeVersion"] != receipt["version"]:
                raise RuntimeError("The installed MFA version differs from the signed package")
            directory = active_path.parent / "versions" / receipt["version"]
            if digest(directory / ".taomni-trust/package.taomni-plugin") != receipt["sha256"]:
                raise RuntimeError("The installed MFA package differs from the signed artifact")
            suffix = ".exe" if platform.system() == "Windows" else ""
            module = (directory / f"taomni-plugin-mfa{suffix}").resolve(strict=True)
            result.update(moduleBinarySha256=digest(module), hotpBeforeExit=account["equals"])
            observe_abrupt_exit(driver, executable, module, result)
            session.session_id = None
        with installed_desktop(ctx, executable, evidence, evidence, "mfa-after-kill", environment={}) as (_, session):
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
