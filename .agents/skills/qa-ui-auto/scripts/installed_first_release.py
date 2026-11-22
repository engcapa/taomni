"""Check first enrollment in a replacement deb using its production desktop and signed business packages."""
import json
import os
import time

from modular_bundle_inventory import digest, write_json
from qa_ui_auto.fixtures.module_first_release import CATALOG, release_inputs
from qa_ui_auto.fixtures.module_legacy_mfa import (
    close_installed_desktop, desktop_action, element, installed_desktop, unlock_vault,
)
from qa_ui_auto.fixtures.module_marketplace import ORIGIN, Origin
from qa_ui_auto.module_marketplace_observation import current_roster_modules, observe_legacy_roster


def open_release(inputs, target, evidence):
    files, roster, producer = release_inputs(
        inputs, target["producerSource"], str(target["producerRun"]), target["target"], ORIGIN,
        modules=inputs / "source" / "src-tauri" / "plugins",
    )
    write_json(evidence / "first-release-build.json", {
        "bundle": target, "sourceSha": producer["sourceSha"], "catalogSha256": producer["catalogSha256"],
        "platformPackages": roster, "runnerImage": os.environ.get("ImageOS"),
        "runnerImageVersion": os.environ.get("ImageVersion"), "verificationRun": os.environ["GITHUB_RUN_ID"],
    })
    return Origin(files, evidence / "first-release-requests.json", roster=roster, start_catalog=CATALOG)


def enrollment(profile, origin):
    path = profile / ".module-release.json"
    end = time.monotonic() + 210
    while time.monotonic() < end:
        if path.is_file():
            state = json.loads(path.read_text(encoding="utf-8"))
            if state.get("legacyPending") == []:
                if state["origin"] != "legacy" or set(state["seen"]) != set(origin.roster) or state["newModules"]:
                    raise RuntimeError("Installed core did not enroll the compatible business roster")
                cache = json.loads((profile / "plugins/.catalog-trust/catalog.json").read_text(encoding="utf-8"))
                if cache["payload"].encode() != origin.current_catalog:
                    raise RuntimeError("Installed core cached a different catalog")
                return state
        time.sleep(.25)
    raise RuntimeError("Installed core did not finish first enrollment with the release packages")


def exercise(ctx, executable, work, profile, evidence, origin):
    observation = {"passed": False, "binarySha256": digest(executable), "stages": {}}
    try:
        for label, removed in [("first-business-install", None), ("reopen-without-mail", "mail")]:
            stage = observation["stages"][label] = {}
            with installed_desktop(ctx, executable, work / "desktop", evidence, label, timeout=300) as (driver, session):
                steps = unlock_vault(ctx, session, evidence)
                stage["enrollment"] = enrollment(profile, origin)
                stage["activePointers"] = observe_legacy_roster(profile / "plugins", origin, removed)
                desktop_action(steps, "click", element("ribbon-settings"))
                desktop_action(steps, "fill", {"selector": element("settings-search-input"), "value": "module store"})
                mfa = '[data-module-id="taomni-plugin-mfa"] ' + element("module-marketplace-current")
                desktop_action(steps, "wait_for", mfa)
                stage["currentModules"] = current_roster_modules(session, origin.roster, removed)
                if removed is None:
                    desktop_action(steps, "press", {"selector": element("module-action-uninstall-mail") + ":not([disabled])", "key": "Enter"})
                    desktop_action(steps, "wait_for", element("confirm-dialog"))
                    desktop_action(steps, "click", element("confirm-dialog-confirm"))
                desktop_action(steps, "wait_for", element("module-action-install-mail"))
                desktop_action(steps, "assert_no_runtime_errors", None)
                stage["shutdown"] = close_installed_desktop(driver, session, executable)
        observation["passed"] = True
        return observation
    finally:
        write_json(evidence / "installed-first-release.json", observation)
