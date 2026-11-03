#!/usr/bin/env python3
"""Run the selected native six-worker UI lane inside the existing CI namespace.

The ordinary ci_execute/native_build identity and runner receipts are reused.
All dependency downloads finish before namespace entry; a verified release
runtime artifact is mandatory, so this lane cannot silently rebuild or go live.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from receipts import assert_isolated_network


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selection", type=Path, required=True)
    parser.add_argument("--entry", required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--installation", type=Path, required=True)
    parser.add_argument("--native-artifact", type=Path, required=True)
    parser.add_argument("--adapter-bin", type=Path, required=True)
    parser.add_argument("--adapter-sha256", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--attempt", required=True)
    args = parser.parse_args()
    assert_isolated_network()
    if os.environ.get("GITHUB_ACTIONS") != "true":
        parser.error("native real workers run only in GitHub Actions")
    selection = args.selection.resolve()
    manifest = json.loads(selection.read_text())
    matches = [entry for entry in manifest["entries"] if entry["id"] == args.entry]
    if len(matches) != 1:
        parser.error("unknown or duplicate native selection entry")
    entry = matches[0]
    if (entry["mode"] != "native" or entry["platform_key"] != "linux"
            or set(entry["selected_ids"]) != {"TC-ORCH-WORKER-004"}
            or not {"release", "orchestration-workers"}.issubset(entry["capabilities"])):
        parser.error("native worker entry must own exactly the six-worker release case")
    if str(args.run_id) != str(manifest.get("run_id")) or str(args.attempt) != str(manifest.get("attempt")):
        parser.error("native worker invocation identity differs from the selection")
    installation = args.installation.resolve()
    installed = json.loads(installation.read_text())
    artifact = args.native_artifact.resolve()
    if not artifact.is_file():
        parser.error("matching prebuilt native release runtime is required")
    adapter_bin = args.adapter_bin
    adapter = adapter_bin / "tauri-driver"
    if (not adapter_bin.is_absolute() or adapter_bin.resolve() != adapter_bin or not adapter.is_file()
            or hashlib.sha256(adapter.read_bytes()).hexdigest() != args.adapter_sha256):
        parser.error("preinstalled native adapter path or SHA-256 changed before namespace execution")
    report = args.report.resolve()
    report.mkdir(parents=True, exist_ok=True)
    home = report / "_launcher-home"
    home.mkdir(mode=0o700, exist_ok=False)
    scripts = Path(__file__).resolve().parents[3] / ".agents" / "skills" / "qa-ui-auto" / "scripts"
    if not (scripts / "ci_execute.py").is_file():
        parser.error("cannot locate the trusted native QA launcher")
    # No personal HOME, inherited auth/proxy, Node injection, or cloud tokens.
    node_dir = str(Path(installed["node"]).parent)
    env = {"HOME": str(home), "USERPROFILE": str(home), "PATH": node_dir + ":" + str(adapter_bin) + ":/usr/local/bin:/usr/bin:/bin",
           "XDG_CONFIG_HOME": str(home / ".config"), "XDG_CACHE_HOME": str(home / ".cache"),
           "XDG_DATA_HOME": str(home / ".local/share"), "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
           "PYTHONPATH": str(scripts), "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1",
           "GITHUB_ACTIONS": "true", "GITHUB_RUN_ID": args.run_id, "GITHUB_RUN_ATTEMPT": args.attempt,
           "QA_NATIVE_ARTIFACT": str(artifact), "QA_ORCHESTRATION_INSTALLATION": str(installation),
           "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
           "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"}
    command = [sys.executable, str(scripts / "ci_execute.py"), "--selection", str(selection),
               "--entry", args.entry, "--report", str(report)]
    if entry.get("linux_wrapper") == "xvfb":
        command = ["dbus-run-session", "--", "xvfb-run", "-a", "-s",
                   "-screen 0 1920x1080x24 -nolisten tcp -noreset", *command]
    elif entry.get("linux_wrapper") == "dbus":
        command = ["dbus-run-session", "--", *command]
    else:
        parser.error("native worker entry requires a planned owned desktop wrapper")
    (report / "orchestration-adapter.identity.json").write_text(json.dumps({
        "path": str(adapter), "sha256": args.adapter_sha256,
        "installation": "preinstalled tauri-driver 2.0.4; no download inside namespace"}, indent=2) + "\n")
    result = subprocess.run(command, cwd=scripts.parents[3], env=env, check=False)
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
