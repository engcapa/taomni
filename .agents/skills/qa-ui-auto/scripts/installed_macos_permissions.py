"""Observe read-only macOS permission checks through both installed app versions."""
from pathlib import Path
import plistlib
import time
from types import SimpleNamespace

from modular_bundle_inventory import digest, write_json
from qa_ui_auto.fixtures.module_legacy_mfa import desktop_action, element, installed_desktop
from qa_ui_auto.legacy_install import command
from qa_ui_auto.native_steps import NativeStepContext


def read_core_permissions(session):
    session.execute("""
      window.__qaInstalledPermissions = null;
      const invoke = window.__TAURI_INTERNALS__.invoke;
      Promise.all([
        invoke("probe_rdp_capture", { requestPermission: false, requestControlPermission: false }),
        invoke("screenshot_probe"),
      ]).then(
        ([rdp, screenshot]) => { window.__qaInstalledPermissions = { rdp, screenshot }; },
        (error) => { window.__qaInstalledPermissions = { failure: String(error) }; },
      );
      return true;
    """)
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            result = session.execute("return window.__qaInstalledPermissions;")
            if result is not None:
                break
            time.sleep(0.05)
        else:
            raise RuntimeError("The installed application's permission probes timed out")
    finally:
        session.execute("delete window.__qaInstalledPermissions; return true;")
    if "failure" in result:
        raise RuntimeError(f"The installed application could not probe its permissions: {result['failure']}")
    names = {"permission": "screenRecording", "controlPermission": "accessibility"}
    observed = {}
    for field, name in names.items():
        rdp = result["rdp"].get(field)
        if rdp not in {"granted", "denied"} or result["screenshot"].get(field) != rdp:
            raise RuntimeError(f"Screenshot and RDP disagree about the installed app's {name} permission")
        observed[name] = rdp
    return observed


def observe_permissions(executable, evidence, phase):
    app = executable.parents[2]
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != "com.taomni.app":
        raise RuntimeError("The macOS permission observation requires the installed application identity")
    signed = command(["codesign", "-d", "-r-", str(app)], evidence, f"macos-permissions-{phase}-identity")
    output = signed.stdout + b"\n" + signed.stderr
    requirement = [line for line in output.decode("utf-8", errors="replace").splitlines()
                   if line.startswith("designated => ")]
    if len(requirement) != 1:
        raise RuntimeError("Could not identify the installed application's designated requirement")
    ctx = SimpleNamespace(cfg={"webdriver": {"startup_timeout": 60}})
    label = f"macos-permissions-{phase}"
    with installed_desktop(ctx, executable, evidence, evidence, label, environment={}) as (driver, session):
        desktop_action(NativeStepContext(session, evidence, ctx.cfg), "wait_for", element("welcome-panel"))
        observations = read_core_permissions(session)
        record = {
            **observations, "pid": driver.proc.pid, "bundleIdentifier": info["CFBundleIdentifier"],
            "bundleVersion": info["CFBundleShortVersionString"], "requirement": requirement[0],
            "executable": str(executable), "binarySha256": digest(executable),
        }
    write_json(Path(evidence) / f"{label}.json", record)
    return record


def compare_permissions(previous, candidate):
    fields = ("screenRecording", "accessibility")
    same_requirement = previous["requirement"] == candidate["requirement"]
    missing = [name for name in fields if previous[name] != "granted"]
    lost = [name for name in fields if previous[name] == "granted" and candidate[name] != "granted"]
    return {
        "sameDesignatedRequirement": same_requirement,
        "missingBaselineGrants": missing,
        "lostGrants": lost,
        "retainedBothGrants": same_requirement and not missing and not lost,
    }
