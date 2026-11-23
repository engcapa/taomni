"""Exercise installation, signed migration and rollback on a hosted Linux desktop."""
from __future__ import annotations

import argparse
from contextlib import ExitStack, closing
import json
import os
from pathlib import Path
import platform
from types import SimpleNamespace

from ci_desktop import Desktop
import installed_first_release
import installed_mail_upgrade
from installed_linux_formats import appimage_binary, install_rpm, prepare_appimage
from installed_mfa_crash import abrupt_exit
from installed_mfa_profile import copy_profile
from linux_noexec import NoExecBind, is_noexec
from modular_bundle_inventory import digest, inventory
from qa_ui_auto.mail_fake_server import FakeMailServer
from qa_ui_auto.fixtures.module_legacy_mfa import (
    ISSUER, close_installed_desktop, commit_mfa_upgrade, desktop_action, desktop_environment, element,
    installed_desktop, isolated_desktop, open_unlocked_mfa, run_legacy_desktop, write_json,
)
from qa_ui_auto.fixtures.module_signed_archive import load_artifact
from qa_ui_auto.legacy_install import linux_install
from qa_ui_auto.legacy_process import MODE_LEASE_DENIAL, headless_command, initialize_profile, observe_same_profile_contender
from qa_ui_auto.legacy_release import FIRST_UPGRADE_VERSION, RELEASE_VERSION, selected_asset, verify_asset

def inspect_accounts(ctx, executable, work, evidence, phase, code, *, next_code=None):
    with installed_desktop(ctx, executable, work / "desktop", evidence, phase) as (driver, session):
        steps = open_unlocked_mfa(ctx, session, evidence)
        desktop_action(steps, "assert_visible", element("mfa-account-row") + f'[data-issuer="{ISSUER}"]')
        desktop_action(steps, "assert_text_equals", {"selector": element("mfa-account-code"), "equals": code})
        if next_code is not None:
            desktop_action(steps, "click", element("mfa-account-hotp-next"))
            desktop_action(steps, "assert_text_equals", {
                "selector": element("mfa-account-code"), "equals": next_code,
            })
        desktop_action(steps, "assert_no_runtime_errors", None)
        return {"hotp": code, "nextHotp": next_code, **close_verified_desktop(driver, session, executable)}


def close_verified_desktop(driver, session, executable):
    binary = executable
    if executable.suffix == ".AppImage":
        binary = appimage_binary(executable, driver.proc.pid)
    # The AppImage launcher starts a separate executable which owns the X11 window.
    launcher = session.application
    try:
        session.application = binary
        return {"launchedBinarySha256": digest(binary), **close_installed_desktop(driver, session, binary)}
    finally:
        session.application = launcher


def verify_desktop_profile_lease(ctx, candidate, work, profile, evidence, observation):
    desktop = work / "desktop"
    environment, resolved_profile = desktop_environment(desktop)
    if resolved_profile != profile:
        raise RuntimeError("The installed desktop and headless process must share the same profile")
    with installed_desktop(ctx, candidate, desktop, evidence, "desktop-owns-mode-lease") as (driver, session):
        steps = open_unlocked_mfa(ctx, session, evidence)
        code = {"selector": element("mfa-account-code"), "equals": "359 152"}
        desktop_action(steps, "assert_text_equals", code)
        contender = observe_same_profile_contender(
            headless_command(candidate, profile), lambda: driver.proc.poll() is None,
            evidence, "desktop-owns-mode-lease",
        )
        observation["headlessContender"] = contender
        if contender != MODE_LEASE_DENIAL:
            raise RuntimeError("A headless process was not rejected while the installed desktop owned its profile")
        desktop_action(steps, "assert_text_equals", code)
        desktop_action(steps, "assert_no_runtime_errors", None)
        observation["desktopShutdown"] = close_verified_desktop(driver, session, candidate)

    def verify_gui_contender(owner):
        contender = observe_same_profile_contender(
            [str(candidate)], lambda: owner.poll() is None,
            evidence, "headless-owns-mode-lease-desktop", desktop_env=os.environ.copy(),
        )
        observation["desktopContender"] = contender
        if contender != MODE_LEASE_DENIAL:
            raise RuntimeError("The installed desktop did not report a mode conflict and exit with status 1")

    with isolated_desktop(environment):
        observation["headlessAfterDesktopExit"] = initialize_profile(
            candidate, profile, work, evidence, "headless-after-desktop-exit", observe_ready=verify_gui_contender,
        )
    observation["desktopAfterHeadlessExit"] = inspect_accounts(
        ctx, candidate, work, evidence, "desktop-after-headless-exit", "359 152",
    )
    observation["passed"] = True


