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
from installed_windows_webview import installed_webview
from modular_bundle_inventory import write_json
from qa_ui_auto.fixtures.module_legacy_mfa import desktop_action, element
from qa_ui_auto.native_steps import NativeStepContext


READINESS = {
    "Windows": "Launch the installed app and its owned EdgeDriver, then wait for the visible status bar",
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


def windows_observation(ctx, executable, work, evidence):
    started = time.monotonic_ns()
    with installed_webview(executable, work / "webview", evidence, 75) as (driver, session):
        desktop_action(NativeStepContext(session, evidence, ctx.cfg), "wait_for", element("status-bar"))
        ready = time.monotonic_ns() - started
        owner = psutil.Process(driver.application_process.pid)
        return sample(owner, executable, ready)


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
        observed = subprocess.run(
            [str(driver), str(owner.pid), str(executable)],
            capture_output=True, text=True, encoding="utf-8", timeout=80,
        )
        ready = time.monotonic_ns() - started
        (evidence / "readiness.stdout.txt").write_text(observed.stdout, encoding="utf-8")
        (evidence / "readiness.stderr.txt").write_text(observed.stderr, encoding="utf-8")
        if observed.returncode or owner.poll() is not None:
            raise RuntimeError(f"Installed macOS app did not reach UI readiness: {observed.stderr.strip()}")
        receipt = json.loads(observed.stdout)
        if receipt != {"ownerPid": owner.pid, "statusMarker": "X11:"}:
            raise RuntimeError("Unexpected macOS readiness receipt")
        return sample(psutil.Process(owner.pid), executable, ready)


def sample(owner, executable, ready_ns):
    return {
        "readyMs": round(ready_ns / 1_000_000, 3),
        "rssBytes": sample_rss(owner, executable),
        "pid": owner.pid,
    }


def sample_desktop(ctx, executable, profile, work, evidence, label):
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
            return windows_observation(ctx, executable, attempt, receipt)

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
