"""Verify the installed MSI through Windows UI Automation and independent package receipts."""
import json
from pathlib import Path
import subprocess

from installed_desktop_mode_lease import observe_desktop_owner
from installed_windows_mfa import capture_window, installed_windows_desktop, verify_mfa_controls
from modular_bundle_inventory import write_json
from qa_ui_auto.fixtures.module_legacy_mfa import APP_ID, PASSWORD
from qa_ui_auto.fixtures.module_marketplace import ORIGIN
from qa_ui_auto.module_marketplace_observation import observe_legacy_roster


def controls(owner, phase, evidence, **inputs):
    script = Path(__file__).with_name("installed_windows_store_uia.ps1")
    result = subprocess.run([
        "powershell.exe", "-NoProfile", "-NonInteractive", "-Sta", "-File", str(script),
        "-OwnerId", str(owner.pid), "-Phase", phase,
    ], input=json.dumps(inputs), capture_output=True, text=True, encoding="utf-8", errors="replace",
       timeout=315 if phase == "open-store" else 90)
    if result.returncode:
        (evidence / f"{phase}-error.log").write_text(result.stderr, encoding="utf-8")
        if phase == "open-store" and owner.poll() is None:
            try:
                diagnostic = json.loads(result.stderr)
            except ValueError:
                diagnostic = {}
            handle = diagnostic.get("windowHandle")
            if diagnostic.get("stage") == "vault-unlock-field" and type(handle) is int and 0 < handle < 2**63:
                capture_window(handle, evidence, "startup-before-unlock.png")
        raise RuntimeError(f"Installed app UI Automation failed during {phase}: {result.stderr.strip()}")
    seen = json.loads(result.stdout)
    if seen.get("ownerPid") != owner.pid or seen.get("phase") != phase:
        raise RuntimeError(f"Unexpected Windows UI Automation response during {phase}")
    if phase != "confirm-close" and owner.poll() is not None:
        raise RuntimeError(f"Installed app exited during {phase}")
    write_json(evidence / f"{phase}.json", seen)
    return seen


def close_window(owner, evidence):
    seen = controls(owner, "confirm-close", evidence)
    if seen.get("confirmation") != "There is 1 open tab. Exit Taomni and close it?":
        raise RuntimeError("The installed Windows app did not confirm the expected window close")
    code = owner.wait(timeout=20)
    if code != 0:
        raise RuntimeError(f"Installed app exited with {code} after confirming Close")
    return {"close": {"pid": owner.pid, "transport": "Windows UI Automation"},
            "shutdown": {"exitCode": code}, "confirmation": seen["confirmation"]}


def seed(executable, work, evidence, profile):
    phase = evidence / "legacy-window"
    phase.mkdir()
    with installed_windows_desktop(executable, work, phase, "legacy", webview=work / "webview") as owner:
        verify_mfa_controls(owner, "seed", phase)
        close = close_window(owner, phase)
    write_json(evidence / "legacy-desktop.json", {
        "appId": APP_ID, "profile": str(profile), "executable": str(executable),
        "uiHotpCodes": ["755 224", "287 082"], **close,
    })


def exercise_stage(executable, work, profile, evidence, origin, label, removed, stage, enrollment):
    folder = evidence / label
    folder.mkdir()
    catalog = json.loads(origin.current_catalog)["plugins"]
    modules = []
    for module_id, row in sorted(origin.roster.items()):
        entry = catalog[module_id]
        # The marketplace searches the displayed name, description and slug in this order.
        query = f"{entry['name']} {entry.get('description') or ''} {row['slug']}"
        modules.append({"id": module_id, "name": entry["name"], "query": query, "removed": row["slug"] == removed})
    with installed_windows_desktop(executable, work, folder, label, webview=work / "webview") as owner:
        # The monolith has no catalog setting. On first candidate launch, select
        # the verified CI feed through the product mirror input. Reopen must
        # retain that preference and the user's removal across real app exits.
        controls(owner, "open-store", folder, password=PASSWORD,
                 catalogSource=f"{ORIGIN}/{origin.start_catalog}" if removed is None else None)
        stage["enrollment"] = enrollment(profile, origin)
        stage["activePointers"] = observe_legacy_roster(profile / "plugins", origin, removed)
        observed = controls(owner, "roster", folder, modules=modules)["currentModules"]
        if observed != [entry["id"] for entry in modules if not entry["removed"]]:
            raise RuntimeError("The installed Windows store shows different current modules")
        stage["currentModules"] = observed
        if removed is None:
            controls(owner, "remove-mail", folder, modules=modules)
        else:
            stage["desktopModeLease"] = observe_desktop_owner(executable, profile, evidence, owner)
        stage["shutdown"] = close_window(owner, folder)
