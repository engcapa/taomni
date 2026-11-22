"""Verify the elevated capture helper is owned by the signed SocksCap host."""

import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import zipfile

from .deadline import budget_time as time, remaining_timeout
from .fixtures.backup_policy import isolated_data_root
from .fixtures.sockscap_legacy import WINDOWS_CAPTURE_CASE_ID
from .steps import StepError


def running_images():
    command = (
        "$ErrorActionPreference='Stop'; "
        "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); "
        "$rows=@(Get-CimInstance Win32_Process | Where-Object Name -in "
        "@('taomni-plugin-sockscap.exe','sockscap-helper.exe') | "
        "Select-Object ProcessId,ExecutablePath,CreationDate); "
        "ConvertTo-Json -InputObject $rows -Compress"
    )
    return json.loads(subprocess.check_output(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
        encoding="utf-8", timeout=remaining_timeout(10),
    ))


def matching_images(rows, path):
    return [row for row in rows if row["ExecutablePath"] and Path(row["ExecutablePath"]).resolve() == path]


def run(ctx, phase):
    owner = ctx.fixture_context
    phases = {"unstaged", "running", "disabled", "uninstalled"}
    if (owner.case_id != WINDOWS_CAPTURE_CASE_ID or platform.system() != "Windows"
            or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted" or phase not in phases):
        raise StepError("Windows capture observation requires the signed case on a hosted runner")

    root = isolated_data_root(owner)
    staged = owner.sockscap_staged_resource.resolve()
    installed = owner.sockscap_resource.parents[2]
    host = (installed / "taomni-plugin-sockscap.exe").resolve()
    receipt = owner.signed_sockscap
    ready_dir = root / "sockscap"
    result = {"sourceSha": receipt["sourceSha"], "platform": receipt["platform"], "packageSha256": receipt["sha256"],
              "phase": phase, "passed": False}
    status_path = Path(ctx.case_dir) / f"sockscap-windows-capture-{phase}.json"
    if phase == "uninstalled":
        module = root / "plugins/sockscap"
        retained_config = module / "data/config.json"
        before = json.loads((Path(ctx.case_dir) / "sockscap-windows-capture-disabled.json").read_text(encoding="utf-8"))
        actual = hashlib.sha256(retained_config.read_bytes()).hexdigest()
        result.update(expectedConfigSha256=before["configSha256"], configSha256=actual,
                      versionTree=(module / "versions").exists(), runtimeTree=(module / "runtime").exists())
        result["passed"] = not result["versionTree"] and not result["runtimeTree"] and actual == before["configSha256"]
        status_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        if not result["passed"]:
            raise StepError("Uninstall kept module code or changed the retained SocksCap configuration")
        return "Windows capture code removed and configuration retained"
    if phase == "unstaged":
        result["passed"] = not staged.exists() and not any(ready_dir.glob("helper-ready-*.json"))
        status_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        if not result["passed"]:
            raise StepError("SocksCap staged a helper despite the damaged package")
        return "Windows capture was not staged after the integrity failure"
    deadline = time.monotonic() + remaining_timeout(20)
    if phase == "disabled" and not json.loads(
        (Path(ctx.case_dir) / "sockscap-windows-capture-running.json").read_text(encoding="utf-8")
    )["passed"]:
        raise StepError("Capture must run before cleanup can be verified")
    try:
        while time.monotonic() < deadline:
            rows = running_images()
            result.update(hosts=matching_images(rows, host), helpers=matching_images(rows, staged))
            ready = []
            for path in ready_dir.glob("helper-ready-*.json"):
                try:
                    ready.append(json.loads(path.read_text(encoding="utf-8")))
                except FileNotFoundError:
                    continue
            if phase == "disabled":
                if not result["hosts"] and not result["helpers"] and not ready:
                    config = root / "plugins/sockscap/data/config.json"
                    result["configSha256"] = hashlib.sha256(config.read_bytes()).hexdigest()
                    break
            elif len(result["hosts"]) == len(result["helpers"]) == 1:
                helper_pid = result["helpers"][0]["ProcessId"]
                host_pid = result["hosts"][0]["ProcessId"]
                matching = [row for row in ready if row.get("pid") == helper_pid]
                if (len(matching) == 1 and matching[0].get("elevated") is True
                        and matching[0].get("parentPid") == host_pid):
                    result["ready"] = matching[0]
                    with zipfile.ZipFile(owner.sockscap_resource_restore[0]) as archive:
                        digests = {}
                        for name in ("sockscap-helper.exe", "WinDivert.dll", "WinDivert64.sys"):
                            expected = hashlib.sha256(archive.read(f"resources/windows/{name}")).hexdigest()
                            actual = hashlib.sha256((staged.parent / name).read_bytes()).hexdigest()
                            if expected != actual:
                                raise StepError(f"Windows capture ran with untrusted bytes for {name}")
                            digests[name] = actual
                        result["payloadSha256"] = digests
                    break
            time.sleep(0.2)
        else:
            raise StepError(f"Windows capture ownership did not reach {phase}")
        result["passed"] = True
        return f"Windows signed capture ownership verified ({phase})"
    finally:
        status_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
