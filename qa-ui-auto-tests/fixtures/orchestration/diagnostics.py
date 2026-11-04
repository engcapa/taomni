"""Closed-set fixture/worker diagnostics; never emit arbitrary upstream strings."""
from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

from behavior import PACK_MARKER, WORKER_MARKER, SHELL_NAMES, FixtureError, metadata, strings, tool_failure_categories

SANDBOX_ERRORS = {
    "bwrap_create_namespace_failed": r"(?:bwrap|bubblewrap)[^\n]*(?:creating (?:a )?new namespace|create (?:a )?new namespace)[^\n]*(?:failed|not permitted|denied)",
    "bwrap_loopback_address_failed": r"(?:bwrap|bubblewrap)[^\n]*(?:loopback[^\n]*failed[^\n]*RTM_NEWADDR|RTM_NEWADDR[^\n]*(?:failed|not permitted|denied))",
    "bwrap_loopback_link_failed": r"(?:bwrap|bubblewrap)[^\n]*(?:loopback[^\n]*failed[^\n]*RTM_NEWLINK|RTM_NEWLINK[^\n]*(?:failed|not permitted|denied))",
    "bwrap_netlink_failed": r"(?:bwrap|bubblewrap)[^\n]*(?:netlink[^\n]*(?:failed|not permitted|denied)|failed[^\n]*netlink)",
    "bwrap_uid_map_setup_failed": r"(?:bwrap|bubblewrap)[^\n]*(?:setting up|create|setup)[^\n]*uid map[^\n]*(?:failed|not permitted|denied)",
    "bwrap_gid_map_setup_failed": r"(?:bwrap|bubblewrap)[^\n]*(?:setting up|create|setup)[^\n]*gid map[^\n]*(?:failed|not permitted|denied)",
    "bwrap_unshare_user_namespace": r"(?:bwrap|bubblewrap)[^\n]*(?:unshare|create)[^\n]*user namespace",
    "bwrap_uid_map_failed": r"(?:setting|writing|write|set)[^\n]*(?:uid_map|uid map|uidmap)[^\n]*(?:failed|denied|not permitted)",
    "bwrap_gid_map_failed": r"(?:setting|writing|write|set)[^\n]*(?:gid_map|gid map|gidmap)[^\n]*(?:failed|denied|not permitted)",
    "bwrap_setgroups_failed": r"setgroups[^\n]*(?:failed|denied|not permitted)",
    "bwrap_mount_proc_failed": r"(?:mount|mounting)[^\n]*(?:/proc|proc filesystem)[^\n]*(?:failed|denied|not permitted)",
    "bwrap_mount_failed": r"(?:bwrap|bubblewrap)[^\n]*(?:mount|bind)[^\n]*(?:failed|denied|not permitted)",
    "bwrap_userns_unavailable": r"(?:bwrap|bubblewrap)[^\n]*(?:No permissions to create (?:a )?new namespace|unprivileged user namespaces.*disabled)",
    "bwrap_setuid_failed": r"(?:bwrap|bubblewrap)[^\n]*(?:setuid|setgid|setresuid|setresgid)[^\n]*(?:failed|denied|not permitted)",
    "seccomp_install_failed": r"(?:seccomp[^\n]*(?:failed|denied|not permitted)|failed to (?:install|apply)[^\n]*seccomp)",
    "sandbox_restrictions_failed": r"error applying (?:legacy )?Linux sandbox restrictions",
    "sandbox_fd_mount_verification_failed": r"failed to verify descriptor-backed bubblewrap mount",
    "sandbox_capability_verification_failed": r"(?:failed to verify Linux sandbox capabilities|Linux sandbox retained effective or permitted capabilities)",
    "sandbox_executable_missing": r"(?:execvp|execve|No such file or directory)[^\n]*(?:failed|error)|(?:bwrap|bubblewrap)[^\n]*No such file or directory",
}
ERRNO_PHRASES = {"EPERM": r"(?:\bEPERM\b|Operation not permitted|os error 1(?:[^0-9]|$))",
                 "EACCES": r"(?:\bEACCES\b|Permission denied|os error 13(?:[^0-9]|$))",
                 "EINVAL": r"(?:\bEINVAL\b|Invalid argument|os error 22(?:[^0-9]|$))",
                 "ENOSYS": r"(?:\bENOSYS\b|Function not implemented|os error 38(?:[^0-9]|$))",
                 "ENOENT": r"(?:\bENOENT\b|No such file or directory|os error 2(?:[^0-9]|$))",
                 "EROFS": r"(?:\bEROFS\b|Read-only file system|os error 30(?:[^0-9]|$))"}

