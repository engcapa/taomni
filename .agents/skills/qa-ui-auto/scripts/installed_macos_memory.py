"""Compare installed core memory on one ARM64 runner after both versions have the same grants."""
from contextlib import contextmanager
import ctypes
import os
from statistics import median
import subprocess
import time

import psutil

from installed_macos_allocations import allocation_profile, measure_interaction, window_driver

from installed_core_resources import sample_rss
from installed_core_resources_desktop import compile_macos_probe, fresh_profiles, observe_status
from installed_macos_store import installed_macos_desktop
from modular_bundle_inventory import digest, write_json


# Alternate which version starts first within each pair.
PAIRS = (("original", "candidate"), ("candidate", "original")) * 2


class ResourceUsage(ctypes.Structure):
    # Darwin <sys/resource.h>, rusage_info_v0.
    _fields_ = [("uuid", ctypes.c_ubyte * 16)] + [
        (field, ctypes.c_uint64) for field in (
            "user_time", "system_time", "pkg_idle_wkups", "interrupt_wkups", "pageins", "wired_size",
            "resident_size", "phys_footprint", "proc_start_abstime", "proc_exit_abstime",
        )
    ]


def footprint(pid):
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    read = libproc.proc_pid_rusage
    read.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    read.restype = ctypes.c_int
    usage = ResourceUsage()
    if read(pid, 0, ctypes.byref(usage)) != 0:
        raise OSError(ctypes.get_errno(), "proc_pid_rusage failed on the installed core")
    return {"physicalFootprintBytes": usage.phys_footprint, "residentBytes": usage.resident_size}


@contextmanager
def app_version(label, candidate, original, parked):
    if label == "candidate":
        yield
        return
    candidate.rename(parked)
    try:
        original.rename(candidate)
        try:
            yield
        finally:
            candidate.rename(original)
    finally:
        parked.rename(candidate)


def memory_map(owner, folder, name, *, detailed=False):
    if owner.poll() is not None:
        raise RuntimeError("The installed app exited before memory mapping")
    path = folder / f"{name}.txt"
    args = ["-wide", "-resident"] if detailed else ["-summary", "-resident"]
    with path.open("w", encoding="utf-8") as log:
        result = subprocess.run(["/usr/bin/vmmap", *args, str(owner.pid)], stdout=log,
                                stderr=subprocess.STDOUT, timeout=45)
    if result.returncode:
        elevated = folder / f"{name}-sudo.txt"
        with elevated.open("w", encoding="utf-8") as log:
            retry = subprocess.run(["sudo", "-n", "/usr/bin/vmmap", *args, str(owner.pid)],
                                   stdout=log, stderr=subprocess.STDOUT, timeout=45)
        return {"path": path.name, "exitCode": result.returncode, "retryPath": elevated.name,
                "retryExitCode": retry.returncode}
    return {"path": path.name, "exitCode": result.returncode}


def sample(driver, executable, folder, work, *, maps):
    started = time.monotonic_ns()
    with installed_macos_desktop(executable, work, folder) as owner:
        command = [str(driver), str(owner.pid), str(executable)]
        result = observe_status(command, owner, executable, folder, started)
        ready = started + int(result["readyMs"] * 1e6)
        result["readyMemory"] = footprint(owner.pid)
        observations = []
        process = psutil.Process(owner.pid)
        for seconds in (5, 15, 30):
            time.sleep(max(0, seconds - (time.monotonic_ns() - ready) / 1e9))
            observations.append({
                "secondsFromReady": round((time.monotonic_ns() - ready) / 1e9, 3),
                "rssBytes": sample_rss(process, executable), **footprint(owner.pid),
            })
        result["idleMemory"] = observations
        # Run vmmap after the timing samples so profiler work cannot influence them.
        result["vmSummary"] = memory_map(owner, folder, "vmmap-summary")
        if maps:
            result["vmRegions"] = memory_map(owner, folder, "vmmap-regions", detailed=True)
        write_json(folder / "sample.json", result)
        return result


