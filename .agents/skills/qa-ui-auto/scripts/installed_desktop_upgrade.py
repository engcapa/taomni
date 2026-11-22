"""Replace actual MSI/DMG installs and reopen the same versioned profile."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
from uuid import UUID
from types import SimpleNamespace

import installed_first_release

from installed_desktop_mfa_crash import verify_crash_recovery
from installed_desktop_mode_lease import check_mode_lease, reserve_default_profile
from installed_macos_permissions import compare_permissions, observe_hosted_screen_scan, observe_permissions
from modular_bundle_inventory import digest, inventory, write_json
from qa_ui_auto.fixtures.module_legacy_install import insert_business_rows, retained_manifest, session_rows
from qa_ui_auto.fixtures.module_legacy_mfa import seed_legacy_desktop
from qa_ui_auto.fixtures.module_signed_archive import platform_key
from qa_ui_auto.fixtures.module_upgrade import input_sessions
from qa_ui_auto.legacy_install import command, macos_install, windows_install
from qa_ui_auto.legacy_process import initialize_profile
from qa_ui_auto.legacy_release import FIRST_UPGRADE_VERSION, RELEASE_VERSION, selected_asset, verify_asset


def install(package, slot, evidence, version):
    evidence.mkdir()
    adapter = windows_install if platform.system() == "Windows" else macos_install
    executable, details = adapter(package, slot, evidence, version=version)
    if executable.is_symlink() or not executable.is_file() or not executable.resolve().is_relative_to(slot):
        raise RuntimeError("Installed executable is not in the run-owned application slot")
    return executable, {**details, "packageSha256": digest(package), "binarySha256": digest(executable)}


def msi_registration(package, evidence, label):
    script = Path(__file__).with_name("modular_msi_registration.ps1")
    result = command(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                      "-File", str(script), "-Package", str(package)], evidence, label)
    return json.loads(result.stdout.decode("utf-8-sig"))


def require_registration(old, candidate, *, upgraded):
    if UUID(old["ProductCode"]) == UUID(candidate["ProductCode"]) or UUID(old["UpgradeCode"]) != UUID(candidate["UpgradeCode"]):
        raise RuntimeError("Original and candidate MSI registrations are not versions of the same upgrade family")
    if (old["InstalledState"] == 5, candidate["InstalledState"] == 5) != (not upgraded, upgraded):
        raise RuntimeError("Windows Installer did not register exactly the expected installed version")


def start_profile(executable, profile, work, evidence, label, expected_rows, retained=None, *, verify_mode_lease=False):
    process = initialize_profile(executable, profile, work, evidence, label, verify_mode_lease=verify_mode_lease)
    if session_rows(profile) != expected_rows:
        raise RuntimeError(f"{label} did not reopen the original SSH/VNC records")
    observed = retained_manifest(profile)
    if retained is not None and observed != retained:
        raise RuntimeError(f"{label} changed the original historical chat files")
    return {"executable": str(executable), "profile": str(profile), "process": process, "retainedFiles": observed}


def select_candidate(directory, identity):
    observed = inventory(directory, identity)
    suffix = ".msi" if identity["target"].startswith("windows-") else ".dmg"
    members = [item["name"] for item in observed["files"] if item["name"].endswith(suffix)]
    if len(members) != 1:
        raise RuntimeError(f"Expected exactly one release {suffix} installer")
    return directory / members[0], observed


def exercise_desktop_contracts(candidate, desktop_profile, stages, args, identity, work, report, permission_failure):
    system = platform.system()
    stages["desktopAndHeadlessModeLease"] = check_mode_lease(candidate, work, report, profile=desktop_profile)
    if system == "Darwin":
        try:
            stages["candidatePermissions"] = observe_permissions(candidate, report, "candidate")
            if permission_failure is None:
                stages["permissionContinuity"] = compare_permissions(
                    stages["originalPermissions"], stages["candidatePermissions"],
                )
        except Exception as error:
            permission_failure = permission_failure or error
            stages["candidatePermissions"] = {"error": str(error)}
    recovery_failure = None
    try:
        stages["crashRecovery"] = verify_crash_recovery(
            candidate, Path(stages["desktopAndHeadlessModeLease"]["profile"]),
            args.signed.resolve(strict=True), identity["producerSource"], report, work,
            macos_hardened_mfa=args.macos_hardened_mfa,
        )
    except Exception as error:
        # Preserve rollback evidence after the hosted crash scenario fails.
        recovery_failure = error
        stages["crashRecovery"] = {"passed": False, "error": str(error)}

    if args.macos_hardened_mfa and recovery_failure is None:
        try:
            stages["mfaScreenScan"] = observe_hosted_screen_scan(candidate, report, stages["crashRecovery"])
        except Exception as error:
            permission_failure = permission_failure or error
            stages["mfaScreenScan"] = {"passed": False, "error": str(error)}
    return recovery_failure, permission_failure


def execute(args):
    system = platform.system()
    if (system not in {"Windows", "Darwin"} or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"
            or os.environ.get("GITHUB_REPOSITORY") != "engcapa/taomni"):
        raise RuntimeError("Actual installer replacement requires its owned GitHub-hosted runner")
    identity = json.loads(args.identity.read_text(encoding="utf-8"))
    version = identity["version"]
    old_version = FIRST_UPGRADE_VERSION if args.first_release else RELEASE_VERSION
    if identity["target"] != platform_key() or version == old_version:
        raise RuntimeError("Choose a candidate package for this platform and a distinct version")
    package, observed = select_candidate(args.candidate.resolve(strict=True), identity)
    pinned = selected_asset(version=old_version)
    old_package = args.legacy.resolve(strict=True) / pinned.name
    verify_asset(old_package, pinned)
    report, work = args.evidence.resolve(), args.work.resolve()
    report.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=False)
    slot, profile = work / "Applications", work / "profile"
    slot.mkdir()
    if args.first_release:
        profile = reserve_default_profile(report)
    else:
        profile.mkdir()
    write_json(report / "installed-bundle-inventory.json", observed)
    result = {"passed": False, "target": identity["target"], "producerSource": identity["producerSource"],
              "originalVersion": old_version, "candidateVersion": version, "stages": {}}
    stages = result["stages"]
    desktop_profile = None
    permission_failure = None
    origin = None
    ctx = SimpleNamespace(cfg={"webdriver": {"startup_timeout": 60}})
    environment = {}
    try:
        if args.first_release:
            origin = installed_first_release.open_release(args.first_release.resolve(strict=True), identity, report)
            if system == "Windows":
                webview = str(work / "webview")
                environment = {"WEBVIEW2_USER_DATA_FOLDER": webview}
        old_binary, stages["original"] = install(old_package, slot, report / "original", old_version)
        initialize_profile(old_binary, profile, work, report, "original-start")
        insert_business_rows(profile, input_sessions(True))
        expected_rows = session_rows(profile)
        if origin:
            seed_legacy_desktop(ctx, old_binary, work / "desktop", report, profile,
                                catalog_source=f"{installed_first_release.ORIGIN}/{origin.start_catalog}",
                                environment=environment)
        stages["beforeUpgrade"] = start_profile(old_binary, profile, work, report, "original-reopen", expected_rows)
        retained = stages["beforeUpgrade"]["retainedFiles"]
        if system == "Windows":
            require_registration(msi_registration(old_package, report, "original-registered"),
                                 msi_registration(package, report, "candidate-before-install"), upgraded=False)
        elif not origin:
            desktop_profile = reserve_default_profile(report)
            try:
                stages["originalPermissions"] = observe_permissions(old_binary, report, "original")
            except Exception as error:
                permission_failure = error
                stages["originalPermissions"] = {"error": str(error)}
        if system == "Darwin":
            old_binary.parents[2].rename(work / "original.app")

        candidate, stages["candidate"] = install(package, slot, report / "candidate", version)
        if candidate != old_binary or stages["candidate"]["binarySha256"] == stages["original"]["binarySha256"]:
            raise RuntimeError("Candidate did not replace the original app in its installed location")
        if system == "Windows":
            require_registration(msi_registration(old_package, report, "original-after-upgrade"),
                                 msi_registration(package, report, "candidate-registered"), upgraded=True)
        stages["afterUpgrade"] = start_profile(
            candidate, profile, work, report, "candidate-reopen", expected_rows, retained, verify_mode_lease=True,
        )
        stages["afterModeLeaseRelease"] = start_profile(
            candidate, profile, work, report, "candidate-after-mode-lease", expected_rows, retained,
        )
        recovery_failure = None
        if origin:
            try:
                stages["firstBusinessInstall"] = installed_first_release.exercise(
                    ctx, candidate, work, profile, report, origin, environment=environment,
                )
            except Exception as error:
                recovery_failure = error
                stages["firstBusinessInstall"] = {"passed": False, "error": str(error)}
        else:
            recovery_failure, permission_failure = exercise_desktop_contracts(
                candidate, desktop_profile, stages, args, identity, work, report, permission_failure,
            )

        if system == "Windows":
            command(["msiexec.exe", "/x", str(package), "/qn", "/norestart", "/L*v", str(report / "candidate-uninstall.log")],
                    report, "candidate-uninstall", accepted=(0, 3010))
        else:
            candidate.parents[2].rename(work / "candidate.app")

        rollback, stages["rollback"] = install(old_package, slot, report / "rollback", old_version)
        if rollback != old_binary or stages["rollback"]["binarySha256"] != stages["original"]["binarySha256"]:
            raise RuntimeError("Rollback did not restore the verified original executable")
        if system == "Windows":
            require_registration(msi_registration(old_package, report, "original-after-rollback"),
                                 msi_registration(package, report, "candidate-after-rollback"), upgraded=False)
        stages["afterRollback"] = start_profile(rollback, profile, work, report, "rollback-reopen", expected_rows)
        if recovery_failure is not None:
            raise recovery_failure
        if permission_failure is not None:
            raise permission_failure
        if stages.get("permissionContinuity", {}).get("lostGrants"):
            raise RuntimeError("The installed upgrade lost a previously granted macOS permission")
        result.update(passed=True, sessionTypes=[row["session_type"] for row in expected_rows], retainedFiles=retained)
    finally:
        if origin:
            origin.close()
        write_json(report / "installed-desktop-upgrade.json", result)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("identity", "legacy", "candidate", "evidence", "work"):
        parser.add_argument("--" + name, required=True, type=Path)
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--first-release", type=Path)
    inputs.add_argument("--signed", type=Path)
    parser.add_argument("--macos-hardened-mfa", action="store_true")
    execute(parser.parse_args())
