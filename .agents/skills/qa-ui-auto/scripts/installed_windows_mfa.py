"""Drive MFA in the actual Windows installer through its accessible controls."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import quote, urlencode

from modular_bundle_inventory import write_json
from qa_ui_auto.fixtures.module_legacy_mfa import ISSUER, PASSWORD, SECRET


UIA_STAGES = {
    "initialization", "owned-window", "vault-unlock-field", "unlock-vault",
    "open-tools", "open-mfa", "vault-setup-fields", "create-vault",
    "open-add-account", "otpauth-field", "save-account", "copy-hotp",
    "read-hotp", "advance-hotp",
}


@contextmanager
def installed_windows_desktop(executable, work, evidence, label):
    # Installer replacement and recovery reopen the same WebView2 data as well
    # as the same app data, including the previously selected catalog mirror.
    webview = work / "webview"
    webview.mkdir(exist_ok=True)
    environment = {
        **os.environ,
        "WEBVIEW2_USER_DATA_FOLDER": str(webview),
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS": "--force-renderer-accessibility",
    }
    with (evidence / f"{label}-application.log").open("xb") as output, subprocess.Popen(
        [str(executable)], stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
        env=environment,
    ) as owner:
        try:
            yield owner
        finally:
            if owner.poll() is None:
                owner.kill()
            owner.wait(timeout=15)


def verify_mfa_controls(owner, phase, evidence):
    codes = {"seed": ["755224", "287082"], "before": ["287082"], "after": ["287082", "359152"]}
    expected = {"phase": phase, "ownerPid": owner.pid, "codes": codes[phase]}
    params = urlencode({"secret": SECRET, "issuer": ISSUER, "counter": 0})
    uri = f"otpauth://hotp/{quote(ISSUER)}:?{params}"
    script = Path(__file__).with_name("installed_windows_mfa_uia.ps1").resolve()
    result = {"phase": phase, "ownerPid": owner.pid, "passed": False}
    try:
        observed = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Sta", "-File", str(script),
             "-OwnerId", str(owner.pid), "-Phase", phase],
            input=json.dumps({"password": PASSWORD, "issuer": ISSUER, "uri": uri}),
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=85 if phase == "seed" else 315, check=False,
        )
        if observed.returncode:
            failure = f"PowerShell exit {observed.returncode}"
            try:
                diagnostic = json.loads(observed.stderr)
            except ValueError:
                diagnostic = None
            if isinstance(diagnostic, dict):
                exception = diagnostic.get("exception")
                code = diagnostic.get("hresult")
                line = diagnostic.get("line")
                if (isinstance(exception, str) and re.fullmatch(r"[.\w+]{1,120}", exception)
                        and type(code) is int and type(line) is int and 0 <= line <= 1000):
                    failure = f"{exception}, HRESULT 0x{code & 0xffffffff:08X}, script line {line}"
                    stage = diagnostic.get("stage")
                    if isinstance(stage, str) and stage in UIA_STAGES:
                        result["stage"] = stage
                        failure += f", stage {stage}"
                    handle = diagnostic.get("windowHandle")
                    screenshot = None
                    if phase == "seed" and stage == "vault-setup-fields":
                        screenshot = "windows-mfa-before-vault-setup.png"
                    elif stage in {"vault-unlock-field", "unlock-vault", "open-tools", "open-mfa"}:
                        screenshot = f"windows-mfa-{phase}-{stage}.png"
                    if (os.name == "nt" and screenshot is not None and type(handle) is int
                            and 0 < handle < 2**63 and owner.poll() is None):
                        result["windowScreenshot"] = capture_window(handle, evidence, screenshot)
                    controls = diagnostic.get("controls")
                    if isinstance(controls, dict):
                        count = controls.get("visiblePasswordFields")
                        mfa = controls.get("mfaActionVisible")
                        add = controls.get("addAccountVisible")
                        if (type(count) is int and 0 <= count <= 100
                                and isinstance(mfa, bool) and isinstance(add, bool)):
                            result["controls"] = {
                                "visiblePasswordFields": count,
                                "mfaActionVisible": mfa,
                                "addAccountVisible": add,
                            }
            result["error"] = failure
            raise RuntimeError(f"Installed Windows MFA UI Automation {phase} failed ({failure})")
        payload = json.loads(observed.stdout)
        if payload != expected or owner.poll() is not None:
            raise RuntimeError("The installed Windows MFA did not return the expected HOTP values")
        result.update(codes=payload["codes"], passed=True)
    finally:
        write_json(evidence / f"windows-mfa-{phase}.json", result)


def capture_window(handle, evidence, name):
    from PIL import ImageGrab
    try:
        image = ImageGrab.grab(window=handle)
        if image.width < 100 or image.height < 100:
            return None
        image.save(evidence / name)
    except (OSError, ValueError):
        return None
    return name
