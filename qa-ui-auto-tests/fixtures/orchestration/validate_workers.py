#!/usr/bin/env python3
"""GitHub-only real harness canary; not a substitute for Taomni scheduler/UI QA."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from behavior import WORKER_MARKER
from diagnostics import failure_context, sandbox_host_facts
from harness_config import CATALOG_PATH, verify_installation
from receipts import (assert_isolated_network, clean_environment, validate_artifact,
                      validate_worker_events)
from server import start_fixture
from worker_bridge import run_worker


def git(command: list[str], cwd: Path, env: dict) -> bytes:
    result = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", *command], cwd=cwd,
                            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    if result.returncode:
        raise RuntimeError("isolated fixture Git operation failed")
    return result.stdout


def validate(installation: dict, output: Path, harnesses: list[str], timeout: int) -> dict:
    assert_isolated_network()
    host_facts = sandbox_host_facts()
    # Inventory failures are captured, not a successful skipped matrix entry.
    failures, available = [], []
    for harness in harnesses:
        try:
            verify_installation(installation, harness)
            available.append(harness)
        except (ValueError, OSError) as exc:
            failures.append({"harness": harness, "status": "blocked", "reason": str(exc)})
    home = output / "git-home"
    home.mkdir(mode=0o700)
    env = clean_environment(home, "/usr/local/bin:/usr/bin:/bin")
    repository = output / "source"
    repository.mkdir()
    git(["init", "--quiet"], repository, env)
    git(["-c", "user.name=QA Fixture", "-c", "user.email=qa@example.invalid", "-c", "commit.gpgsign=false",
         "commit", "--allow-empty", "--quiet", "-m", "isolated fixture baseline"], repository, env)
    base = git(["rev-parse", "HEAD"], repository, env).decode().strip()
    worktrees = output / "worktrees"
    worktrees.mkdir(mode=0o700)
    roots = {name: worktrees / name for name in available}
    for root in roots.values():
        git(["worktree", "add", "--detach", "--quiet", str(root), base], repository, env)
    fixture = start_fixture(output / "requests.ndjson", roots)
    run_id = "ci-" + uuid.uuid4().hex
    passed = []
    try:
        for harness, root in roots.items():
            metadata = {"mode": "worker", "run_id": run_id, "worker_id": harness,
                        "marker_path": "taomni-worker-marker.txt", "marker_text": f"taomni:{run_id}:{harness}\n"}
            prompt = ("Execute the single harmless shell tool supplied by the fixture provider in your actual current "
                      "worktree. Do not delegate, retry failed tools, read credentials, use other tools or request network "
                      "resources. Then return the provider's final structured result unchanged.\n"
                      + WORKER_MARKER + json.dumps(metadata, separators=(",", ":")))
            start = len(fixture.application.events)
            try:
                bridge = run_worker(installation, harness, fixture.base_url, root,
                                    output / ("state-" + harness), prompt, timeout)
                wire = validate_worker_events(fixture.application.events[start:], harness,
                                               installation["harnesses"][harness]["protocol"])
                artifact = validate_artifact(root, metadata["marker_text"], list(roots.values()), repository)
                changes = git(["status", "--porcelain", "--untracked-files=all"], root, env).decode().splitlines()
                if changes != ["?? taomni-worker-marker.txt"]:
                    raise AssertionError("worker changed files other than its assigned marker")
                if git(["status", "--porcelain", "--untracked-files=all"], repository, env):
                    raise AssertionError("worker modified the source repository")
                if git(["rev-parse", "HEAD"], root, env).decode().strip() != base:
                    raise AssertionError("worker changed its assigned base commit")
                receipt = {"harness": harness, "status": "passed", "base_commit": base,
                           "wire": wire, "artifact": artifact, "process": bridge["fixture_evidence"]}
                passed.append(receipt)
                (output / (harness + ".receipt.json")).write_text(json.dumps(receipt, indent=2) + "\n")
            except (ValueError, RuntimeError, AssertionError, OSError, subprocess.TimeoutExpired) as exc:
                # Exceptions from our own validators carry no upstream text;
                # raw provider/harness diagnostics remain private under state.
                failures.append({"harness": harness, "status": "failed", "reason": str(exc),
                                 "diagnostic": failure_context(output / ("state-" + harness),
                                                               fixture.application.events[start:])})
    finally:
        fixture.close()
    report = {"schema_version": 1, "scope": "standalone_real_harness_canary_not_ui_or_scheduler_evidence",
              "network": "loopback_only_linux_namespace", "run_id": run_id, "sandbox_host": host_facts,
              "installation_catalog_sha256": installation.get("catalog_sha256"),
              "required_harnesses": harnesses, "passed": passed, "failures": failures,
              "status": "passed" if not failures and len(passed) == len(harnesses) else "failed"}
    (output / "validation.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def main() -> None:
    catalog = json.loads(CATALOG_PATH.read_text())
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installation", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--harness", action="append", choices=list(catalog["harnesses"]))
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    if os.environ.get("GITHUB_ACTIONS") != "true":
        parser.error("real worker validation is GitHub-only; local execution is stdlib unit tests only")
    output = args.output.resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    try:
        report = validate(json.loads(args.installation.read_text()), output,
                          args.harness or list(catalog["harnesses"]), args.timeout)
    except (ValueError, RuntimeError, AssertionError, OSError, subprocess.TimeoutExpired) as exc:
        report = {"status": "failed", "reason": str(exc)}
        (output / "validation.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": report["status"], "receipt": str(output / "validation.json")}))
    raise SystemExit(0 if report["status"] == "passed" else 1)


if __name__ == "__main__":
    main()