def ready_regions(driver, executable, work, evidence):
    started = time.monotonic_ns()
    with installed_macos_desktop(executable, work, evidence) as owner:
        row = observe_status([str(driver), str(owner.pid), str(executable)], owner, executable, evidence, started)
        row["memory"] = footprint(owner.pid)
        row["vmRegions"] = memory_map(owner, evidence, "vmmap-ready-regions", detailed=True)
        write_json(evidence / "ready-regions.json", row)
    return row


def compare(executable, profile, work, report, stages, identity):
    evidence = report / "macos-core-memory"
    evidence.mkdir()
    target = executable.parents[2]
    driver = compile_macos_probe(work, evidence)
    permissions = {
        label: {key: stages[label + "Permissions"][key] for key in
                ("screenRecording", "accessibility", "requirement", "binarySha256")}
        for label in ("original", "candidate")
    }
    if not stages["permissionContinuity"]["retainedBothGrants"]:
        raise RuntimeError("The paired measurement requires matching app identity and granted permissions")
    result = {"producerSource": identity["producerSource"], "producerRun": identity["producerRun"],
              "verificationRun": os.environ["GITHUB_RUN_ID"], "runnerImage": os.environ["ImageVersion"],
              "verificationSource": os.environ["GITHUB_SHA"], "permissions": permissions, "samples": []}
    index = evidence / "paired-core-memory.json"
    with fresh_profiles(profile) as staging:
        for pair, labels in enumerate(PAIRS, 1):
            for label in labels:
                sample_id = f"{pair}-{label}"
                with app_version(label, target, work / "original.app", work / "memory-sample-candidate.app"):
                    binary_sha = digest(executable)
                    if binary_sha != permissions[label]["binarySha256"]:
                        raise RuntimeError("Sampled app differs from the installed app with verified grants")
                    profile.mkdir()
                    row = sample(driver, executable, evidence / sample_id, work, maps=pair == 1)
                    if not (profile / "taomni.db").is_file() or any((profile / "plugins").glob("*/active.json")):
                        raise RuntimeError("The sampled app must have initialized a fresh core-only profile")
                    profile.rename(staging / sample_id)
                    result["samples"].append({"label": label, "pair": pair, "binarySha256": binary_sha, **row})
                    write_json(index, result)
        # Use independent launches for early maps. Attaching vmmap perturbs the target.
        result["readyRegions"] = {}
        for label in ("original", "candidate"):
            with app_version(label, target, work / "original.app", work / "memory-sample-candidate.app"):
                profile.mkdir()
                result["readyRegions"][label] = ready_regions(driver, executable, work, evidence / f"{label}-ready")
                profile.rename(staging / f"{label}-ready")
        window = window_driver(work)
        result["windowSamples"] = []
        for pair, labels in enumerate(PAIRS[:2], 1):
            for label in labels:
                sample_id = f"window-{pair}-{label}"
                with app_version(label, target, work / "original.app", work / "memory-sample-candidate.app"):
                    profile.mkdir()
                    row = measure_interaction(window, driver, executable, evidence / sample_id, work, footprint)
                    result["windowSamples"].append({"label": label, "pair": pair, **row})
                    profile.rename(staging / sample_id)
                    write_json(index, result)
        result["allocationProfiles"] = {}
        for label in ("original", "candidate"):
            sample_id = f"allocations-{label}"
            with app_version(label, target, work / "original.app", work / "memory-sample-candidate.app"):
                profile.mkdir()
                result["allocationProfiles"][label] = allocation_profile(
                    window, driver, executable, evidence / sample_id, work, footprint,
                )
                profile.rename(staging / sample_id)
                write_json(index, result)
    for label in ("original", "candidate"):
        rows = [s for s in result["samples"] if s["label"] == label]
        result[label] = {
            "readyRssBytes": median(median(s["rssBytes"]) for s in rows),
            "readyFootprintBytes": median(s["readyMemory"]["physicalFootprintBytes"] for s in rows),
            "idle30RssBytes": median(median(s["idleMemory"][-1]["rssBytes"]) for s in rows),
            "idle30FootprintBytes": median(s["idleMemory"][-1]["physicalFootprintBytes"] for s in rows),
        }
    write_json(index, result)
    return {"path": str(index.relative_to(report)), "original": result["original"], "candidate": result["candidate"]}