SANDBOX_TOKENS = frozenset({"bwrap", "bubblewrap", "loopback", "RTM_NEWADDR", "RTM_NEWLINK", "netlink",
                            "namespace", "userns", "netns", "uid_map", "gid_map", "uidmap", "gidmap",
                            "setgroups", "setuid", "setgid", "setresuid", "setresgid", "clone", "clone3",
                            "unshare", "mount", "bind", "pivot_root", "proc", "seccomp", "landlock",
                            "capset", "capabilities", "prctl", "newuidmap", "newgidmap", "denied", "failed"})

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


def sandbox_tool_diagnostic(body: dict) -> dict:
    # Inspect actual returned tool content only, never unrelated system prompts
    # or schema descriptions mentioning sandboxes without an execution error.
    results = [item for item in walk_objects(body) if item.get("type") in {"tool_result", "function_call_output"}
               or item.get("role") == "tool"]
    text = "\n".join(strings(results))[:1024 * 1024]
    tokens = re.findall(r"[A-Za-z_][A-Za-z0-9_]*", text)
    return {"tool_result_count": len(results),
            "sandbox_tokens": sorted({approved for approved in SANDBOX_TOKENS
                                      if any(token.lower() == approved.lower() for token in tokens)}),
            "sandbox_error_codes": [name for name, pattern in SANDBOX_ERRORS.items() if re.search(pattern, text, re.I)],
            "sandbox_errno": [name for name, pattern in ERRNO_PHRASES.items() if re.search(pattern, text, re.I)],
            "sandbox_backends": [name for name in ("bwrap", "bubblewrap", "seccomp", "landlock")
                                 if re.search(r"\b" + name + r"\b", text, re.I)]}


def sandbox_host_facts() -> dict:
    """Read fixed local kernel controls only; no subprocess, probes or egress."""
    facts = {}
    numeric = {
        "unprivileged_userns_clone": "/proc/sys/kernel/unprivileged_userns_clone",
        "apparmor_restrict_unprivileged_userns": "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
        "max_user_namespaces": "/proc/sys/user/max_user_namespaces",
        "max_net_namespaces": "/proc/sys/user/max_net_namespaces",
    }
    for name, filename in numeric.items():
        try:
            value = Path(filename).read_text().strip()
            facts[name] = int(value) if value.isascii() and value.isdigit() and len(value) <= 12 else "unavailable"
        except OSError:
            facts[name] = "unavailable"
    try:
        value = Path("/sys/module/apparmor/parameters/enabled").read_text().strip().lower()
        facts["apparmor_enabled"] = value in {"y", "yes", "1"} if value in {"y", "yes", "1", "n", "no", "0"} else "unavailable"
    except OSError:
        facts["apparmor_enabled"] = "unavailable"
    try:
        value = Path("/proc/self/attr/current").read_text().strip()
        facts["apparmor_process_mode"] = ("unconfined" if value == "unconfined" else "enforce"
            if value.endswith("(enforce)") else "complain" if value.endswith("(complain)") else "unknown")
    except OSError:
        facts["apparmor_process_mode"] = "unavailable"
    try:
        status = Path("/proc/self/status").read_text()
        for key in ("NoNewPrivs", "Seccomp", "Seccomp_filters"):
            match = re.search(r"^" + key + r":\s*([0-9]{1,6})\s*$", status, re.M)
            facts[key.lower()] = int(match[1]) if match else "unavailable"
        match = re.search(r"^CapEff:\s*([0-9a-fA-F]{1,16})\s*$", status, re.M)
        if match:
            capabilities = int(match[1], 16)
            facts["effective_cap_net_admin"] = bool(capabilities & (1 << 12))
            facts["effective_cap_sys_admin"] = bool(capabilities & (1 << 21))
    except OSError:
        pass
    return facts


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