def verify_crash_recovery(ctx, candidate, work, profile, evidence, receipt, observation):
    state = profile / "plugins/mfa/active.json"
    active = json.loads(state.read_text(encoding="utf-8"))
    if active["activeVersion"] != receipt["version"]:
        raise RuntimeError("The active MFA version differs from the verified package")
    directory = state.parent / "versions" / receipt["version"]
    if digest(directory / ".taomni-trust/package.taomni-plugin") != receipt["sha256"]:
        raise RuntimeError("The installed MFA package proof differs from the signed fixture")
    module = directory / "taomni-plugin-mfa"
    observation.update(moduleSha256=digest(module), activeVersion=active["activeVersion"])
    with installed_desktop(ctx, candidate, work / "desktop", evidence, "abrupt-exit-window") as (driver, session):
        steps = open_unlocked_mfa(ctx, session, evidence)
        code = element("mfa-account-code")
        desktop_action(steps, "assert_text_equals", {"selector": code, "equals": "359 152"})
        desktop_action(steps, "click", element("mfa-account-hotp-next"))
        desktop_action(steps, "assert_text_equals", {"selector": code, "equals": "969 429"})
        observation["hotpBeforeExit"] = "969 429"
        abrupt_exit(candidate, module, driver.proc.pid, observation)
        session.session_id = None

    observation["reopen"] = inspect_accounts(ctx, candidate, work, evidence, "after-abrupt-exit", "969 429",
                                             next_code="338 314")
    if json.loads(state.read_text(encoding="utf-8")) != active or digest(module) != observation["moduleSha256"]:
        raise RuntimeError("Recovery changed the installed module or active version")
    observation["passed"] = True


def verify_relocation(ctx, candidate, work, profile, evidence, receipt):
    tracked = ["plugins/mfa/active.json", "plugins/mfa/data/mfa.db"]
    tracked.append(f"plugins/mfa/versions/{receipt['version']}/taomni-plugin-mfa")
    original = {name: digest(profile / name) for name in tracked}
    archived_chat = profile / "lanchat.db"
    with archived_chat.open("xb") as stream:
        stream.write(b"historical LanChat preservation fixture")
    historical_sha = digest(archived_chat)
    relocation_work = work / "relocated"
    environment, destination = desktop_environment(relocation_work / "desktop")
    mount = NoExecBind(profile, work)
    result = {"passed": False, "mountRemoved": False}
    verified = False
    try:
        result["mount"] = mount.block()
        with installed_desktop(ctx, candidate, work / "desktop", evidence, "noexec-window") as (driver, session):
            steps = open_unlocked_mfa(ctx, session, evidence)
            selector = element("mfa-load-error")
            desktop_action(steps, "wait_for", selector)
            for text in ("MODULE_HOST_NOEXEC", str(profile), "XDG_DATA_HOME"):
                desktop_action(steps, "assert_text", {"selector": selector, "contains": text})
            desktop_action(steps, "assert_count", {"selector": element("mfa-account-row"), "equal": 0})
            desktop_action(steps, "assert_no_runtime_errors", None)
            result["blocked"] = close_verified_desktop(driver, session, candidate)
        if {name: digest(profile / name) for name in tracked} != original:
            raise RuntimeError("Noexec startup changed the installed MFA code, pointer or data")
        result["files"] = copy_profile(profile, destination)
        if is_noexec(destination) or not is_noexec(profile):
            raise RuntimeError("The original profile must still be blocked while the copy can execute")
        result["destinationXdgDataHome"] = environment["XDG_DATA_HOME"]
        result["recovery"] = inspect_accounts(ctx, candidate, relocation_work, evidence,
                                             "relocated-window", "359 152", next_code="969 429")
        if any(digest(profile / name) != checksum for name, checksum in result["files"].items()):
            raise RuntimeError("The relocated desktop changed files in the original profile")
        if (destination / archived_chat.name).exists() or digest(archived_chat) != historical_sha:
            raise RuntimeError("The historical chat file must stay with the original profile")
        result["retainedChatSha256"] = historical_sha
        verified = True
    finally:
        try:
            mount.restore()
            result["mountRemoved"] = mount.mount_id is None
            result["passed"] = verified and result["mountRemoved"]
        finally:
            write_json(evidence, "installed-mfa-profile-relocation.json", result)
    return result


