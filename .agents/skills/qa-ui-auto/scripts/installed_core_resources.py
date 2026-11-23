"""Compare startup and core RSS for installed builds on the same runner."""

import os
from pathlib import Path
from statistics import median
import time

import psutil

from modular_bundle_inventory import digest, write_json
from qa_ui_auto.fixtures.module_legacy_mfa import (
    desktop_action,
    desktop_environment,
    element,
    installed_desktop,
)
from qa_ui_auto.native_steps import NativeStepContext


def sample_rss(owner, executable):
    if not Path(owner.exe()).samefile(executable):
        raise RuntimeError("The measured PID is not the installed executable")
    rss = []
    for sample in range(3):
        if sample > 0:
            time.sleep(0.25)
        if not owner.is_running():
            raise RuntimeError("The installed executable exited during RSS sampling")
        rss.append(owner.memory_info().rss)
    if min(rss) <= 0:
        raise RuntimeError("Could not read resident memory for the installed executable")
    return rss


def linux_owner(driver, executable):
    matches = []
    for process in psutil.Process(driver.proc.pid).children(recursive=True):
        try:
            owned = Path(process.exe()).samefile(executable)
        except (OSError, psutil.NoSuchProcess):
            continue
        if owned:
            matches.append(process)
    if len(matches) != 1:
        raise RuntimeError("Expected one installed Taomni executable in the owned driver process tree")
    return matches[0]


def sample_linux(ctx, executable, work, evidence, label):
    samples = []
    for index in range(3):
        attempt = f"{label}-startup-{index + 1}"
        desktop = work / attempt
        environment, profile = desktop_environment(desktop)
        if profile.exists() or profile.is_symlink():
            raise RuntimeError("The startup comparison requires a new isolated profile for every launch")
        started = time.monotonic_ns()
        with installed_desktop(ctx, executable, desktop, evidence, attempt, environment=environment) as (driver, session):
            desktop_action(NativeStepContext(session, evidence, ctx.cfg), "wait_for", element("status-bar"))
            ready_ms = (time.monotonic_ns() - started) / 1_000_000
            owner = linux_owner(driver, executable)
            rss = sample_rss(owner, executable)
            if any((profile / "plugins").glob("*/active.json")):
                raise RuntimeError("An installed module was present in the core startup comparison")
            samples.append({"readyMs": round(ready_ms, 3), "rssBytes": rss, "pid": owner.pid})
    return summarize(executable, samples)


def summarize(executable, samples):
    return {"executableSha256": digest(executable), "samples": samples,
            "medianReadyMs": median(sample["readyMs"] for sample in samples),
            "medianCoreRssBytes": median(median(sample["rssBytes"]) for sample in samples)}


def record_linux_comparison(evidence, target, old_package, candidate_package, original, candidate):
    return record_comparison(
        evidence, target, old_package, candidate_package, original, candidate,
        readiness="Launch the owned WebDriver and app, then wait for the visible status bar",
    )


def record_comparison(evidence, target, old_package, candidate_package, original, candidate, *, readiness):
    result = {
        "schema": "taomni.qa.installed-core-resources.v1",
        "producerSource": target["producerSource"],
        "producerRun": target["producerRun"],
        "target": target["target"],
        "verificationRun": os.environ["GITHUB_RUN_ID"],
        "verificationSource": os.environ.get("GITHUB_SHA"),
        "runnerArchitecture": os.environ.get("RUNNER_ARCH"),
        "runnerImage": os.environ.get("ImageOS"),
        "runnerImageVersion": os.environ.get("ImageVersion"),
        "readiness": readiness,
        "residentMemory": "RSS of the installed core PID sampled three times after readiness",
        "original": {**original, "installerSha256": digest(old_package)},
        "candidate": {**candidate, "installerSha256": digest(candidate_package)},
        "readyMsChange": candidate["medianReadyMs"] - original["medianReadyMs"],
        "coreRssBytesChange": candidate["medianCoreRssBytes"] - original["medianCoreRssBytes"],
    }
    write_json(evidence / "installed-core-resources.json", result)
    return result
