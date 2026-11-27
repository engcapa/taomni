"""Verify signed MFA host recovery after killing an installed Windows/macOS app."""
from __future__ import annotations

from contextlib import contextmanager, suppress
import json
import os
from pathlib import Path
import platform
import re
from types import SimpleNamespace

from installed_desktop_mode_lease import observe_desktop_owner
from installed_macos_host_signature import observe_installed_host
from installed_macos_store import compile_driver, controls, installed_macos_desktop
from installed_windows_host_security import mark_download, observe_downloaded_host
from installed_windows_mfa import installed_windows_desktop, verify_mfa_controls
from modular_bundle_inventory import digest, write_json
from qa_ui_auto.fixtures.module_legacy_mfa import (
    ISSUER, PASSWORD, commit_mfa_upgrade, desktop_action, element, installed_desktop, open_unlocked_mfa,
)
from qa_ui_auto.fixtures.module_marketplace import ORIGIN
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


def observe_abrupt_exit(launcher, executable, module, observation, *, appkit=False):
    import psutil

    if launcher.args != [str(executable.resolve(strict=True))] or launcher.poll() is not None:
        raise RuntimeError("The UI launcher does not own the installed executable")
    core = psutil.Process(launcher.pid)
    process_errors = (psutil.NoSuchProcess, psutil.AccessDenied)
    windows = platform.system() == "Windows"
    host = select_owned_process(core.children(), module, process_errors, direct_child_command=not windows)
    observation.update(
        core={"pid": core.pid, "createdAt": core.create_time(), "executable": str(executable)},
        host={"pid": host.pid, "createdAt": host.create_time(), "executable": str(module), "parent": core.pid},
        termination="TerminateProcess" if windows else "SIGKILL",
        coreIdentity="owned-windows-launch" if windows else ("owned-appkit-launch" if appkit else "owned-wkwebview-launch"),
    )
    if "macosHostExecution" in observation:
        observation["macosHostExecution"]["launched"] = True
    if "windowsHostExecution" in observation:
        observation["windowsHostExecution"]["launched"] = True
    # The running processes are identified by executable, lineage and creation
    # time before the parent is killed. Driver teardown follows the host wait.
    launcher.kill()
    observation["coreExitCode"] = launcher.wait(timeout=10)
    observation["coreExited"] = True
    observation["hostExitCode"] = host.wait(timeout=10)
    observation["hostExitedBeforeDriverCleanup"] = True


@contextmanager
def open_desktop(ctx, executable, work, evidence, label, *, appkit=False):
    if platform.system() == "Windows":
        with installed_windows_desktop(executable, work, evidence, label) as owner:
            yield owner, None
    elif appkit:
        with installed_macos_desktop(executable, work, evidence / label) as owner:
            yield owner, None
    else:
        with installed_desktop(ctx, executable, work, evidence, label, environment={}) as (driver, session):
            yield driver.proc, session


def verify_open_mfa(owner, session, executable, work, evidence, ctx, *, phase, appkit):
    expected = ["287082", "359152"] if phase == "after" else ["287082"]
    if appkit:
        folder = evidence / ("mfa-before-kill" if phase == "before" else "mfa-after-kill")
        receipt = controls(compile_driver(work), owner, executable, f"mfa-{phase}", folder,
                           password=PASSWORD, issuer=ISSUER, codes=expected)
        if receipt.get("codes") != expected or owner.poll() is not None:
            raise RuntimeError("Installed macOS MFA did not return the expected HOTP values")
    elif session is None:
        verify_mfa_controls(owner, phase, evidence)
    else:
        steps = open_unlocked_mfa(ctx, session, evidence)
        account = {"selector": element("mfa-account-code"), "equals": "287 082"}
        desktop_action(steps, "assert_text_equals", account)
        if phase == "after":
            desktop_action(steps, "click", element("mfa-account-hotp-next"))
            desktop_action(steps, "assert_text_equals", {**account, "equals": "359 152"})
            desktop_action(steps, "assert_no_runtime_errors", None)