def lexical_class(char: str) -> str:
    if not char:
        return "eof"
    syntax = {"{": "object_open", "}": "object_close", "[": "array_open", "]": "array_close",
              '"': "double_quote", "'": "single_quote", "\\": "backslash", ":": "colon", ",": "comma"}
    return syntax.get(char, "space" if char.isspace() else "digit" if char.isdigit() else "letter" if char.isalpha() else "other")


def marker_json_diagnostic(text: list[str]) -> dict:
    """Structural JSON error flags only; never expose suffix/prompt contents."""
    result = {"worker_metadata_json_errors": [], "worker_metadata_terminal_newline": False,
              "worker_metadata_lexical_errors": []}
    for value in text:
        for line in value.splitlines(keepends=True):
            if not line.startswith(WORKER_MARKER):
                continue
            raw = line[len(WORKER_MARKER):].rstrip("\r\n")
            result["worker_metadata_terminal_newline"] |= line.endswith(("\n", "\r"))
            try:
                json.loads(raw)
            except json.JSONDecodeError as exc:
                kinds = {"Extra data": "trailing_data", "Unterminated string starting at": "unterminated_string",
                         "Expecting value": "expected_value", "Expecting ',' delimiter": "expected_delimiter",
                         "Expecting property name enclosed in double quotes": "expected_property"}
                category = kinds.get(exc.msg, "invalid_json")
                if len(result["worker_metadata_lexical_errors"]) < 4:
                    result["worker_metadata_lexical_errors"].append({"category": category,
                        "position": min(exc.pos, 4096), "length": min(len(raw), 65536),
                        "at": lexical_class(raw[exc.pos:exc.pos + 1]),
                        "before": lexical_class(raw[max(0, exc.pos - 1):exc.pos]),
                        "after": lexical_class(raw[exc.pos + 1:exc.pos + 2]),
                        "escaped_double_quote_count": min(raw.count(chr(92) + chr(34)), 256)})
                if category not in result["worker_metadata_json_errors"]:
                    result["worker_metadata_json_errors"].append(category)
                if category == "trailing_data":
                    suffix = raw[exc.pos:].lstrip()
                    result["worker_metadata_trailing_kind"] = (
                        "xml_tag" if suffix.startswith("<") else "bracket" if suffix.startswith("[")
                        else "object" if suffix.startswith("{") else "other")
    return result


def request_diagnostic(body: dict) -> dict:
    text = list(strings(body))
    result = {"request_keys": sorted(set(body) & REQUEST_KEYS),
              "messages_shape": value_shape(body.get("messages")), "input_shape": value_shape(body.get("input")),
              "tools_shape": value_shape(body.get("tools")), "tool_choice_shape": value_shape(body.get("tool_choice")),
              "worker_marker_line": any(line.startswith(WORKER_MARKER) for value in text for line in value.splitlines()),
              "worker_marker_embedded": any(WORKER_MARKER in value for value in text),
              "pack_marker_line": any(line.startswith(PACK_MARKER) for value in text for line in value.splitlines()),
              "categories": failure_categories(body), "shell_tools": [], "other_tool_count": 0,
              **marker_json_diagnostic(text), **sandbox_tool_diagnostic(body)}
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
