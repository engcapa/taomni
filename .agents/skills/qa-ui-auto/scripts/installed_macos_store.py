"""Drive the installed macOS release through AppKit accessibility."""

from contextlib import contextmanager
import json
from pathlib import Path
import subprocess

from installed_desktop_mode_lease import observe_desktop_owner
from modular_bundle_inventory import write_json
from qa_ui_auto.fixtures.module_legacy_mfa import PASSWORD, isolated_desktop
from qa_ui_auto.module_marketplace_observation import observe_legacy_roster


def compile_driver(work):
    executable = work / "installed-macos-store"
    if not executable.is_file():
        source = Path(__file__).with_name("installed_macos_store.swift")
        rdp_row = source.with_name("installed_macos_rdp_row.swift")
        subprocess.run(
            ["swiftc", "-parse-as-library", str(source), str(rdp_row), "-o", str(executable)], check=True, timeout=90,
        )
    return executable


def controls(driver, owner, executable, phase, evidence, **inputs):
    payload = dict(inputs, pid=owner.pid, executable=str(executable), phase=phase)
    if phase == "permissions":
        payload["rdpScreenshot"] = str((evidence / "local-servers-rdp-row.png").resolve())
    observed = subprocess.run(
        [str(driver)], input=json.dumps(payload), text=True, encoding="utf-8",
        capture_output=True, timeout=100,
    )
    if observed.returncode:
        (evidence / f"{phase}-error.log").write_text(observed.stderr, encoding="utf-8")
        if phase in {"permissions", "mfa-before", "mfa-after", "screen-scan"} and owner.poll() is None:
            try:
                subprocess.run(["screencapture", "-x", str(evidence / f"{phase}-failure.png")],
                               capture_output=True, timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                # Keep the original accessibility failure even if capture is unavailable.
                pass
        raise RuntimeError(f"Installed macOS {phase}: {observed.stderr.strip()}")
    receipt = json.loads(observed.stdout)
    if receipt["ownerPid"] != owner.pid or receipt["phase"] != phase:
        raise RuntimeError(f"Unexpected macOS accessibility receipt during {phase}")
    write_json(evidence / f"{phase}.json", receipt)
    return receipt


@contextmanager
def installed_macos_desktop(executable, work, evidence, environment=None):
    evidence.mkdir()
    with (evidence / "app.stdout.txt").open("wb") as stdout, (evidence / "app.stderr.txt").open("wb") as stderr:
        with isolated_desktop(environment or {}):
            owner = subprocess.Popen([str(executable)], cwd=work, stdout=stdout, stderr=stderr)
        try:
            yield owner
        finally:
            if owner.poll() is None:
                owner.terminate()
                try:
                    owner.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    owner.kill()
                    owner.wait(timeout=10)


def exercise_stage(executable, work, profile, evidence, origin, label, removed, stage, enrollment, environment):
    folder = evidence / label
    driver = compile_driver(work)
    catalog = json.loads(origin.current_catalog)["plugins"]
    modules = [
        {"id": module_id, "name": catalog[module_id]["name"], "removed": pack["slug"] == removed}
        for module_id, pack in sorted(origin.roster.items())
    ]
    with installed_macos_desktop(executable, work, folder, environment) as owner:
        controls(driver, owner, executable, "unlock-store", folder, password=PASSWORD)
        stage["enrollment"] = enrollment(profile, origin)
        stage["activePointers"] = observe_legacy_roster(profile / "plugins", origin, removed)
        roster = controls(driver, owner, executable, "roster", folder, modules=modules)
        expected = [module["id"] for module in modules if not module["removed"]]
        if roster["currentModules"] != expected:
            raise RuntimeError("The installed macOS store shows different current modules")
        stage["currentModules"] = roster["currentModules"]
        if removed is None:
            controls(driver, owner, executable, "remove-mail", folder, modules=modules)
        else:
            stage["rdpServerForPermissions"] = controls(
                driver, owner, executable, "enable-rdp-server", folder, modules=modules,
            )
            stage["desktopModeLease"] = observe_desktop_owner(executable, profile, evidence, owner)
        closed = controls(driver, owner, executable, "confirm-close", folder)
        code = owner.wait(timeout=30)
        if code != 0:
            raise RuntimeError(f"Installed macOS app exited with {code}")
        stage["shutdown"] = {"close": closed, "shutdown": {"pid": owner.pid, "exitCode": code}}
