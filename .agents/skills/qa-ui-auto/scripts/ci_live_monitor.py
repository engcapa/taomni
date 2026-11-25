"""Observe a hosted QA invocation from planning onward, using authenticated gh.

Downloads and raw per-case results arrive before the workflow summary. Collection
is not receipt validation or a passing workflow result. Existing report evidence
is never overwritten: choose a new destination when starting another monitor.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import subprocess
import time

from ci_live_shards import GitHubArtifacts, PROGRESS_POLL_SECONDS, collect


def discover_selection(client: GitHubArtifacts, deadline: float, *,
                       poll_seconds: float = 15, sleep=time.sleep,
                       monotonic=time.monotonic) -> str:
    next_status_read = monotonic()
    while monotonic() < deadline:
        try:
            candidates = [artifact for artifact in client.listing("artifacts")
                          if artifact["name"].startswith("qa-selection-")
                          and not artifact.get("expired")]
            if len(candidates) > 1:
                raise RuntimeError("Multiple selections exist; specify --artifact-key for the intended invocation")
            if candidates:
                key = candidates[0]["name"].removeprefix("qa-selection-")
                if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", key):
                    raise RuntimeError("Invalid hosted selection artifact key")
                print(f"Discovered selection {candidates[0]['name']}", flush=True)
                return key
            if monotonic() >= next_status_read:
                next_status_read = monotonic() + PROGRESS_POLL_SECONDS
                if client.run_status() == "completed":
                    raise RuntimeError("Run completed without an available selection artifact")
            print("Planner is running; waiting for its selection artifact", flush=True)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            print(f"Retrying GitHub selection observation: {type(error).__name__}", flush=True)
        remaining = deadline - monotonic()
        if remaining > 0:
            sleep(min(poll_seconds, remaining))
    raise TimeoutError("Selection artifact observation timed out")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY", "engcapa/taomni"))
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--artifact-key", help="Required when a run contains more than one selection")
    parser.add_argument("--destination", type=Path, help="New report directory; existing evidence is retained")
    parser.add_argument("--timeout-seconds", type=float, default=6 * 60 * 60)
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+", args.repository):
        parser.error("--repository must be owner/repository")
    if not re.fullmatch(r"[1-9][0-9]*", args.run_id):
        parser.error("--run-id must be a positive GitHub run ID")
    if args.artifact_key and not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", args.artifact_key):
        parser.error("invalid --artifact-key")
    if not 0 < args.timeout_seconds <= 24 * 60 * 60:
        parser.error("--timeout-seconds must be positive and at most 86400")
    destination = args.destination or Path("qa-ui-auto-report/github") / args.run_id / "live-shards"
    if destination.is_symlink() or (destination.exists()
            and (not destination.is_dir() or any(destination.iterdir()))):
        parser.error("destination already contains evidence; choose a new --destination")
    destination.mkdir(parents=True, exist_ok=True)
    try:
        # Reserve before planning/network waits. Two monitors that both saw an
        # empty directory must not remove/re-download each other's artifacts.
        with (destination / ".qa-live-monitor").open("x", encoding="utf-8") as claim:
            claim.write(f"repository={args.repository}\nrun_id={args.run_id}\n")
    except FileExistsError:
        parser.error("destination is already owned by another monitor; choose a new --destination")
    client = GitHubArtifacts(args.repository, args.run_id)
    deadline = time.monotonic() + args.timeout_seconds
    key = args.artifact_key or discover_selection(client, deadline)
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("No collection budget remains after planning")
    return collect(client, destination, args.run_id, key, timeout_seconds=remaining)


if __name__ == "__main__":
    raise SystemExit(main())
