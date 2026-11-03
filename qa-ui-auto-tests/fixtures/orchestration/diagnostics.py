"""Closed-set fixture/worker diagnostics; never emit arbitrary upstream strings."""
from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

from behavior import PACK_MARKER, WORKER_MARKER, SHELL_NAMES, FixtureError, metadata, strings, tool_failure_categories

REQUEST_KEYS = frozenset({"messages", "input", "instructions", "system", "tools", "tool_choice", "stream",
                         "model", "max_tokens", "max_output_tokens", "temperature", "previous_response_id"})
SCHEMA_FIELDS = frozenset({"command", "cmd", "workdir", "cwd", "login", "shell", "description", "timeout",
                          "timeout_ms", "max_output_tokens", "yield_time_ms", "tty", "sandbox_permissions"})
ROLES = frozenset({"system", "developer", "user", "assistant", "tool"})
EVENT_TYPES = frozenset({"assistant", "result", "system", "user", "text", "error", "session", "step_start",
                        "step_finish", "tool_use", "agent_start", "agent_end", "message_start", "message_end",
                        "tool_execution_start", "tool_execution_end", "turn_start", "turn_end", "final", "status",
                        "tool_call", "tool_result", "thread.started", "turn.started", "turn.completed", "turn.failed",
                        "item.started", "item.updated", "item.completed", "turn.completed", "tool.updated"})
FAILURE_PATTERNS = {
    "fixture_request_rejected": re.compile(r"(?:unsupported fixture request|fixture_request_invalid|invalid_request_error|422 Unprocessable)", re.I),
    "protocol_decode_failed": re.compile(r"(?:JSON.*(?:parse|decode).*error|invalid.*(?:SSE|stream event|response shape))", re.I),
    "auxiliary_title_request": re.compile(r"(?:Create a concise title for an AI coding-assistant session|Generate a title for this conversation:)")
}


def failure_categories(value: Any) -> list[str]:
    text = "\n".join(strings(value))[:1024 * 1024]
    return tool_failure_categories(value) + [name for name, pattern in FAILURE_PATTERNS.items() if pattern.search(text)]


def walk_objects(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk_objects(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_objects(child)


def value_shape(value: Any) -> str:
    if value is None:
        return "absent"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    if isinstance(value, str):
        return "string"
    return "other"


def request_diagnostic(body: dict) -> dict:
    text = list(strings(body))
    result = {"request_keys": sorted(set(body) & REQUEST_KEYS),
              "messages_shape": value_shape(body.get("messages")), "input_shape": value_shape(body.get("input")),
              "tools_shape": value_shape(body.get("tools")), "tool_choice_shape": value_shape(body.get("tool_choice")),
              "worker_marker_line": any(line.startswith(WORKER_MARKER) for value in text for line in value.splitlines()),
              "worker_marker_embedded": any(WORKER_MARKER in value for value in text),
              "pack_marker_line": any(line.startswith(PACK_MARKER) for value in text for line in value.splitlines()),
              "categories": failure_categories(body), "shell_tools": [], "other_tool_count": 0}
    try:
        worker = metadata(body, WORKER_MARKER)
        worker_id = worker.get("worker_id") if worker else None
        if isinstance(worker_id, str):
            result["worker_digest"] = hashlib.sha256(worker_id.encode()).hexdigest()
    except FixtureError:
        pass
    tools = body.get("tools")
    for tool in tools if isinstance(tools, list) else []:
        definition = tool.get("function", tool) if isinstance(tool, dict) else None
        name = definition.get("name") if isinstance(definition, dict) else None
        if not isinstance(name, str) or name not in SHELL_NAMES:
            result["other_tool_count"] += 1
            continue
        schema = definition.get("parameters", definition.get("input_schema"))
        props = schema.get("properties") if isinstance(schema, dict) else None
        required = schema.get("required") if isinstance(schema, dict) else None
        result["shell_tools"].append({"name": name, "schema_shape": value_shape(schema),
            "fields": sorted(set(props) & SCHEMA_FIELDS) if isinstance(props, dict) else [],
            "required": sorted({key for key in required if isinstance(key, str)} & SCHEMA_FIELDS)
                        if isinstance(required, list) else []})
    result["shell_tools"] = result["shell_tools"][:len(SHELL_NAMES)]
    messages = body.get("messages", body.get("input", []))
    roles = Counter(message.get("role") for message in messages
                    if isinstance(message, dict) and isinstance(message.get("role"), str)
                    and message["role"] in ROLES) if isinstance(messages, list) else Counter()
    result["roles"] = dict(roles)
    result["tool_result_error_flag"] = any(isinstance(value, dict) and value.get("is_error") is True
                                          for value in walk_objects(body))
    return result


def worker_output_diagnostic(output: bytes, stderr: bytes) -> dict:
    rows = []
    for line in output.decode("utf-8", "replace").splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    event_types = {row.get("type") for row in rows if isinstance(row.get("type"), str)}
    return {"stdout_bytes": len(output), "stderr_bytes": len(stderr),
            "stdout_sha256": hashlib.sha256(output).hexdigest(), "stderr_sha256": hashlib.sha256(stderr).hexdigest(),
            "event_types": sorted(event_types & EVENT_TYPES), "other_event_type_count": len(event_types - EVENT_TYPES),
            "categories": failure_categories([rows, stderr.decode("utf-8", "replace")])}


def bounded_file(path: Path, limit: int = 16 * 1024 * 1024) -> bytes:
    if not path.is_file() or path.is_symlink():
        return b""
    with path.open("rb") as source:
        return source.read(limit)


def failure_context(state_root: Path, events: list[dict]) -> dict:
    """Embed only this module's sanitized receipts in existing validation.json."""
    result = {"requests": [{key: event[key] for key in (
        "sequence", "route", "status", "scenario", "error_code", "error_stage", "diagnostic") if key in event}
        for event in events]}
    path = state_root / "worker-failure.json"
    if path.is_file() and not path.is_symlink() and path.stat().st_size <= 65536:
        try:
            receipt = json.loads(path.read_text())
            stages = {"process_start", "process_run", "process_exit", "output_limit", "stdout_terminal", "artifact_ownership"}
            worker = {"status": "failed"}
            if receipt.get("harness") in {"claude-code", "codex", "pi", "opencode", "deepseek-harness", "zcode"}:
                worker["harness"] = receipt["harness"]
            if receipt.get("stage") in stages:
                worker["stage"] = receipt["stage"]
            if receipt.get("protocol") in {"anthropic_messages", "openai_chat", "openai_responses"}:
                worker["protocol"] = receipt["protocol"]
            if isinstance(receipt.get("exit_code"), int):
                worker["exit_code"] = receipt["exit_code"]
            for flag in ("timeout", "interrupted"):
                if isinstance(receipt.get(flag), bool):
                    worker[flag] = receipt[flag]
            # Recompute the safe output projection from fixed private filenames;
            # never trust arbitrary data a harness may have put in a JSON file.
            stdout, stderr = state_root / "harness.stdout.ndjson", state_root / "harness.stderr.log"
            worker["output"] = worker_output_diagnostic(bounded_file(stdout), bounded_file(stderr))
            result["worker"] = worker
        except (ValueError, TypeError, AttributeError, OSError):
            result["worker_diagnostic_unreadable"] = True
    return result
