"""Independent process observations for the exact app owned by this QA driver."""
from __future__ import annotations

import json
import os
from pathlib import Path
import platform
import subprocess
import time

from .steps import StepError


def snapshot() -> list[dict]:
    system = platform.system()
    if system == "Windows":
        command = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress"
        result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", command], capture_output=True, text=True, timeout=15, check=True)
        data = json.loads(result.stdout)
        return [{"pid": int(row["ProcessId"]), "parent": int(row["ParentProcessId"]), "executable": row.get("ExecutablePath")} for row in data]
    if system == "Darwin":
        result = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,comm="], capture_output=True, text=True, timeout=10, check=True)
        return [{"pid": int(parts[0]), "parent": int(parts[1]), "executable": parts[2]} for line in result.stdout.splitlines() if len(parts := line.strip().split(None, 2)) == 3]
    rows = []
    for path in Path("/proc").iterdir():
        if not path.name.isdigit():
            continue
        try:
            fields = (path / "stat").read_text().rsplit(")", 1)[1].split()
            rows.append({"pid": int(path.name), "parent": int(fields[1]), "executable": os.readlink(path / "exe")})
        except (OSError, ValueError, IndexError):
            continue
    return rows


def owned_apps(rows: list[dict], driver_pid: int, application: Path) -> list[dict]:
    owned = {driver_pid}
    for _ in range(len(rows)):
        descendants = {row["pid"] for row in rows if row["parent"] in owned}
        if descendants.issubset(owned):
            break
        owned.update(descendants)
    target = os.path.normcase(str(application.resolve()))
    return [row for row in rows if row["pid"] in owned and row.get("executable") and os.path.normcase(str(Path(row["executable"]).resolve())) == target]


def observe(ctx, args):
    harness = getattr(ctx.session, "_harness", None)
    if harness is None or harness.driver.proc is None:
        raise StepError("native_app_process requires the run-owned native driver")
    deadline = time.monotonic() + args.get("timeout_sec", 15)
    expected = args["state"]
    saved = getattr(ctx, "_app_processes", None)
    if expected == "exited" and not saved:
        raise StepError("Observe the owned running app before asserting exit")
    samples = []
    passed = False
    while time.monotonic() < deadline:
        rows = snapshot()
        if expected == "running":
            apps = owned_apps(rows, harness.driver.proc.pid, harness.application)
            passed = len(apps) == 1
            if passed:
                ctx._app_processes = apps
        else:
            apps = [row for row in rows if any(row["pid"] == old["pid"] and row["executable"] == old["executable"] for old in saved)]
            passed = not apps
        samples.append({"time": time.time(), "apps": apps})
        if passed:
            break
        time.sleep(.2)
    ctx.case_dir.mkdir(parents=True, exist_ok=True)
    with (ctx.case_dir / "native-app-processes.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"expected": expected, "passed": passed, "samples": samples}) + "\n")
    if not passed:
        raise StepError(f"The owned QA app did not reach process state {expected}")
