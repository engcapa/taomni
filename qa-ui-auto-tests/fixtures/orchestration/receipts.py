"""Fail-closed validation of real harness, wire protocol, and worktree ownership."""
from __future__ import annotations

import hashlib
import json
import os
import socket
import sys
from pathlib import Path
from typing import Any

MARKER_NAME = "taomni-worker-marker.txt"


def assert_isolated_network(interfaces: set[str] | None = None) -> None:
    if interfaces is None:
        if sys.platform != "linux":
            raise RuntimeError("real workers require a Linux loopback-only network namespace")
        try:
            # Kernel enumeration follows this process's current network
            # namespace. A preexisting sysfs mount can still show the parent's
            # interfaces after unshare --net; never use it as network evidence.
            interfaces = {name for _, name in socket.if_nameindex()}
        except OSError:
            raise RuntimeError("cannot verify current network namespace interfaces") from None
    if interfaces != {"lo"}:
        raise RuntimeError("real workers require a loopback-only network namespace; external networking is forbidden")


def is_linked_worktree(root: Path) -> bool:
    """Check Git's linked-worktree backlinks without invoking any Git hook."""
    marker = root / ".git"
    try:
        if not root.is_absolute() or root.resolve() != root or marker.is_symlink() or not marker.is_file():
            return False
        reference = marker.read_text(encoding="utf-8").strip()
        if not reference.startswith("gitdir: "):
            return False
        git_dir = Path(reference[len("gitdir: "):])
        if not git_dir.is_absolute():
            git_dir = root / git_dir
        git_dir = git_dir.resolve()
        backlink = Path((git_dir / "gitdir").read_text(encoding="utf-8").strip())
        if not backlink.is_absolute():
            backlink = git_dir / backlink
        common = Path((git_dir / "commondir").read_text(encoding="utf-8").strip())
        if not common.is_absolute():
            common = git_dir / common
        return backlink.resolve() == marker and (common.resolve() / "HEAD").is_file()
    except (OSError, ValueError):
        return False


def clean_environment(home: Path, path: str) -> dict[str, str]:
    # Positive allowlist: no inherited cloud keys, proxy variables, SDK base
    # URLs, NODE_OPTIONS, Python paths, auth agents, or user's harness settings.
    return {"HOME": str(home), "USERPROFILE": str(home), "PATH": path,
            "XDG_CONFIG_HOME": str(home / ".config"), "XDG_DATA_HOME": str(home / ".local/share"),
            "XDG_CACHE_HOME": str(home / ".cache"), "TMPDIR": str(home / "tmp"),
            "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "TERM": "dumb", "CI": "true",
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
            "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"}


def validate_worker_events(events: list[dict], worker_id: str, expected_protocol: str) -> dict:
    digest = hashlib.sha256(worker_id.encode()).hexdigest()
    relevant = [event for event in events if event.get("worker_digest") == digest]
    if any(event.get("route") == "unknown" or event.get("status", 0) >= 400 for event in events):
        raise AssertionError("fixture received an unsupported route or failed request")
    if len(relevant) != 2:
        raise AssertionError("worker must issue exactly one tool request and one final request (no hidden retries)")
    first, second = relevant
    if [event.get("route") for event in relevant] != [expected_protocol, expected_protocol]:
        raise AssertionError("worker used a different wire protocol than its pinned configuration")
    if first.get("scenario") != "worker-tool" or not first.get("tool_name"):
        raise AssertionError("worker did not advertise and request a supported real shell tool")
    if second.get("scenario") != "worker-final" or not second.get("tool_result_seen"):
        raise AssertionError("worker did not return the fixture's matching tool-call result")
    if first.get("tool_call_id") != second.get("tool_call_id"):
        raise AssertionError("worker tool-call identity changed between rounds")
    return {"protocol": expected_protocol, "generation_requests": len(relevant),
            "tool_name": first["tool_name"], "request_ids": [event["request_id"] for event in relevant],
            "request_hashes": [event["request_sha256"] for event in relevant]}


