"""Separate ordinary launch memory from accessibility traversal and collect independent allocation diagnostics."""
from contextlib import suppress
import json
from pathlib import Path
import subprocess
import time

import psutil

from installed_core_resources import sample_rss
from installed_core_resources_desktop import observe_status
from installed_macos_store import installed_macos_desktop
from modular_bundle_inventory import write_json


def window_driver(work):
    probe = work / "core-memory-visible-window"
    subprocess.run(["swiftc", str(Path(__file__).with_name("installed_macos_memory_window.swift")), "-o", str(probe)],
                   check=True, timeout=90)
    return probe


def visible(driver, owner, start):
    data = json.loads(subprocess.check_output([str(driver), str(owner.pid)], timeout=55))
    if data["ownerPid"] != owner.pid or data["width"] < 300 or data["height"] < 200:
        raise RuntimeError("WindowServer did not identify the installed app's visible window")
    return {**data, "milliseconds": round((time.monotonic_ns() - start) / 1e6, 3)}


def snapshot(owner, executable, start, footprint):
    if owner.poll() is not None:
        raise RuntimeError("Installed app exited before its process could be observed")
    return {"elapsedMs": round((time.monotonic_ns() - start) / 1e6, 3),
            "rssBytes": sample_rss(psutil.Process(owner.pid), executable), **footprint(owner.pid)}


def measure_interaction(window, ready, executable, evidence, work, footprint):
    start = time.monotonic_ns()
    with installed_macos_desktop(executable, work, evidence) as owner:
        result = {"window": visible(window, owner, start)}
        result["atWindow"] = snapshot(owner, executable, start, footprint)
        for seconds in [10, 30]:
            time.sleep(max(0, seconds - (time.monotonic_ns() - start) / 1e9))
            result[f"preAX{seconds}"] = snapshot(owner, executable, start, footprint)
        result["AX"] = observe_status([str(ready), str(owner.pid), str(executable)], owner, executable, evidence, start)
        result["afterAX"] = snapshot(owner, executable, start, footprint)
        time.sleep(5)
        result["afterAX5"] = snapshot(owner, executable, start, footprint)
        write_json(evidence / "window-accessibility-memory.json", result)
        return result


def capture(args, target, timeout, limit=12 * 1024 * 1024):
    # Keep output bounded while letting the system tool finish and release the target.
    raw = target.with_suffix(".tmp")
    with raw.open("wb") as output:
        try:
            proc = subprocess.run(args, stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
            status = proc.returncode
        except subprocess.TimeoutExpired:
            status = "timed-out"
    size = raw.stat().st_size
    with raw.open("rb") as stream:
        target.write_bytes(stream.read(limit))
    raw.unlink()
    return {"exitCode": status, "file": target.name, "totalBytes": size, "savedBytes": min(size, limit)}


def allocation_profile(window, ready, executable, evidence, work, footprint):
    start = time.monotonic_ns()
    with installed_macos_desktop(executable, work, evidence, {"MallocStackLogging": "1"}) as owner:
        with (evidence / "sample-stderr.txt").open("wb") as log:
            profiler = subprocess.Popen(["/usr/bin/sample", str(owner.pid), "5", "3", "-file",
                                         str(evidence / "startup-stacks.txt")], stdout=log, stderr=subprocess.STDOUT)
            try:
                result = {"window": visible(window, owner, start)}
                time.sleep(max(0, 15 - (time.monotonic_ns() - start) / 1e9))
                result["preAX"] = snapshot(owner, executable, start, footprint)
                result["heapBeforeAX"] = capture(["/usr/bin/heap", "-s", str(owner.pid)],
                                                evidence / "heap-before-AX.txt", 55)
                result["AX"] = observe_status([str(ready), str(owner.pid), str(executable)],
                                              owner, executable, evidence, start)
                result["afterAX"] = snapshot(owner, executable, start, footprint)
                result["heapAfterAX"] = capture(["/usr/bin/heap", "-s", str(owner.pid)],
                                                evidence / "heap-after-AX.txt", 55)
                result["allocations"] = capture(["/usr/bin/malloc_history", str(owner.pid), "-allBySize"],
                                                evidence / "allocation-stacks.txt", 75)
                write_json(evidence / "allocation-profile.json", result)
                return result
            finally:
                if profiler.poll() is None:
                    profiler.terminate()
                with suppress(subprocess.TimeoutExpired):
                    profiler.wait(timeout=8)
                if profiler.poll() is None:
                    profiler.kill()
                    profiler.wait()
