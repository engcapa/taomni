"""Bounded installed-app initialization with explicit platform shutdown evidence."""
import json
import os
from pathlib import Path
import platform
import re
import signal
import subprocess
import time
from collections.abc import Callable

MODE_LEASE_DENIAL = {
    "exitCode": 1,
    "modeLeaseError": True,
    "openedEndpoint": False,
    "ownerStillRunning": True,
}


def sanitized_output(raw):
    return re.sub(r"(?im)^.*pairing code.*$", "[ephemeral pairing code omitted]", raw)


def headless_command(executable: Path, data: Path) -> list[str]:
    return [str(executable), "--headless", "--data-dir", str(data), "--mobile-port", "0"]


def _run_desktop_contender(argv, desktop_env):
    windows = platform.system() == "Windows"
    with subprocess.Popen(
        argv, env=desktop_env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, start_new_session=not windows,
    ) as contender:
        try:
            output, _ = contender.communicate(timeout=20)
            return contender.returncode, output
        except subprocess.TimeoutExpired:
            if windows:
                subprocess.run(["taskkill.exe", "/PID", str(contender.pid), "/T", "/F"],
                               capture_output=True, timeout=15)
            else:
                try:
                    os.killpg(contender.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            output, _ = contender.communicate(timeout=10)
            return None, output


def observe_same_profile_contender(argv, owner_alive, evidence, label, *, desktop_env=None):
    if desktop_env is not None:
        exit_code, output = _run_desktop_contender(argv, desktop_env)
    else:
        try:
            result = subprocess.run(
                argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=20,
            )
            exit_code, output = result.returncode, result.stdout
        except subprocess.TimeoutExpired as error:
            exit_code, output = None, error.stdout or b""
    text = output.decode("utf-8", errors="replace")
    (Path(evidence) / (label + "-contender.log")).write_text(
        sanitized_output(text), encoding="utf-8",
    )
    mode_error = "Close the other Taomni mode using this profile first"
    denied = (mode_error in text if desktop_env is not None
              else f"Headless: {mode_error}" in text.splitlines())
    return {
        "exitCode": exit_code,
        "modeLeaseError": denied,
        "openedEndpoint": "Mobile endpoint:" in text,
        "ownerStillRunning": owner_alive(),
    }


def initialize_profile(
    executable, data, work, evidence, label, *, verify_mode_lease=False,
    observe_ready: Callable[[subprocess.Popen[bytes]], None] | None = None,
):
    """Use the installed release's documented headless entry.

    The legacy Windows release uses the GUI subsystem and exposes no headless quit
    endpoint. Its owned process tree is forcibly stopped; this is deliberately
    recorded as crash/recovery input, never described as a graceful shutdown.
    Unix must finish its SIGTERM handler with exit=0 or the case fails.
    """
    log = Path(work) / (label + ".raw.log")
    record = {"schema": "taomni.qa.legacy-start.v1", "dataRoot": str(data),
              "argv": headless_command(executable, data),
              "ready": False, "forcedCleanup": False}
    process = None
    windows = platform.system() == "Windows"
    try:
        with log.open("xb", buffering=0) as output:
            process = subprocess.Popen(record["argv"], stdout=output, stderr=subprocess.STDOUT,
                                       stdin=subprocess.DEVNULL, start_new_session=not windows)
            record["pid"] = process.pid
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                if log.stat().st_size > 512 * 1024:
                    raise RuntimeError("Legacy initialization exceeded its log bound")
                raw = log.read_text(encoding="utf-8", errors="replace")
                if re.search(r"Mobile endpoint: (?:http://)?127\.0\.0\.1:[1-9][0-9]*", raw):
                    record["ready"] = True
                    break
                if process.poll() is not None:
                    raise RuntimeError("Legacy app exited before reporting its loopback endpoint")
                time.sleep(0.05)
            if not record["ready"]:
                raise RuntimeError("Legacy app did not initialize within 60 seconds")
            if verify_mode_lease:
                contender = observe_same_profile_contender(
                    record["argv"], lambda: process.poll() is None, evidence, label,
                )
                record["sameProfileContender"] = contender
                if contender != MODE_LEASE_DENIAL:
                    raise RuntimeError("Candidate did not reject a second headless process for the same profile")
            if observe_ready is not None:
                observe_ready(process)
            if windows:
                record["shutdown"] = "owned GUI-subsystem process tree forced stop (crash input)"
                subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                               capture_output=True, timeout=15, check=True)
            else:
                record["shutdown"] = "SIGTERM handler"
                os.killpg(process.pid, signal.SIGTERM)
            record["exitCode"] = process.wait(timeout=15)
            if not windows and record["exitCode"] != 0:
                raise RuntimeError("Legacy app failed its normal Unix shutdown")
    finally:
        if process is not None and process.poll() is None:
            record["forcedCleanup"] = True
            if windows:
                subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                               capture_output=True, timeout=15)
            else:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=15)
        record["exited"] = process is not None and process.poll() is not None
        raw = log.read_text(encoding="utf-8", errors="replace") if log.exists() else ""
        (Path(evidence) / (label + ".log")).write_text(sanitized_output(raw), encoding="utf-8")
        (Path(evidence) / (label + ".json")).write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return record
