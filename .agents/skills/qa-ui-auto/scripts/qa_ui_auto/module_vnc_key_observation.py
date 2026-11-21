"""Observe the signed VNC helper's Windows process ownership."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import zipfile

from native_build import QA_APP_ID
from tauri_webdriver import native_isolation_env

from .deadline import budget_time as time, remaining_timeout
from .steps import StepError


CASE_ID = "TC-MODULES-055"
HOST = "taomni-plugin-vnc-client.exe"
HELPER = "taomni-vnc-key-helper.exe"


def process_rows():
    script = (
        "$ErrorActionPreference='Stop'; "
        "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); "
        "$rows=@(Get-CimInstance Win32_Process | Where-Object Name -in @('taomni.exe',"
        f"'{HOST}','{HELPER}') | Select-Object ProcessId,ParentProcessId,ExecutablePath,CreationDate); "
        "ConvertTo-Json -InputObject $rows -Compress"
    )
    return json.loads(subprocess.check_output(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        text=True, encoding="utf-8", timeout=remaining_timeout(10),
    ))


def find_owned(rows, core_path, host_path, helper_path):
    def unique(path, parent=None):
        matches = [row for row in rows if row["ExecutablePath"] and Path(row["ExecutablePath"]).resolve() == path]
        if len(matches) > 1 or (matches and parent is not None and matches[0]["ParentProcessId"] != parent["ProcessId"]):
            raise StepError(f"Unexpected process ownership for {path.name}")
        return matches[0] if matches else None

    core = unique(core_path)
    if core is None:
        raise StepError("The isolated QA core process is absent")
    host = unique(host_path, core)
    helper = unique(helper_path, host)
    if any(row["ParentProcessId"] == core["ProcessId"] and row["ExecutablePath"]
           and Path(row["ExecutablePath"]).name.casefold() == HELPER for row in rows):
        raise StepError("The core launched the legacy VNC helper for a signed module session")
    return {"core": core, "host": host, "helper": helper}


def run(ctx, phase):
    from .fixtures.module_signed_archive import load_artifact

    fixture = ctx.fixture_context
    if (phase not in ("running", "disabled") or platform.system() != "Windows" or fixture is None
            or fixture.case_id != CASE_ID or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"):
        raise StepError("assert_vnc_key_helper requires the signed VNC case on a hosted Windows runner")
    case = Path(ctx.case_dir).resolve()
    report = Path(fixture.report_root).resolve()
    isolation = native_isolation_env(report)
    if not case.is_relative_to(report) or any(os.environ.get(key) != value for key, value in isolation.items()):
        raise StepError("VNC helper observation requires the run-owned QA profile")
    root = Path(os.environ["QA_SIGNED_VNC_ROOT"])
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True, timeout=remaining_timeout(5)).strip()
    receipt, archive, _, _ = load_artifact(root, source, "windows-x86_64", "vnc-client")
    version_dir = Path(isolation["NEWMOB_DATA_DIR"]) / QA_APP_ID / "plugins/vnc-client/versions" / receipt["version"]
    host, helper = version_dir / HOST, version_dir / HELPER
    digests = {}
    with zipfile.ZipFile(archive) as package:
        for path in (host, helper):
            if path.resolve() != path:
                raise StepError(f"Installed {path.name} must be under the owned module version")
            expected = hashlib.sha256(package.read(path.name)).hexdigest()
            with path.open("rb") as source_file:
                actual = hashlib.file_digest(source_file, "sha256").hexdigest()
            if actual != expected:
                raise StepError(f"Installed {path.name} differs from the signed input")
            digests[path.name] = actual
    result = {"phase": phase, "sourceSha": source, "packageSha256": receipt["sha256"],
              "hostSha256": digests[HOST], "helperSha256": digests[HELPER], "passed": False}
    path = case / f"vnc-key-helper-{phase}.json"
    previous = json.loads((case / "vnc-key-helper-running.json").read_text(encoding="utf-8")) if phase == "disabled" else None
    try:
        end = time.monotonic() + remaining_timeout(15)
        while time.monotonic() < end:
            result.update(find_owned(process_rows(), ctx.session.application.resolve(), host, helper))
            if previous is not None and (not previous["passed"] or result["core"] != previous["core"]):
                raise StepError("The original QA core must remain running while disabling VNC")
            running = result["host"] is not None and result["helper"] is not None
            stopped = result["host"] is None and result["helper"] is None
            if (phase == "running" and running) or (phase == "disabled" and stopped):
                result["passed"] = True
                return f"Signed VNC helper ownership verified ({phase})"
            time.sleep(.2)
        raise StepError(f"VNC helper ownership did not reach {phase}")
    finally:
        path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