def verify_other_formats(ctx, work, report, profile, bundle_dir, bundles, receipt):
    formats = {}
    for suffix in (".rpm", ".AppImage"):
        label = suffix[1:].lower()
        evidence = report / label
        evidence.mkdir()
        staged = work / label
        _, destination = desktop_environment(staged / "desktop")
        copy_profile(profile, destination)
        package = bundle_dir / next(file["name"] for file in bundles["files"] if file["name"].endswith(suffix))
        environment = {}
        if suffix == ".rpm":
            launcher = install_rpm(package, bundles["version"], evidence)
            method = "rpm install on Ubuntu with resolved runtime dependencies"
        else:
            launcher = prepare_appimage(package, staged / "launch")
            environment["APPIMAGE_EXTRACT_AND_RUN"] = "1"
            method = "AppImage extract-and-run"
        with isolated_desktop(environment):
            result = verify_relocation(ctx, launcher, staged, destination, evidence, receipt)
        formats[label] = {"method": method, "packageSha256": digest(package), **result}
    return formats


def replace_package(package, work, evidence, *, version, allow_downgrade=False):
    evidence.mkdir()
    executable, details = linux_install(package, work, evidence, version=version,
                                        allow_downgrade=allow_downgrade)
    return executable, {"packageSha256": digest(package), "binarySha256": digest(executable), **details}