def installed_mfa(profile, receipt):
    active = profile / "plugins/mfa/active.json"
    installed = json.loads(active.read_text(encoding="utf-8"))
    if installed["activeVersion"] != receipt["version"]:
        raise RuntimeError("The installed MFA version differs from the signed package")
    directory = active.parent / "versions" / receipt["version"]
    if digest(directory / ".taomni-trust/package.taomni-plugin") != receipt["sha256"]:
        raise RuntimeError("The installed MFA package differs from the signed artifact")
    suffix = ".exe" if platform.system() == "Windows" else ""
    module = (directory / f"taomni-plugin-mfa{suffix}").resolve(strict=True)
    if not module.is_relative_to(profile.resolve(strict=True)):
        raise RuntimeError("The installed MFA executable is outside the owned profile")
    return installed, module


def verify_crash_recovery(executable, profile, signed, source, evidence, work, *,
                          macos_hardened_mfa=False, first_release=None):
    if first_release is None:
        version = json.loads((signed / "provenance.json").read_text(encoding="utf-8"))["version"]
        if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", version):
            raise RuntimeError("Invalid MFA version in the signed package receipt")
        receipt, archive, _, _ = load_artifact(signed, source, platform_key(), "mfa", version=version)
    else:
        receipt = first_release.roster["taomni-plugin-mfa"]
        archive = first_release.files["/" + receipt["archive"]]
        if receipt["sourceSha"] != source or first_release.requests.count("/" + archive.name) != 1:
            raise RuntimeError("MFA was not downloaded from the matching first-release roster")
    signature = archive.with_name(receipt["signature"])
    result = {
        "sourceSha": source,
        "installedBinarySha256": digest(executable),
        "modulePackageSha256": receipt["sha256"],
        "passed": False,
    }
    ctx = SimpleNamespace(cfg={"webdriver": {"startup_timeout": 60}})
    system = platform.system()
    appkit = system == "Darwin"
    try:
        downloaded_pointer = None
        if first_release is not None:
            downloaded_pointer, _ = installed_mfa(profile, receipt)
        result["legacyDatabaseSha256"] = digest(profile / "mfa.db")
        version_dir = profile / "plugins/mfa/versions" / receipt["version"]
        stored_proof = version_dir / ".taomni-trust/package.taomni-plugin"
        result["stagedBeforeMigration"] = {
            "versionDirectoryExists": version_dir.is_dir(),
            "signedArchiveSha256": digest(stored_proof) if stored_proof.is_file() else None,
        }
        commit_mfa_upgrade(executable, profile, archive, signature, evidence)
        installed, module = installed_mfa(profile, receipt)
        if downloaded_pointer is not None and installed != downloaded_pointer:
            raise RuntimeError("Migrating MFA changed the downloaded module's active pointer")
        zone = None
        if system == "Darwin":
            result["macosHostExecution"] = observe_installed_host(
                executable, module, evidence, os.environ.get("MACOS_SIGNING_CERT_SHA1", "").upper(),
                require_hardened_core=macos_hardened_mfa,
            )
        elif system == "Windows":
            zone = mark_download(module, ORIGIN, receipt["archive"])
            result["windowsHostExecution"] = {
                "before": observe_downloaded_host(evidence, "before", module, zone), "launched": False,
            }
        with open_desktop(ctx, executable, work, evidence, "mfa-before-kill", appkit=appkit) as (launcher, session):
            verify_open_mfa(launcher, session, executable, work, evidence, ctx, phase="before", appkit=appkit)
            if installed_mfa(profile, receipt) != (installed, module):
                raise RuntimeError("Opening MFA selected a different installed version")
            result.update(moduleBinarySha256=digest(module), hotpBeforeExit="287 082")
            observe_abrupt_exit(launcher, executable, module, result, appkit=appkit)
            if session is not None:
                session.session_id = None
        with open_desktop(ctx, executable, work, evidence, "mfa-after-kill", appkit=appkit) as (launcher, session):
            verify_open_mfa(launcher, session, executable, work, evidence, ctx, phase="after", appkit=appkit)
            if appkit and first_release is None:
                result["desktopModeLease"] = observe_desktop_owner(executable, profile, evidence, launcher)
        if installed_mfa(profile, receipt) != (installed, module) or digest(module) != result["moduleBinarySha256"]:
            raise RuntimeError("Recovery changed the active MFA version or module binary")
        if zone is not None:
            result["windowsHostExecution"]["after"] = observe_downloaded_host(evidence, "after", module, zone)
        result.update(passed=True, hotpAfterReopen="287 082", nextHotp="359 152")
        return result
    finally:
        write_json(evidence / "installed-desktop-mfa-crash.json", result)
