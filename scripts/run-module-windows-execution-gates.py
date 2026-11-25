#!/usr/bin/env python3
"""Observe unsigned, download-marked hosts under the runner's Windows protection."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import tempfile

from module_system_execution import ROOT, run_command, select_harness

ZONE = "[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://module-execution.invalid/host.exe\r\n"


def require_hosted():
    if (platform.system() != "Windows" or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"):
        raise RuntimeError("System execution probes run only on disposable GitHub Windows runners")


def observe(evidence, name, operation, target=None):
    environment = os.environ.copy()
    if target is not None:
        environment["TAOMNI_OBSERVED_MODULE_HOST"] = str(target)
    _, output = run_command(["pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
                             str(ROOT / "scripts/observe-module-windows-execution.ps1"),
                             "-Operation", operation], evidence, name, environment=environment)
    return json.loads(output)


def validate_host_observation(record, target, *, downloaded):
    if Path(record.get("path", "")).resolve(strict=True) != target:
        raise RuntimeError("Authenticode observation belongs to a different executable")
    if record.get("authenticodeStatus") != "NotSigned":
        raise RuntimeError("Expected an actually unsigned compiler-produced experiment executable")
    if downloaded and record.get("zoneIdentifier") != ZONE:
        raise RuntimeError("Downloaded host Zone.Identifier differs from the Internet-zone fixture")


def run(evidence, *, require_defender=False):
    require_hosted()
    evidence = evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    receipt = {"schema": "taomni.module-windows-execution.v1", "sourceSha": None,
               "osVersion": platform.version(), "architecture": platform.machine(),
               "core": "production-process-adapter-experiment", "signingMode": "unsigned",
               "downloadMark": "synthetic-Internet-zone-ADS-read-back",
               "releasePackage": "unverified", "systemTrust": "unverified",
               "smartScreenReputation": "unverified", "allSelectedPassed": False, "artifacts": {},
               "requiresDefenderRealTimeProtection": require_defender}
    try:
        _, source = run_command(["git", "rev-parse", "HEAD"], evidence, "source")
        receipt["sourceSha"] = source.strip()
        receipt["securityBefore"] = observe(evidence, "security-before", "security")
        if require_defender and receipt["securityBefore"]["defender"].get("realTimeProtectionEnabled") is not True:
            raise RuntimeError("Defender real-time protection must be active before launching the host")
        _, build = run_command(["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml",
                                "-p", "taomni-host-gates", "--test", "windows_system_execution",
                                "--no-run", "--locked", "--message-format=json"],
                               evidence, "harness-build", timeout=900)
        executable = select_harness(build, "windows_system_execution")
        local_data = Path(os.environ["LOCALAPPDATA"]).resolve(strict=True)
        with tempfile.TemporaryDirectory(prefix="taomni-module-execution-", dir=local_data) as temporary:
            owner = Path(temporary).resolve()
            mfa_manifest = ROOT / "src-tauri/plugins/mfa/module.json"
            mfa_version = json.loads(mfa_manifest.read_text(encoding="utf-8"))["version"]
            paths = {"core": owner / "core/gate-core.exe",
                     "hello": owner / "modules/hello/0.1.0/taomni-hello-plugin.exe",
                     "mfa": owner / "modules" / "mfa" / mfa_version / "taomni-plugin-mfa.exe"}
            for name, source_path in {"core": executable,
                                      "hello": ROOT / "src-tauri/target/debug/taomni-hello-plugin.exe",
                                      "mfa": ROOT / "src-tauri/target/debug/taomni-plugin-mfa.exe"}.items():
                target = paths[name]
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source_path.resolve(strict=True), target)
                if name != "core":
                    Path(str(target) + ":Zone.Identifier").write_bytes(ZONE.encode("utf-8"))
                record = observe(evidence, name + "-observation", "host", target)
                validate_host_observation(record, target, downloaded=name != "core")
                record["sha256"] = hashlib.sha256(target.read_bytes()).hexdigest()
                receipt["artifacts"][name] = record
            environment = os.environ.copy()
            environment.update(TAOMNI_WINDOWS_SYSTEM_EXECUTION_GATE="zone-identifier-unsigned",
                               TAOMNI_HELLO_PLUGIN_BIN=str(paths["hello"]),
                               TAOMNI_MFA_PLUGIN_BIN=str(paths["mfa"]))
            _, listing = run_command([str(paths["core"]), "--ignored", "--list"], evidence,
                                      "selection", environment=environment)
            if sum(line.endswith(": test") for line in listing.splitlines()) != 2:
                raise RuntimeError("Expected both actual download-marked host experiments")
            code, output = run_command([str(paths["core"]), "--ignored", "--test-threads=1", "--nocapture"],
                                       evidence, "system-process", environment=environment,
                                       check=False, timeout=90)
            receipt["exitCode"] = code
            for name, target in paths.items():
                after = observe(evidence, name + "-after", "host", target)
                validate_host_observation(after, target, downloaded=name != "core")
                if hashlib.sha256(target.read_bytes()).hexdigest() != receipt["artifacts"][name]["sha256"]:
                    raise RuntimeError("System experiment modified an executable")
                receipt["artifacts"][name]["after"] = after
            receipt["securityAfter"] = observe(evidence, "security-after", "security")
            if require_defender and receipt["securityAfter"]["defender"].get("realTimeProtectionEnabled") is not True:
                raise RuntimeError("Defender real-time protection was inactive after host execution")
            receipt["allSelectedPassed"] = code == 0 and "2 passed; 0 failed; 0 ignored" in output
            if not receipt["allSelectedPassed"]:
                raise RuntimeError("Unsigned download-marked host execution failed; inspect system-process.log")
    finally:
        (evidence / "windows-execution-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--require-defender", action="store_true")
    args = parser.parse_args()
    run(args.evidence, require_defender=args.require_defender)
