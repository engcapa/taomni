#!/usr/bin/env python3
"""Probe ad-hoc hardened-runtime execution, without claiming release/TCC trust."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import tempfile
import time

from module_system_execution import ROOT, run_command, select_harness


def require_hosted():
    if (platform.system() != "Darwin" or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"):
        raise RuntimeError("System execution probes run only on disposable GitHub macOS runners")


def hardened_signature(output):
    match = re.search(r"flags=0x([a-fA-F0-9]+)", output)
    if not match or not int(match[1], 16) & 0x10000 or "Signature=adhoc" not in output:
        raise RuntimeError("Expected an actual ad-hoc signature with hardened runtime enabled")
    return {"identity": "adhoc", "hardenedRuntime": True, "details": output}


def run(evidence):
    require_hosted()
    evidence = evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    _, source = run_command(["git", "rev-parse", "HEAD"], evidence, "source")
    receipt = {"schema": "taomni.module-system-execution.v1", "sourceSha": source.strip(),
               "osVersion": platform.mac_ver()[0], "architecture": platform.machine(),
               "signingMode": "adhoc", "core": "production-process-adapter-experiment",
               "releasePackage": "unverified", "fixedCertificate": "unverified",
               "tcc": "unverified", "allSelectedPassed": False, "artifacts": {}}
    try:
        _, build = run_command(["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml",
                                "-p", "taomni-host-gates", "--test", "system_execution",
                                "--no-run", "--locked", "--message-format=json"],
                               evidence, "harness-build", timeout=900)
        executable = select_harness(build)
        with tempfile.TemporaryDirectory(prefix="taomni-system-execution-") as temporary:
            owner = Path(temporary).resolve()
            app = owner / "ModuleExecution.app"
            contents = app / "Contents"
            (contents / "MacOS").mkdir(parents=True)
            with (contents / "Info.plist").open("wb") as stream:
                plistlib.dump({"CFBundleIdentifier": "com.taomni.module-execution-gate",
                               "CFBundleExecutable": "gate-core", "CFBundlePackageType": "APPL",
                               "CFBundleVersion": "1", "CFBundleName": "Module execution gate"}, stream)
            driver = contents / "MacOS/gate-core"
            paths = {"core": driver, "hello": owner / "downloaded/taomni-hello-plugin",
                     "mfa": owner / "downloaded/taomni-plugin-mfa"}
            for name, source_path in {"core": executable,
                                      "hello": ROOT / "src-tauri/target/debug/taomni-hello-plugin",
                                      "mfa": ROOT / "src-tauri/target/debug/taomni-plugin-mfa"}.items():
                target = paths[name]
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source_path.resolve(strict=True), target)
                run_command(["codesign", "--force", "--sign", "-", "--options", "runtime",
                             "--identifier", "com.taomni.module-gate." + name, str(target)],
                            evidence, name + "-sign")
            run_command(["codesign", "--force", "--sign", "-", "--options", "runtime", str(app)],
                        evidence, "app-sign")
            for name, target in paths.items():
                run_command(["codesign", "--verify", "--strict", str(target)], evidence, name + "-verify")
                _, details = run_command(["codesign", "--display", "--verbose=4", str(target)],
                                         evidence, name + "-signature")
                record = hardened_signature(details)
                record["sha256"] = hashlib.sha256(target.read_bytes()).hexdigest()
                if name != "core":
                    quarantine = f"0083;{int(time.time()):08x};TaomniHostedGate;"
                    run_command(["xattr", "-w", "com.apple.quarantine", quarantine, str(target)],
                                evidence, name + "-set-quarantine")
                    _, actual = run_command(["xattr", "-p", "com.apple.quarantine", str(target)],
                                             evidence, name + "-quarantine")
                    if actual.strip() != quarantine:
                        raise RuntimeError("Downloaded host quarantine attribute differs")
                    record["quarantine"] = actual.strip()
                code, assessment = run_command(["spctl", "--assess", "--type", "execute", "--verbose=4",
                                                str(app if name == "core" else target)],
                                               evidence, name + "-gatekeeper", check=False)
                record["gatekeeper"] = {"exitCode": code, "output": assessment}
                receipt["artifacts"][name] = record
            environment = os.environ.copy()
            environment.update(TAOMNI_SYSTEM_EXECUTION_GATE="adhoc-hardened",
                               TAOMNI_HELLO_PLUGIN_BIN=str(paths["hello"]),
                               TAOMNI_MFA_PLUGIN_BIN=str(paths["mfa"]))
            _, listing = run_command([str(driver), "--ignored", "--list"], evidence, "selection",
                                      environment=environment)
            if sum(line.endswith(": test") for line in listing.splitlines()) != 2:
                raise RuntimeError("Expected both actual signed host experiments")
            code, output = run_command([str(driver), "--ignored", "--test-threads=1", "--nocapture"],
                                       evidence, "system-process", environment=environment,
                                       check=False, timeout=90)
            receipt["exitCode"] = code
            passed = code == 0 and "2 passed; 0 failed; 0 ignored" in output
            for name, target in paths.items():
                if hashlib.sha256(target.read_bytes()).hexdigest() != receipt["artifacts"][name]["sha256"]:
                    raise RuntimeError("System experiment modified a signed executable")
            receipt["allSelectedPassed"] = passed
            if not passed:
                raise RuntimeError("Ad-hoc hardened/quarantined host execution failed; inspect system-process.log")
    finally:
        (evidence / "system-execution-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    run(parser.parse_args().evidence)
