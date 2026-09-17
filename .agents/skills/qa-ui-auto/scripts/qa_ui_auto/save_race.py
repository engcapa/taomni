"""ED-PARITY-002 save-race time-point collector (isolated QA build only).

Controls `window.__taomniQaSaveGate`, which is installed exclusively by the
`pnpm build --mode qa` bundle used for the `com.taomni.app.qa` binary. The gate
holds one explicit save-transaction delivery point while the runner types into
the live editor:

* `prepare` - prepare/history await finished, byte writer not yet invoked.
* `ack`     - the REAL native writer was invoked; its real ack is withheld.
* `watcher` - the REAL watched-files notify was invoked and the real ack was
              delivered; the writeback merge has not run.
* `fault`   - withholds one REAL successful write response at the transport
              boundary (recorded as a controlled fault, never an OS failure).

The verbs never fabricate acks or hashes and never write app state: the harness
only arms/releases holds and persists the in-page timeline the production code
itself recorded. A missing gate (production binary) is a hard step failure.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

from .steps import StepError

GATE = "window.__taomniQaSaveGate"
STAGES = ("prepare", "ack", "watcher", "fault")
FAULT_MODES = ("unknown-response", "unknown-response-delay")
DEFAULT_ARTIFACT = "save-race-trace.json"
NOTES_ARTIFACT = "save-race-notes.json"

# Conservative read-only guard for `save_race_note`: the expression must only
# read the page. Mirrors the schema-level eval_readonly restrictions.
_MUTATION_PATTERNS = (
    r"[^=!<>]=[^=]",
    r"\+=|-=|\*=|/=",
    r"\bawait\b",
    r"\bfunction\b",
    r"\bnew\b",
    r"\.click\(",
    r"\bsetAttribute\(",
    r"\bremoveAttribute\(",
    r"\bdispatchEvent\(",
    r"\.innerHTML\s*=",
    r"\bdocument\.write",
)


def _dict(args: Any, verb: str, required: set[str] | None = None) -> dict[str, Any]:
    if not isinstance(args, dict):
        raise StepError(f"{verb}: expected an object argument, got {args!r}")
    if required and not required <= set(args):
        raise StepError(f"{verb}: expected {sorted(required)} in {args!r}")
    return args


def _gate_status(ctx: Any) -> dict[str, Any]:
    status = ctx.session.execute(f"const gate = {GATE}; return gate ? gate.status() : null;")
    if not isinstance(status, dict):
        raise StepError(
            "save race probe is missing: this binary is not the isolated QA build "
            "(expected com.taomni.app.qa with save gate enabled)"
        )
    return status


def arm(ctx: Any, args: Any) -> str:
    request = _dict(args, "save_race_arm", {"stage"})
    stage = str(request["stage"])
    if stage not in STAGES:
        raise StepError(f"save_race_arm: stage must be one of {STAGES}, got {stage!r}")
    payload: dict[str, Any] = {"stage": stage}
    for key in ("workspaceId", "fileKey", "transactionId", "filePath"):
        if request.get(key) is not None:
            payload[key] = str(request[key])
    if request.get("mode") is not None:
        mode = str(request["mode"])
        if stage != "fault" or mode not in FAULT_MODES:
            raise StepError(
                f"save_race_arm: mode is fault-only and must be one of {FAULT_MODES}, got {mode!r}"
            )
        payload["mode"] = mode
    if request.get("timeoutMs") is not None:
        payload["timeoutMs"] = int(request["timeoutMs"])
    result = ctx.session.execute(
        f"const gate = {GATE}; return gate ? gate.arm({json.dumps(payload)}) : null;"
    )
    if not isinstance(result, dict) or not result.get("ok"):
        raise StepError(f"save_race_arm: gate rejected {payload!r}: {result!r}")
    return f"armed {stage}" + (f" for {payload.get('filePath')}" if payload.get("filePath") else "")


def wait_entered(ctx: Any, args: Any) -> str:
    request = _dict(args, "save_race_wait_entered", {"stage"})
    stage = str(request["stage"])
    timeout = float(request.get("timeout_sec", 20))
    deadline = time.monotonic() + timeout
    started = time.monotonic()
    last: Any = None
    while time.monotonic() < deadline:
        status = _gate_status(ctx)
        held = status.get("held")
        if isinstance(held, dict) and held.get("stage") == stage:
            waited = time.monotonic() - started
            return (
                f"entered {stage} after {waited:.2f}s "
                f"(transaction={held.get('transactionId')}, revision pending)"
            )
        last = status
        time.sleep(0.05)
    raise StepError(
        f"save_race_wait_entered: {stage} was not entered within {timeout}s; last status={last!r}"
    )


def release(ctx: Any, args: Any) -> str:
    request = args if isinstance(args, dict) else {}
    reason = str(request.get("reason", "runner-release"))
    result = ctx.session.execute(
        f"const gate = {GATE}; return gate ? gate.release({{reason: {json.dumps(reason)}}}) : null;"
    )
    if not isinstance(result, dict) or not result.get("ok"):
        raise StepError(f"save_race_release: no matching held stage to release: {result!r}")
    return f"released ({reason})"


def trace(ctx: Any, args: Any) -> str:
    request = args if isinstance(args, dict) else {}
    entries = ctx.session.execute(f"const gate = {GATE}; return gate ? gate.trace() : null;")
    if not isinstance(entries, list):
        raise StepError(
            "save_race_trace: save race probe is missing (not the isolated QA build)"
        )
    artifact = Path(ctx.case_dir) / str(request.get("artifact", DEFAULT_ARTIFACT))
    artifact.parent.mkdir(parents=True, exist_ok=True)
    artifact.write_text(json.dumps(entries, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    events = [entry.get("event") for entry in entries if isinstance(entry, dict)]
    expected_contains = request.get("expect_contains")
    if expected_contains is not None:
        if not isinstance(expected_contains, list):
            raise StepError("save_race_trace: expect_contains must be a list of events")
        position = 0
        for wanted in expected_contains:
            try:
                position = events.index(wanted, position) + 1
            except ValueError as exc:
                raise StepError(
                    f"save_race_trace: expected ordered events {expected_contains!r}; "
                    f"missing {wanted!r} in {events!r}"
                ) from exc
    expected_events = request.get("expect_events")
    if expected_events is not None and events != list(expected_events):
        raise StepError(
            f"save_race_trace: event sequence {events!r} != expected {list(expected_events)!r}"
        )
    if request.get("require_ack_hashes"):
        acks = [
            entry for entry in entries
            if isinstance(entry, dict) and entry.get("event") == "ack-delivered"
        ]
        if not acks:
            raise StepError("save_race_trace: no ack-delivered event was recorded")
        for entry in acks:
            detail = entry.get("detail") if isinstance(entry.get("detail"), dict) else {}
            if not detail.get("writtenHash"):
                raise StepError(
                    "save_race_trace: ack-delivered is missing the real native writtenHash"
                )
    settled_kind = request.get("require_settled_kind")
    if settled_kind is not None:
        settled = [
            entry for entry in entries
            if isinstance(entry, dict) and entry.get("event") == "commit-settled"
        ]
        if not settled:
            raise StepError("save_race_trace: no commit-settled event was recorded")
        observed = settled[-1].get("detail", {}).get("kind")
        if observed != settled_kind:
            raise StepError(
                f"save_race_trace: settled kind {observed!r} != required {settled_kind!r}"
            )
    readback_outcome = request.get("require_readback_outcome")
    if readback_outcome is not None:
        readbacks = [
            entry for entry in entries
            if isinstance(entry, dict) and entry.get("event") == "unknown-readback"
        ]
        if not readbacks:
            raise StepError("save_race_trace: no unknown-readback event was recorded")
        observed_outcome = readbacks[-1].get("detail", {}).get("outcome")
        if observed_outcome != readback_outcome:
            raise StepError(
                f"save_race_trace: read-back outcome {observed_outcome!r} "
                f"!= required {readback_outcome!r}"
            )
    forbid = request.get("forbid_between")
    if forbid is not None:
        if not isinstance(forbid, dict) or not {"anchor", "until", "events"} <= set(forbid):
            raise StepError(
                "save_race_trace: forbid_between expects {anchor, until, events}"
            )
        anchor, until = str(forbid["anchor"]), str(forbid["until"])
        try:
            start = len(events) - 1 - events[::-1].index(anchor)
        except ValueError as exc:
            raise StepError(f"save_race_trace: anchor event {anchor!r} is missing") from exc
        try:
            end = events.index(until, start + 1)
        except ValueError as exc:
            raise StepError(
                f"save_race_trace: {until!r} did not follow anchor {anchor!r}"
            ) from exc
        window = events[start + 1:end]
        present = [event for event in forbid["events"] if event in window]
        if present:
            raise StepError(
                f"save_race_trace: forbidden events {present!r} occurred between "
                f"{anchor!r} and {until!r}: {window!r}"
            )
    return f"trace artifact: {artifact} ({len(entries)} entries)"


def note(ctx: Any, args: Any) -> str:
    """Record one read-only DOM/JS observation into a durable case artifact.

    Used for facts that must be *recorded* rather than asserted (focus,
    selection, undo grouping, recovery row text). The expression is rejected
    when it looks like a mutation; it never executes app actions.
    """
    request = _dict(args, "save_race_note", {"label", "expression"})
    label = str(request["label"])
    expression = str(request["expression"])
    for pattern in _MUTATION_PATTERNS:
        if re.search(pattern, expression):
            raise StepError(
                f"save_race_note: expression looks like a mutation ({pattern!r}): {expression!r}"
            )
    value = ctx.session.execute(f"return ({expression});")
    try:
        ctx.session.execute(
            f"const gate = {GATE};"
            f"if (gate && typeof gate.note === 'function')"
            f" gate.note({{label: {json.dumps(label)}, value: {json.dumps(value)}}});"
            "return true;"
        )
    except Exception:  # noqa: BLE001 - the durable Python artifact is authoritative
        pass
    artifact = Path(ctx.case_dir) / str(request.get("artifact", NOTES_ARTIFACT))
    notes: list[dict[str, Any]] = []
    if artifact.exists():
        try:
            loaded = json.loads(artifact.read_text(encoding="utf-8"))
            if isinstance(loaded, list):
                notes = loaded
        except (OSError, json.JSONDecodeError):
            notes = []
    notes.append({
        "label": label,
        "value": value,
        "recordedAtUnixMs": int(time.time() * 1000),
    })
    artifact.write_text(json.dumps(notes, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return f"noted {label}: {str(value)[:120]}"
