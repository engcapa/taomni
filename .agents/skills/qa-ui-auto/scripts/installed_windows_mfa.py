"""Drive MFA in the actual Windows installer through its accessible controls."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import quote, urlencode

from modular_bundle_inventory import write_json
from qa_ui_auto.fixtures.module_legacy_mfa import ISSUER, PASSWORD, SECRET


@contextmanager
def installed_windows_desktop(executable, work, evidence, label):
    webview = work / f"{label}-webview"
    webview.mkdir()
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
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=85, check=False,
        )
        if observed.returncode:
            # Avoid printing runner output containing controls or fixture inputs.
            error = observed.stderr.partition("\n")[0].strip()
            result["error"] = error
            raise RuntimeError(f"Installed Windows MFA UI Automation {phase} failed: {error}")
        payload = json.loads(observed.stdout)
        if payload != expected or owner.poll() is not None:
            raise RuntimeError("The installed Windows MFA did not return the expected HOTP values")
        result.update(codes=payload["codes"], passed=True)
    finally:
        write_json(evidence / f"windows-mfa-{phase}.json", result)
