#!/usr/bin/env python3
"""Fixture-only real worker launcher; suitable as Taomni's supervised CLI resource.

Reads a prompt on stdin, invokes the pinned *installed* harness in the assigned
worktree, retains raw harness output privately and emits a normalized result.
It never implements an agent or writes the marker. It is not product code.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from behavior import WORKER_MARKER, FixtureError, metadata, safe_id
from harness_config import CATALOG_PATH, prepare_launch
from receipts import assert_isolated_network, validate_artifact, validate_stdout
from diagnostics import bounded_file, worker_output_diagnostic

MAX_OUTPUT_BYTES = 16 * 1024 * 1024


def enrich_prompt(prompt: str, worktree: Path) -> tuple[str, dict]:
    worker = metadata({"prompt": prompt}, WORKER_MARKER)
    if not worker:
        raise FixtureError("fixture bridge requires explicit worker metadata; it is not a production worker adapter")
    safe_id(worker.get("run_id"), "run_id")
    safe_id(worker.get("worker_id"), "worker_id")
    worker["worktree"] = str(worktree)
    # Replace the actual JSON object in-place. Appending a second marker would
    # allow a harness to quote the earlier object on the next tool round.
    lines = prompt.splitlines(keepends=True)
    replaced = False
    for index, line in enumerate(lines):
        if not line.startswith(WORKER_MARKER):
            continue
        start = len(WORKER_MARKER)
        raw = line[start:].lstrip()
        _, consumed = json.JSONDecoder().raw_decode(raw)
        lines[index] = line[:start] + json.dumps(worker, separators=(",", ":")) + raw[consumed:]
        replaced = True
    if not replaced:
        raise FixtureError("fixture worker metadata must fit on one line")
    return "".join(lines), worker


def kill_group(process: subprocess.Popen, timeout: float = 3) -> None:
    if process.poll() is not None:
        # The session leader may exit while descendants still hold stdout open.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)
    except ProcessLookupError:
        pass
    finally:
        # Descendants must not survive a successful leader exit either.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def run_worker(installation: dict, harness: str, base_url: str, worktree: Path,
               state_root: Path, prompt: str, timeout: int = 120) -> dict:
    assert_isolated_network()
    prompt, worker = enrich_prompt(prompt, worktree)
    marker = worktree / "taomni-worker-marker.txt"
    if marker.exists() or marker.is_symlink():
        raise RuntimeError("worker marker already exists; refusing stale artifact evidence")
    launch = prepare_launch(installation, harness, base_url, worktree, state_root, prompt)
    output_path, error_path = state_root / "harness.stdout.ndjson", state_root / "harness.stderr.log"
    interrupted = False
    process = None

    def stop(signum, _frame):
        nonlocal interrupted
        interrupted = True
        if process is not None:
            kill_group(process)
        raise InterruptedError(f"supervisor signal {signum}")

    stage = "process_start"
    previous = {}
    for sig in (signal.SIGTERM, signal.SIGINT):
        previous[sig] = signal.signal(sig, stop)
    try:
        with output_path.open("xb") as stdout, error_path.open("xb") as stderr:
            output_path.chmod(0o600)
            error_path.chmod(0o600)
            process = subprocess.Popen(launch.command, cwd=worktree, env=launch.env,
                                       stdin=subprocess.PIPE, stdout=stdout, stderr=stderr, start_new_session=True)
            try:
                stage = "process_run"
                process.communicate(input=launch.stdin, timeout=timeout)
            finally:
                kill_group(process)
        stage = "process_exit"
        if interrupted or process.returncode != 0:
            raise RuntimeError("real harness exited unsuccessfully; inspect private harness logs")
        stage = "output_limit"
        if output_path.stat().st_size > MAX_OUTPUT_BYTES or error_path.stat().st_size > MAX_OUTPUT_BYTES:
            raise RuntimeError("real harness exceeded the bounded receipt output size")
        output = output_path.read_bytes()
        stage = "stdout_terminal"
        evidence = validate_stdout(harness, output, worker["run_id"], worker["worker_id"])
        stage = "artifact_ownership"
        artifact = validate_artifact(worktree, f"taomni:{worker['run_id']}:{worker['worker_id']}\n", [])
        final = {"type": "worker_result", "status": "completed", "run_id": worker["run_id"],
                 "worker_id": worker["worker_id"], "artifact": "taomni-worker-marker.txt"}
        result = {"type": "result", "subtype": "success", "is_error": False, "result": json.dumps(final),
                "fixture_evidence": {"scope": "real_harness_process_not_ui_orchestration",
                    "harness": harness, "pid": process.pid, "cwd": str(worktree),
                    "exit_code": process.returncode, "identity": launch.identity, "protocol": launch.expected_protocol,
                    "stdout": str(output_path), "stderr": str(error_path), "artifact": artifact, **evidence}}
        receipt = state_root / "bridge-receipt.json"
        with receipt.open("x", encoding="utf-8") as output:
            receipt.chmod(0o600)
            output.write(json.dumps(result, indent=2) + "\n")
        return result
    except (ValueError, RuntimeError, AssertionError, OSError, subprocess.TimeoutExpired) as exc:
        failure = {"schema_version": 1, "status": "failed", "harness": harness, "stage": stage,
                   "exit_code": process.returncode if process is not None else None,
                   "protocol": launch.expected_protocol,
                   "timeout": isinstance(exc, subprocess.TimeoutExpired), "interrupted": interrupted}
        try:
            stdout = bounded_file(output_path, MAX_OUTPUT_BYTES)
            stderr = bounded_file(error_path, MAX_OUTPUT_BYTES)
            failure["output"] = worker_output_diagnostic(stdout, stderr)
            with (state_root / "worker-failure.json").open("x", encoding="utf-8") as output:
                (state_root / "worker-failure.json").chmod(0o600)
                output.write(json.dumps(failure, indent=2) + "\n")
        except OSError:
            pass  # Never mask the original hard failure with a diagnostic error.
        raise
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installation", type=Path, required=True)
    parser.add_argument("--harness", required=True, choices=list(json.loads(CATALOG_PATH.read_text())["harnesses"]))
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--worktree", type=Path, required=True)
    parser.add_argument("--state-root", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    try:
        if os.environ.get("GITHUB_ACTIONS") != "true":
            raise RuntimeError("real fixture workers may run only in GitHub Actions; local execution is unit tests only")
        prompt = sys.stdin.read(1024 * 1024 + 1)
        if len(prompt) > 1024 * 1024 or not prompt.strip():
            raise RuntimeError("worker bridge requires a nonempty bounded stdin prompt")
        result = run_worker(json.loads(args.installation.read_text()), args.harness, args.base_url,
                            args.worktree, args.state_root, prompt, args.timeout)
    except (ValueError, RuntimeError, AssertionError, OSError, subprocess.TimeoutExpired):
        print(json.dumps({"type": "result", "subtype": "error_during_execution", "is_error": True,
                          "result": "real fixture worker validation failed; inspect private state-root logs"}))
        raise SystemExit(1)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
