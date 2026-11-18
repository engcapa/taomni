"""Exercise installation, signed migration and rollback on a hosted Linux desktop."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
from types import SimpleNamespace

from ci_desktop import Desktop
from modular_bundle_inventory import digest, inventory
from qa_ui_auto.fixtures.module_legacy_mfa import (
    ISSUER, PASSWORD, close_installed_desktop, commit_mfa_upgrade, desktop_action, element,
    installed_desktop, open_mfa, run_legacy_desktop, write_json,
)
from qa_ui_auto.fixtures.module_signed_archive import load_artifact
from qa_ui_auto.legacy_install import linux_install
from qa_ui_auto.legacy_release import RELEASE_VERSION, selected_asset, verify_asset
from qa_ui_auto.native_steps import NativeStepContext


def inspect_accounts(ctx, executable, work, evidence, phase, code, *, next_code=None):
    with installed_desktop(ctx, executable, work / "desktop", evidence, phase) as (driver, session):
        steps = NativeStepContext(session, evidence, ctx.cfg)
        desktop_action(steps, "wait_for", element("vault-unlock-dialog"))
        desktop_action(steps, "fill", {"selector": element("vault-unlock-pw"), "value": PASSWORD})
        desktop_action(steps, "click", element("vault-unlock-confirm"))
        desktop_action(steps, "wait_for", {
            "selector": element("vault-unlock-dialog"), "state": "detached", "timeout_sec": 30,
        })
        open_mfa(steps)
        desktop_action(steps, "assert_visible", element("mfa-account-row") + f'[data-issuer="{ISSUER}"]')
        desktop_action(steps, "assert_text_equals", {"selector": element("mfa-account-code"), "equals": code})
        if next_code is not None:
            desktop_action(steps, "click", element("mfa-account-hotp-next"))
            desktop_action(steps, "assert_text_equals", {
                "selector": element("mfa-account-code"), "equals": next_code,
            })
        desktop_action(steps, "assert_no_runtime_errors", None)
        return {"hotp": code, "nextHotp": next_code,
                **close_installed_desktop(driver, session, executable)}


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
    if target["target"] != "linux-x86_64" or target["version"] == RELEASE_VERSION:
        raise RuntimeError("Choose a Linux candidate with a distinct installer version")
    bundled = inventory(args.candidate.resolve(strict=True), target)
    package = args.candidate.resolve() / next(file["name"] for file in bundled["files"]
                                               if file["name"].endswith(".deb"))
    receipt, archive, _, _ = load_artifact(args.signed, target["producerSource"], "linux-x86_64", "mfa")
    signature = archive.with_name(receipt["signature"])
    pinned = selected_asset()
    old_package = args.legacy.resolve(strict=True) / pinned.name
    verify_asset(old_package, pinned)
    report = args.evidence.resolve()
    work = args.work.resolve()
    work.mkdir(parents=True)
    report.mkdir(parents=True, exist_ok=True)
    write_json(report, "bundle-inventory.json", bundled)
    write_json(report, "signed-mfa-input.json", receipt)
    result = {"schema": "taomni.qa.installed-mfa-upgrade.v1", "passed": False,
              "oldVersion": RELEASE_VERSION, "candidateVersion": target["version"],
              "candidateSource": target["producerSource"], "stages": {}}
    stages = result["stages"]
    ctx = SimpleNamespace(cfg={"webdriver": {"startup_timeout": 45}})
    try:
        with Desktop(report / "desktop", ["display", "x11"]):
            legacy_install = report / "original-install"
            legacy_install.mkdir()
            old_executable, legacy = replace_package(old_package, work, legacy_install / "deb",
                                                    version=RELEASE_VERSION)
            stages["originalInstall"] = legacy
            profile = run_legacy_desktop(ctx, old_executable, work, legacy_install)
            result["profile"] = str(profile)
            candidate, replacement = replace_package(package, work, report / "candidate-install",
                                                     version=target["version"])
            stages["replacement"] = replacement
            if candidate != old_executable or replacement["binarySha256"] == legacy["binarySha256"]:
                raise RuntimeError("The deb did not replace the original installed executable")
            commit_mfa_upgrade(candidate, profile, archive, signature, report)
            stages["candidate"] = inspect_accounts(ctx, candidate, work, report, "candidate-window",
                                                    "287 082", next_code="359 152")
            old_executable, rollback = replace_package(old_package, work, report / "rollback-install",
                                                       version=RELEASE_VERSION, allow_downgrade=True)
            stages["rollbackInstall"] = rollback
            if rollback["binarySha256"] != legacy["binarySha256"]:
                raise RuntimeError("The rollback did not restore the verified old executable")
            stages["rollback"] = inspect_accounts(ctx, old_executable, work, report, "rollback-window", "287 082")
            candidate, reinstalled = replace_package(package, work, report / "candidate-reinstall",
                                                    version=target["version"])
            stages["candidateReinstall"] = reinstalled
            if reinstalled["binarySha256"] != replacement["binarySha256"]:
                raise RuntimeError("Candidate reinstall changed the installed executable")
            stages["reopenModule"] = inspect_accounts(ctx, candidate, work, report, "candidate-reopen", "359 152")
            result["passed"] = True
    finally:
        write_json(report, "installed-mfa-upgrade.json", result)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for argument in ("identity", "legacy", "candidate", "signed", "evidence", "work"):
        parser.add_argument("--" + argument, required=True, type=Path)
    execute(parser.parse_args())