def validate_artifact(root: Path, expected: str, other_roots: list[Path], repository: Path | None = None) -> dict:
    marker = root / MARKER_NAME
    if marker.is_symlink() or not marker.is_file() or marker.resolve().parent != root.resolve():
        raise AssertionError("worker did not create an owned, nonsymlink artifact in its assigned worktree")
    if marker.read_bytes() != expected.encode():
        raise AssertionError("worker artifact content has the wrong run/worker ownership")
    if marker.stat().st_nlink != 1:
        raise AssertionError("worker marker must not be hard-linked outside its assigned worktree")
    if repository is not None and (repository / MARKER_NAME).exists():
        raise AssertionError("worker escaped its worktree and modified the source repository")
    # Other workers may already own markers, but never this worker's content.
    for other in other_roots:
        other_marker = other / MARKER_NAME
        if other != root and other_marker.exists() and other_marker.read_bytes() == expected.encode():
            raise AssertionError("worker artifact also appeared in another worker's worktree")
    return {"artifact": MARKER_NAME, "sha256": hashlib.sha256(marker.read_bytes()).hexdigest(),
            "size": marker.stat().st_size, "worktree": str(root)}


def parse_json_lines(output: bytes) -> list[dict[str, Any]]:
    rows = []
    for line in output.decode("utf-8", errors="strict").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue  # Banners are not receipts and cannot count as a final.
        if isinstance(row, dict):
            rows.append(row)
    return rows


def contains_worker_result(value: Any, run_id: str, worker_id: str) -> bool:
    if isinstance(value, dict):
        if (value.get("type") == "worker_result" and value.get("status") == "completed"
                and value.get("run_id") == run_id and value.get("worker_id") == worker_id
                and value.get("artifact") == MARKER_NAME):
            return True
        return any(contains_worker_result(child, run_id, worker_id) for child in value.values())
    if isinstance(value, list):
        return any(contains_worker_result(child, run_id, worker_id) for child in value)
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except ValueError:
            return False
        # JSON string scalars need not be decoded recursively without bound.
        return isinstance(decoded, (dict, list)) and contains_worker_result(decoded, run_id, worker_id)
    return False


def validate_stdout(harness: str, output: bytes, run_id: str, worker_id: str) -> dict:
    rows = parse_json_lines(output)
    if not rows or not contains_worker_result(rows, run_id, worker_id):
        raise AssertionError("real worker stdout has no matching structured fixture final result")
    if harness == "claude-code":
        final = [row for row in rows if row.get("type") == "result"]
        if len(final) != 1 or final[0].get("is_error") or final[0].get("subtype") != "success":
            raise AssertionError("Claude Code did not report a successful final result")
    elif harness == "codex":
        if not any(row.get("type") == "turn.completed" for row in rows):
            raise AssertionError("Codex did not report turn.completed")
        if any(row.get("type") in {"turn.failed", "error"} for row in rows):
            raise AssertionError("Codex reported a failed turn")
    elif harness == "pi":
        if not any(row.get("type") == "agent_end" for row in rows):
            raise AssertionError("Pi did not report agent_end")
    elif harness == "opencode":
        if not any(row.get("type") == "step_finish" for row in rows):
            raise AssertionError("OpenCode did not report step_finish")
    elif harness == "deepseek-harness":
        final = [row for row in rows if row.get("type") == "final"]
        if len(final) != 1 or not isinstance(final[0].get("reason"), dict) or final[0]["reason"].get("kind") != "completed":
            raise AssertionError("DeepSeek Harness did not report final.reason.kind=completed")
        if any(row.get("type") == "error" for row in rows):
            raise AssertionError("DeepSeek Harness reported a driver error")
    elif harness == "zcode":
        final = [row for row in rows if row.get("type") == "result"]
        if len(final) != 1 or final[0].get("is_error") is True:
            raise AssertionError("ZCode did not report a nonerror terminal result")
    else:
        raise AssertionError("unresolved harness stdout protocol")
    return {"stdout_sha256": hashlib.sha256(output).hexdigest(),
            "event_types": sorted({str(row.get("type", "unknown")) for row in rows}),
            "matching_final_result": True}
