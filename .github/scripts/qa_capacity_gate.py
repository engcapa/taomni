"""Hold a scheduled QA run while earlier runs of the same workflow still own the runners.

GitHub Free plans share the job and macOS concurrency budgets across every workflow run in a
repository. The nightly platforms workflow is often started while another dispatch of the same
workflow is still running, so its native shards queue behind that run's builds. This gate polls
the workflow run list from a schedule-triggered plan job and waits until earlier runs finish
before the expensive jobs start.

The gate fails open: an unavailable API or a wait limit that expires only emits a warning and
lets the nightly run continue, because capacity coordination must never block QA execution.
The ``gh`` CLI reads ``GITHUB_TOKEN`` (or ``GH_TOKEN``) from the environment for its requests.
"""

import json
import os
from pathlib import Path
import re
import subprocess
import time


DEFAULT_WORKFLOW = "qa-ui-auto-platforms.yml"
DEFAULT_MAX_WAIT_SECONDS = 1200
DEFAULT_POLL_SECONDS = 30
DEFAULT_OUTPUT = "capacity-gate.json"
ACTIVE_STATUSES = frozenset({"in_progress", "queued", "waiting", "requested", "pending"})
MAX_API_FAILURES = 3
RUNS_PER_PAGE = 50
REPOSITORY_PATTERN = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
RUN_ID_PATTERN = re.compile(r"[1-9][0-9]*")
WORKFLOW_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml")


