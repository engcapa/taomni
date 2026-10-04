"""Observe disposable Git repositories through a separate, read-only Git process."""
from __future__ import annotations

import json
from pathlib import Path, PurePosixPath
import subprocess

from .deadline import budget_time as time, remaining_timeout
from .steps import StepError


def parse_status(value: str) -> dict[str, str]:
    records = value.split("\0")
    result = {}
    index = 0
    while index < len(records) and records[index]:
        record = records[index]
        if len(record) < 4 or record[2] != " ":
            raise StepError("git_assert_state: malformed porcelain status")
        result[record[3:]] = record[:2]
        index += 2 if "R" in record[:2] or "C" in record[:2] else 1
    return result


def assert_state(ctx, args: dict) -> str:
    allowed = {"repo", "branch", "head", "head_subject", "status", "head_files", "index_files", "timeout_sec"}
    if not isinstance(args, dict) or set(args) - allowed or "repo" not in args:
        raise StepError("git_assert_state: expected a repo and explicit read-only expectations")
    expected = {key: value for key, value in args.items() if key not in {"repo", "timeout_sec"}}
    if not expected:
        raise StepError("git_assert_state: at least one expectation is required")
    root = ctx.case_dir.parent.resolve()
    repo = Path(args["repo"]).resolve()
    if not repo.is_relative_to(root) or not (repo / ".git").is_dir() or not (repo / ".git").resolve().is_relative_to(root):
        raise StepError("git_assert_state: requires a disposable repository inside this report root")
    for field in ("head_files", "index_files"):
        for name in args.get(field, {}):
            path = PurePosixPath(name)
            if not name or path.is_absolute() or ".." in path.parts or "\\" in name or ":" in name:
                raise StepError("git_assert_state: expected a relative repository file")

    def git(*arguments: str) -> str:
        result = subprocess.run(["git", "--no-optional-locks", "-c", "core.quotepath=false", "-C", str(repo), *arguments],
            check=False, capture_output=True, text=True, encoding="utf-8", timeout=remaining_timeout(10))
        if result.returncode:
            raise StepError(f"git_assert_state: read-only {arguments[0]} failed (exit {result.returncode})")
        return result.stdout

    if Path(git("rev-parse", "--show-toplevel").strip()).resolve() != repo:
        raise StepError("git_assert_state: repository root does not match the fixture")
    deadline = time.monotonic() + args.get("timeout_sec", 10)
    samples = []
    while True:
        actual = {}
        for field in expected:
            if field == "status":
                actual[field] = parse_status(git("status", "--porcelain=v1", "-z", "--untracked-files=all"))
            elif field == "branch":
                actual[field] = git("rev-parse", "--abbrev-ref", "HEAD").strip()
            elif field == "head":
                actual[field] = git("rev-parse", "HEAD").strip()
            elif field == "head_subject":
                actual[field] = git("log", "-1", "--format=%s").rstrip("\n")
            else:
                blobs = {}
                for name in expected[field]:
                    present = git("ls-tree", "--name-only", "-z", "HEAD", "--", name) if field == "head_files" else git("ls-files", "--stage", "-z", "--", name)
                    blobs[name] = git("show", ("HEAD:" if field == "head_files" else ":") + name) if present else None
                actual[field] = blobs
        passed = actual == expected
        samples.append({"actual": actual, "passed": passed})
        if passed or time.monotonic() >= deadline:
            break
        time.sleep(0.1)
    ctx.case_dir.mkdir(parents=True, exist_ok=True)
    artifact = ctx.case_dir / f"git-state-{ctx.step_index}.json"
    artifact.write_text(json.dumps({"repo": str(repo), "expected": expected, "samples": samples, "passed": passed}, ensure_ascii=False, indent=2), encoding="utf-8")
    if not passed:
        raise StepError(f"git_assert_state: independent Git state differs; see {artifact.name}")
    return "independent Git process observed the expected branch, index and committed state"
