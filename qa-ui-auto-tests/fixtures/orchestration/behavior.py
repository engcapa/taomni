"""Deterministic fixture decisions; no sockets, subprocesses, or filesystem writes."""
from __future__ import annotations

import hashlib
import json
import re
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

PACK_MARKER = "TAOMNI_PACK_MANIFEST="
WORKER_MARKER = "TAOMNI_ORCHESTRATION_FIXTURE="
SAFE_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,160}$")
MODEL_IDS = ("fixture-complete", "fixture-partial", "fixture-truncated", "fixture-error",
             "fixture-http-error", "fixture-worker")


class FixtureError(ValueError):
    """A malformed or unsupported request, never silently converted to success."""


def strings(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from strings(child)


def metadata(body: dict, marker: str) -> dict | None:
    found = None
    for text in strings(body):
        for line in text.splitlines():
            if not line.startswith(marker):
                continue
            try:
                candidate = json.loads(line[len(marker):])
            except (ValueError, TypeError) as exc:
                raise FixtureError("invalid fixture metadata JSON") from exc
            if not isinstance(candidate, dict):
                raise FixtureError("fixture metadata must be an object")
            found = candidate
    return found


def safe_id(value: Any, name: str) -> str:
    if not isinstance(value, str) or not SAFE_ID.fullmatch(value):
        raise FixtureError(f"invalid {name}")
    return value


def pack_text(manifest: dict, partial: bool = False) -> str:
    pack_id = safe_id(manifest.get("pack_id"), "pack_id")
    digest = manifest.get("input_digest")
    if not isinstance(digest, str) or not digest or len(digest) > 256:
        raise FixtureError("missing input_digest")
    ids = manifest.get("expected_ids")
    if not isinstance(ids, list) or not 0 < len(ids) <= 32:
        raise FixtureError("expected_ids must contain 1..32 unique IDs")
    ids = [safe_id(item, "item_id") for item in ids]
    if len(ids) != len(set(ids)):
        raise FixtureError("duplicate expected_ids")
    group = safe_id(manifest.get("group_id", "g1"), "group_id")
    frames = [{"type": "pack_start", "version": 1, "pack_id": pack_id,
               "input_digest": digest}]
    for item in ids:
        frames.extend([
            {"type": "item_header", "item_id": item, "group_id": group,
             "source_refs": [], "format": "markdown", "name": item + ".md"},
            {"type": "item_chunk", "item_id": item, "seq": 0,
             "text": f"# {item}\n\nDeterministic orchestration fixture candidate.\n"},
        ])
        if partial and item == ("tests" if "tests" in ids else ids[-1]):
            break
        frames.append({"type": "item_end", "item_id": item, "chunk_count": 1,
                       "status": "candidate"})
    else:
        frames.extend([
            {"type": "group_end", "group_id": group, "item_ids": ids},
            {"type": "pack_end", "item_ids": ids, "blocked_ids": []},
        ])
    return "".join(json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n"
                   for frame in frames)


def array_field(body: dict, key: str) -> list:
    value = body.get(key, [])
    if not isinstance(value, list):
        raise FixtureError(f"{key} must be an array")
    return value


def tool_results(body: dict, protocol: str) -> list[dict]:
    if protocol == "openai_chat":
        return [item for item in array_field(body, "messages")
                if isinstance(item, dict) and item.get("role") == "tool"]
    if protocol == "openai_responses":
        return [item for item in array_field(body, "input")
                if isinstance(item, dict) and item.get("type") == "function_call_output"]
    return [block for message in array_field(body, "messages") if isinstance(message, dict)
            and isinstance(message.get("content", []), list)
            for block in message.get("content", []) if isinstance(block, dict)
            and block.get("type") == "tool_result"]


def offered_tools(body: dict) -> list[dict]:
    result = []
    for tool in array_field(body, "tools"):
        if not isinstance(tool, dict):
            continue
        definition = tool.get("function", tool)
        if not isinstance(definition, dict) or not isinstance(definition.get("name"), str):
            raise FixtureError("tool definition requires a string name")
        result.append(definition)
    return result


@dataclass(frozen=True)
class Decision:
    text: str = ""
    tool_name: str | None = None
    tool_args: dict | None = None
    worker_id: str | None = None
    call_id: str | None = None
    scenario: str = "complete"
    tool_result_seen: bool = False


def decide(body: dict, protocol: str, worker_roots: dict[str, Path] | None = None) -> Decision:
    model = body.get("model", "fixture-complete")
    if not isinstance(model, str):
        raise FixtureError("model must be a string")
    # Claude Code may add a context suffix to the configured model ID.
    scenario = next((name.removeprefix("fixture-") for name in MODEL_IDS
                     if model == name or model.startswith(name + "[")), "complete")
    worker = metadata(body, WORKER_MARKER)
    if worker is not None:
        return worker_decision(body, protocol, worker, worker_roots or {})
    manifest = metadata(body, PACK_MARKER)
    if manifest is None:
        raise FixtureError("generation requires TAOMNI_PACK_MANIFEST or registered worker metadata")
    recovery = any(line == "TAOMNI_RECOVERY=true" for text in strings(body) for line in text.splitlines())
    if recovery and scenario == "partial":
        scenario = "complete"
    return Decision(text=pack_text(manifest, partial=scenario == "partial"), scenario=scenario)


def worker_decision(body: dict, protocol: str, worker: dict, roots: dict[str, Path]) -> Decision:
    worker_id = safe_id(worker.get("worker_id"), "worker_id")
    run_id = safe_id(worker.get("run_id"), "run_id")
    root = roots.get(worker_id)
    if root is None:
        raise FixtureError("worker is not registered with this fixture server")
    marker_path = worker.get("marker_path")
    if marker_path != "taomni-worker-marker.txt":
        raise FixtureError("worker marker must use the fixed worktree-relative filename")
    expected = f"taomni:{run_id}:{worker_id}\n"
    if worker.get("marker_text") != expected:
        raise FixtureError("worker marker text does not match ownership metadata")
    # Only a relative path is ever sent to a tool. The harness, not this module,
    # must use its real cwd to write the file in the assigned Git worktree.
    command = f"printf '%s' {shlex.quote(expected)} > {marker_path}"
    call_id = "call_" + hashlib.sha256(f"{run_id}:{worker_id}".encode()).hexdigest()[:24]
    results = tool_results(body, protocol)
    expected_result_key = {"openai_chat": "tool_call_id", "openai_responses": "call_id",
                           "anthropic_messages": "tool_use_id"}[protocol]
    matching = [result for result in results if result.get(expected_result_key) == call_id]
    if matching:
        if any(result.get("is_error") for result in matching):
            raise FixtureError("worker returned an error tool result")
        return Decision(text=json.dumps({"type": "worker_result", "status": "completed",
                                         "run_id": run_id, "worker_id": worker_id,
                                         "artifact": marker_path}), worker_id=worker_id,
                        call_id=call_id, scenario="worker-final", tool_result_seen=True)
    names = {tool.get("name"): tool for tool in offered_tools(body)}
    name = next((name for name in ("Bash", "bash", "exec_command", "shell_command", "shell")
                 if name in names), None)
    if name is None:
        raise FixtureError("no supported real shell tool advertised by harness")
    if name == "shell":
        args = {"command": ["/bin/sh", "-c", command], "workdir": str(root)}
    elif name == "exec_command":
        args = {"cmd": command, "max_output_tokens": 256}
    else:
        args = {"command": command}
        if name == "Bash":
            args["description"] = "Write the isolated QA worker marker"
        elif name == "bash":
            # Pi accepts timeout, OpenCode accepts timeout + description. Its
            # schema reveals which shape this pinned harness actually exposes.
            schema = names[name].get("parameters", names[name].get("input_schema", {}))
            if not isinstance(schema, dict) or not isinstance(schema.get("properties", {}), dict):
                raise FixtureError("shell tool schema must be an object")
            if "description" in schema.get("properties", {}):
                args["description"] = "Write the isolated QA worker marker"
    return Decision(tool_name=name, tool_args=args, worker_id=worker_id, call_id=call_id,
                    scenario="worker-tool")