def api(repository, endpoint):
    """Call one GitHub API endpoint through the gh CLI and decode its JSON body."""
    command = ["gh", "api", f"repos/{repository}/{endpoint}"]
    try:
        result = subprocess.run(command, capture_output=True, encoding="utf-8", timeout=45)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"GitHub API request timed out for {endpoint}") from error
    if result.returncode != 0:
        raise RuntimeError(f"GitHub API request failed for {endpoint}: {result.stderr.strip()}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"GitHub API returned invalid JSON for {endpoint}: {error}") from error


def fetch_runs(repository, workflow):
    """Fetch the newest runs of one workflow without a status filter.

    A single unfiltered page keeps the request count low and lets ``blocking_runs`` decide
    which statuses matter; it also lets the gate tell finished runs apart from active ones.
    """
    payload = api(repository, f"actions/workflows/{workflow}/runs?per_page={RUNS_PER_PAGE}")
    runs = payload.get("workflow_runs") if isinstance(payload, dict) else None
    if not isinstance(runs, list):
        raise RuntimeError("GitHub workflow runs response has no workflow_runs list")
    return runs


def blocking_runs(runs, own_id):
    """Return earlier runs of the workflow that are still active.

    Run IDs grow monotonically, so a smaller ID was started first and owns the runner slots
    ahead of the current run. Finished, skipped and unknown-status runs never block.
    """
    own_id = int(own_id)
    blockers = []
    for run in runs:
        if run.get("status") not in ACTIVE_STATUSES:
            continue
        try:
            run_id = int(run.get("id"))
        except (TypeError, ValueError):
            continue
        if run_id < own_id:
            blockers.append(run)
    return sorted(blockers, key=lambda run: int(run["id"]))


def run_summary(run):
    """Retain the fields that explain why an earlier run held the gate."""
    return {
        "id": run.get("id"),
        "status": run.get("status"),
        "event": run.get("event"),
        "head_branch": run.get("head_branch"),
        "created_at": run.get("created_at"),
        "run_attempt": run.get("run_attempt"),
    }


def print_blockers(blocking, waited, max_wait):
    """Print the runs that currently keep the gate closed."""
    print(f"QA capacity gate: waiting {waited:.0f}s/{max_wait}s for {len(blocking)} earlier active run(s)")
    for run in blocking:
        summary = run_summary(run)
        print(
            f"  run {summary['id']}: status={summary['status']} event={summary['event']} "
            f"head_branch={summary['head_branch']} created_at={summary['created_at']}"
        )


def _value(environ, name, default):
    value = environ.get(name)
    return default if value is None or value == "" else value


def _integer(environ, name, default, minimum):
    raw = _value(environ, name, default)
    try:
        number = int(raw)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be an integer, got {raw!r}") from None
    if number < minimum:
        raise ValueError(f"{name} must be at least {minimum}, got {number}")
    return number


def load_config(environ):
    """Validate the gate environment and return the settings that drive one gate run."""
    repository = str(_value(environ, "GITHUB_REPOSITORY", ""))
    if not REPOSITORY_PATTERN.fullmatch(repository):
        raise ValueError("GITHUB_REPOSITORY must be owner/repo")
    run_id = str(_value(environ, "GITHUB_RUN_ID", ""))
    if not RUN_ID_PATTERN.fullmatch(run_id):
        raise ValueError(f"GITHUB_RUN_ID must be a numeric run id, got {run_id!r}")
    workflow = str(_value(environ, "QA_GATE_WORKFLOW", DEFAULT_WORKFLOW))
    if not WORKFLOW_PATTERN.fullmatch(workflow):
        raise ValueError(f"QA_GATE_WORKFLOW must be a workflow file name, got {workflow!r}")
    return {
        "repository": repository,
        "own_run_id": int(run_id),
        "workflow": workflow,
        "max_wait": _integer(environ, "QA_GATE_MAX_WAIT_SECONDS", DEFAULT_MAX_WAIT_SECONDS, 0),
        "poll": _integer(environ, "QA_GATE_POLL_SECONDS", DEFAULT_POLL_SECONDS, 1),
        "output": str(_value(environ, "QA_GATE_OUTPUT", DEFAULT_OUTPUT)),
    }


def wait_for_clear(config, *, fetch, sleep, clock):
    """Poll until no earlier run is active, the wait limit expires, or the API keeps failing."""
    repository = config["repository"]
    workflow = config["workflow"]
    own_run_id = config["own_run_id"]
    max_wait = config["max_wait"]
    poll = config["poll"]
    print(
        f"QA capacity gate: run {own_run_id} checks {workflow} in {repository} for earlier active "
        f"runs (max wait {max_wait}s, poll {poll}s)"
    )
    started = clock()
    failures = 0
    blocking = []
    outcome = "clear"
    while True:
        try:
            runs = fetch(repository, workflow)
        except Exception as error:  # noqa: BLE001 - any API failure must fail open, not block QA
            failures += 1
            if failures >= MAX_API_FAILURES:
                print(
                    f"::warning::QA capacity gate: GitHub API failed {failures} consecutive times "
                    f"({error}); continuing without waiting (fail open)"
                )
                outcome = "api-error"
                break
            print(f"QA capacity gate: API attempt {failures} failed ({error}); retrying in {poll}s")
        else:
            failures = 0
            blocking = blocking_runs(runs, own_run_id)
            if not blocking:
                break
            print_blockers(blocking, clock() - started, max_wait)

        elapsed = max(0.0, clock() - started)
        if elapsed >= max_wait:
            print(
                f"::warning::QA capacity gate: timed out after {elapsed:.0f}s waiting for "
                f"{len(blocking)} earlier run(s); continuing without waiting (fail open)"
            )
            outcome = "timeout"
            break
        sleep(min(poll, max_wait - elapsed))

    waited = round(max(0.0, clock() - started), 1)
    print(f"QA capacity gate: outcome={outcome} waited={waited}s blocking={len(blocking)}")
    return {
        "own_run_id": own_run_id,
        "workflow": workflow,
        "waited_seconds": waited,
        "blocking": [run_summary(run) for run in blocking],
        "outcome": outcome,
    }


def main(environ=None, *, fetch=fetch_runs, sleep=time.sleep, clock=time.monotonic):
    """Run the gate and return the process exit code (always 0 unless the settings are invalid)."""
    environ = os.environ if environ is None else environ
    try:
        config = load_config(environ)
    except ValueError as error:
        print(f"::error::QA capacity gate configuration is invalid: {error}")
        return 2
    report = wait_for_clear(config, fetch=fetch, sleep=sleep, clock=clock)
    try:
        Path(config["output"]).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    except OSError as error:
        print(f"::warning::QA capacity gate could not write {config['output']}: {error}")
    else:
        print(f"QA capacity gate: wrote {config['output']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