def execute(args):
    if (platform.system() != "Linux" or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("GITHUB_REPOSITORY") != "engcapa/taomni"
            or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"):
        raise RuntimeError("Installed Linux replacement requires the owned GitHub-hosted runner")
    target = json.loads(args.identity.read_text(encoding="utf-8"))
    old_version = FIRST_UPGRADE_VERSION if args.first_release else RELEASE_VERSION
    if target["target"] != "linux-x86_64" or target["version"] == old_version:
        raise RuntimeError("Choose a Linux candidate with a distinct installer version")
    bundled = inventory(args.candidate.resolve(strict=True), target)
    package = args.candidate.resolve() / next(file["name"] for file in bundled["files"]
                                               if file["name"].endswith(".deb"))
    pinned = selected_asset(version=old_version)
    old_package = args.legacy.resolve(strict=True) / pinned.name
    verify_asset(old_package, pinned)
    report = args.evidence.resolve()
    work = args.work.resolve()
    work.mkdir(parents=True)
    report.mkdir(parents=True, exist_ok=True)
    write_json(report, "bundle-inventory.json", bundled)
    result = {"schema": "taomni.qa.installed-mfa-upgrade.v1", "passed": False,
              "oldVersion": old_version, "candidateVersion": target["version"],
              "candidateSource": target["producerSource"], "stages": {}}
    stages = result["stages"]
    ctx = SimpleNamespace(cfg={"webdriver": {"startup_timeout": 45}})
    try:
        with ExitStack() as resources, Desktop(report / "desktop", ["display", "x11"]):
            origin = None
            mail_input = None
            seed_mail = None
            if args.first_release:
                origin = resources.enter_context(closing(installed_first_release.open_release(
                    args.first_release.resolve(strict=True), target, report,
                )))
                receipt = origin.roster["taomni-plugin-mfa"]
                archive = origin.files["/" + receipt["archive"]]
                server = FakeMailServer()
                resources.callback(server.stop)
                server.state.deliver("INBOX", 1, prefix=installed_mail_upgrade.LEGACY_PREFIX,
                                     body=installed_mail_upgrade.LEGACY_BODY + "\r\n")
                mail_package = origin.roster[installed_mail_upgrade.MAIL_ID]

                def seed_mail(session):
                    installed_mail_upgrade.seed_original(ctx, session, legacy_install, server)
            else:
                receipt, archive, _, _ = load_artifact(args.signed, target["producerSource"], "linux-x86_64", "mfa")
            signature = archive.with_name(receipt["signature"])
            write_json(report, "signed-mfa-input.json", receipt)
            legacy_install = report / "original-install"
            legacy_install.mkdir()
            old_executable, legacy = replace_package(old_package, work, legacy_install / "deb",
                                                    version=old_version)
            stages["originalInstall"] = legacy
            if origin:
                from installed_core_resources import record_linux_comparison, sample_linux
                original_resources = sample_linux(ctx, old_executable, work, report, "original")
            catalog_source = f"{installed_first_release.ORIGIN}/{origin.start_catalog}" if origin else None
            profile = run_legacy_desktop(ctx, old_executable, work, legacy_install,
                                         catalog_source=catalog_source, after_seed=seed_mail)
            result["profile"] = str(profile)
            if origin:
                mail_input = installed_mail_upgrade.LegacyMailbox.observe(profile)
                stages["legacyMail"] = mail_input.evidence()
            candidate, replacement = replace_package(package, work, report / "candidate-install",
                                                     version=target["version"])
            stages["replacement"] = replacement
            if candidate != old_executable or replacement["binarySha256"] == legacy["binarySha256"]:
                raise RuntimeError("The deb did not replace the original installed executable")
            if origin:
                candidate_resources = sample_linux(ctx, candidate, work, report, "candidate")
                stages["coreResources"] = record_linux_comparison(
                    report, target, old_package, package, original_resources, candidate_resources,
                )
                stages["mailStagedForRestart"] = installed_mail_upgrade.stage_on_first_launch(
                    ctx, candidate, work / "desktop", report, mail_input, mail_package,
                )

                def read_migrated_mail(steps):
                    stages["migratedMail"] = installed_mail_upgrade.exercise_migrated(
                        steps, mail_input, server, mail_package,
                    )

                stages["firstBusinessInstall"] = installed_first_release.exercise(
                    ctx, candidate, work, profile, report, origin, mail=read_migrated_mail,
                )
                stages["uninstalledMailData"] = mail_input.assert_uninstalled(
                    mail_package["version"], stages["migratedMail"]["syncedUid"],
                )
            commit_mfa_upgrade(candidate, profile, archive, signature, report)
            stages["candidate"] = inspect_accounts(ctx, candidate, work, report, "candidate-window",
                                                    "287 082", next_code="359 152")
            old_executable, rollback = replace_package(old_package, work, report / "rollback-install",
                                                       version=old_version, allow_downgrade=True)
            stages["rollbackInstall"] = rollback
            if rollback["binarySha256"] != legacy["binarySha256"]:
                raise RuntimeError("The rollback did not restore the verified old executable")
            if mail_input:
                stages["rollbackMail"] = installed_mail_upgrade.exercise_rollback(
                    ctx, old_executable, work / "desktop", report, mail_input,
                )
            stages["rollback"] = inspect_accounts(ctx, old_executable, work, report, "rollback-window", "287 082")
            candidate, reinstalled = replace_package(package, work, report / "candidate-reinstall",
                                                    version=target["version"])
            stages["candidateReinstall"] = reinstalled
            if reinstalled["binarySha256"] != replacement["binarySha256"]:
                raise RuntimeError("Candidate reinstall changed the installed executable")
            stages["reopenModule"] = inspect_accounts(ctx, candidate, work, report, "candidate-reopen", "359 152")
            profile_lease = stages["desktopProfileLease"] = {"passed": False}
            verify_desktop_profile_lease(ctx, candidate, work, profile, report, profile_lease)
            if args.verify_relocation:
                stages["relocation"] = verify_relocation(ctx, candidate, work, profile, report, receipt)
                stages["otherFormats"] = verify_other_formats(ctx, work, report, profile, args.candidate.resolve(), bundled, receipt)
            observation = stages["crashRecovery"] = {"passed": False}
            verify_crash_recovery(ctx, candidate, work, profile, report, receipt, observation)
            if args.rdp_probe:
                from installed_rdp_baseline import measure
                stages["rdpPerformance"] = measure(candidate, args.rdp_probe.resolve(strict=True),
                                                   target["producerSource"], work, report, origin=origin)
            result["passed"] = True
    except Exception as error:
        result["error"] = str(error)
        raise
    finally:
        write_json(report, "installed-mfa-upgrade.json", result)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for argument in ("identity", "legacy", "candidate", "evidence", "work"):
        parser.add_argument("--" + argument, required=True, type=Path)
    signed = parser.add_mutually_exclusive_group(required=True)
    signed.add_argument("--signed", type=Path)
    signed.add_argument("--first-release", type=Path)
    parser.add_argument("--verify-relocation", action="store_true")
    parser.add_argument("--rdp-probe", type=Path)
    execute(parser.parse_args())
