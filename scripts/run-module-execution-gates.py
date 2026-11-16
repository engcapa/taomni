#!/usr/bin/env python3
"""Run actual Linux noexec/alternative-directory gates on hosted runners only."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / ".agents/skills/qa-ui-auto/scripts"))
from linux_noexec import NoExecBind  # noqa: E402


def run(evidence: Path):
    if platform.system() != "Linux" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Real mount/process gates run only on GitHub Linux runners")
    evidence.mkdir(parents=True, exist_ok=True)
    environment = os.environ.copy()
    hosts = {}
    for variable, name in [("TAOMNI_HELLO_PLUGIN_BIN", "taomni-hello-plugin"),
                           ("TAOMNI_MFA_PLUGIN_BIN", "taomni-plugin-mfa")]:
        path = (ROOT / "src-tauri/target/debug" / name).resolve(strict=True)
        hosts[name] = {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        environment[variable] = str(path)
    command = ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml", "-p",
               "taomni-host-gates", "--test", "execution", "--locked", "--"]
    listing = subprocess.check_output(command + ["--ignored", "--list"], cwd=ROOT,
                                      text=True, env=environment, timeout=600)
    (evidence / "execution-selection.txt").write_text(listing, encoding="utf-8")
    if sum(line.endswith(": test") for line in listing.splitlines()) != 2:
        raise RuntimeError("Expected exactly two actual execution gate scenarios")
    receipt = {"schema": "taomni.module-execution-gates.v1", "platform": "linux-x86_64",
               "sourceSha": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
               "hosts": hosts, "systemTrust": "unverified", "packageFormats": "unverified",
               "allSelectedPassed": False}
    try:
        with tempfile.TemporaryDirectory(prefix="taomni-module-execution-") as temporary:
            owner = Path(temporary).resolve()
            blocked, alternative = owner / "noexec", owner / "exec"
            blocked.mkdir()
            alternative.mkdir()
            mount = NoExecBind(blocked, owner)
            environment.update(TAOMNI_NOEXEC_TEST_ROOT=str(blocked), TAOMNI_EXEC_TEST_ROOT=str(alternative))
            try:
                receipt["noexecMount"] = mount.block()
                receipt["alternativeDirectory"] = str(alternative)
                completed = subprocess.run(command + ["--ignored", "--test-threads=1", "--nocapture"],
                                           cwd=ROOT, text=True, capture_output=True,
                                           env=environment, timeout=180)
                log = completed.stdout + completed.stderr
                print(log, flush=True)
                (evidence / "execution-process.log").write_text(log, encoding="utf-8")
                receipt["exitCode"] = completed.returncode
                if completed.returncode != 0 or "2 passed; 0 failed; 0 ignored" not in log:
                    raise RuntimeError("Actual noexec/alternative host execution did not pass both scenarios")
                receipt["allSelectedPassed"] = True
            finally:
                mount.restore()
                receipt["fixtureMountRemoved"] = mount.mount_id is None
    finally:
        (evidence / "execution-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    run(parser.parse_args().evidence)
