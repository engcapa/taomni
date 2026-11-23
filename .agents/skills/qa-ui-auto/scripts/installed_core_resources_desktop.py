"""Sample fresh production profiles for installed Windows and macOS builds."""

from contextlib import contextmanager
import json
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import time

import psutil

from installed_core_resources import record_comparison, sample_rss, summarize
from installed_macos_store import installed_macos_desktop
from installed_windows_mfa import installed_windows_desktop
from modular_bundle_inventory import write_json


READINESS = {
    "Windows": "Launch the installed app, then observe the visible X11 status segment with UI Automation",
    "Darwin": "Launch the installed app, then wait for the X11 status segment in the window's AXWebArea",
}


class ProfileRestoreError(RuntimeError):
    """The original upgrade profile is still in the same-volume staging path."""


@contextmanager
def fresh_profiles(profile):
    # The caller reserves the actual app data path on a disposable hosted runner.
    # Tauri uses the OS app data directory for both production versions.
    if not profile.is_dir() or profile.is_symlink():
        raise RuntimeError("Resource sampling requires the run-owned production profile")
    staging = Path(tempfile.mkdtemp(prefix=".taomni-startup-", dir=profile.parent))
    original = staging / "original"
    try:
        profile.rename(original)
    except OSError:
        staging.rmdir()
        raise
    try:
        yield staging
    finally:
        try:
            if profile.exists() or profile.is_symlink():
                profile.rename(staging / "last-sample")
            original.rename(profile)
        except OSError as error:
            raise ProfileRestoreError(f"Original upgrade profile retained at {original}: {error}") from error
        shutil.rmtree(staging)


def windows_observation(executable, work, evidence):
    evidence.mkdir()
    script = Path(__file__).with_name("installed_core_ready_windows.ps1")
    started = time.monotonic_ns()
    with installed_windows_desktop(executable, work, evidence, "startup") as owner:
        command = ["powershell.exe", "-NoProfile", "-NonInteractive", "-Sta", "-File", str(script),
                   "-OwnerId", str(owner.pid)]
        return observe_status(command, owner, executable, evidence, started)


def compile_macos_probe(work, evidence):
    driver = work / "installed-core-ready-macos"
    if not driver.is_file():
        source = Path(__file__).with_name("installed_core_ready_macos.swift")
        with (evidence / "compile-macos-readiness.log").open("wb") as log:
            subprocess.run(["swiftc", str(source), "-o", str(driver)], stdout=log,
                           stderr=subprocess.STDOUT, check=True, timeout=90)
    return driver


def macos_observation(driver, executable, work, evidence):
    started = time.monotonic_ns()
    with installed_macos_desktop(executable, work, evidence) as owner:
        command = [str(driver), str(owner.pid), str(executable)]
        return observe_status(command, owner, executable, evidence, started)


def observe_status(command, owner, executable, evidence, started):
    observed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=85)
    ready = time.monotonic_ns() - started
    (evidence / "readiness.stdout.txt").write_text(observed.stdout, encoding="utf-8")
    (evidence / "readiness.stderr.txt").write_text(observed.stderr, encoding="utf-8")
    if observed.returncode or owner.poll() is not None:
        raise RuntimeError(f"Installed app did not reach desktop status: {observed.stderr.strip()}")
    if json.loads(observed.stdout) != {"ownerPid": owner.pid, "statusMarker": "X11:"}:
        raise RuntimeError("Unexpected desktop readiness receipt")
    return sample(psutil.Process(owner.pid), executable, ready)


def sample(owner, executable, ready_ns):
    return {
        "readyMs": round(ready_ns / 1_000_000, 3),
        "rssBytes": sample_rss(owner, executable),
        "pid": owner.pid,
    }


def sample_desktop(executable, profile, work, evidence, label):
    system = platform.system()
    if system not in READINESS:
        raise RuntimeError("Expected a Windows or macOS production install")
    work.mkdir(parents=True, exist_ok=True)
    evidence.mkdir(parents=True, exist_ok=True)
    if system == "Darwin":
        driver = compile_macos_probe(work, evidence)

        def observe(attempt, receipt):
            return macos_observation(driver, executable, attempt, receipt)
    else:
        def observe(attempt, receipt):
            return windows_observation(executable, attempt, receipt)

    samples = []
    with fresh_profiles(profile) as staging:
        for index in range(1, 4):
            profile.mkdir()
            attempt = work / f"{label}-startup-{index}"
            attempt.mkdir()
            receipt = evidence / attempt.name
            measured = observe(attempt, receipt)
            if not (profile / "taomni.db").is_file():
                raise RuntimeError("The observed app did not initialize the isolated production profile")
            if any((profile / "plugins").glob("*/active.json")):
                raise RuntimeError("An installed module was present in the core startup comparison")
            samples.append(measured)
            write_json(receipt / "sample.json", measured)
            profile.rename(staging / attempt.name)
    result = summarize(executable, samples)
    write_json(evidence / f"{label}-samples.json", result)
    return result


def record_desktop_comparison(evidence, identity, original_package, candidate_package, original, candidate):
    return record_comparison(evidence, identity, original_package, candidate_package, original, candidate,
                             readiness=READINESS[platform.system()])
