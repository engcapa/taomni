"""UI actions must finish while a real SDK process and real IPC remain pending.

The production version-probe timeout stays at five seconds. A fresh heartbeat
from the independently compiled SDK child is required after each action; passing
only after that timeout is an explicit failure. Every action uses the existing
driver input methods. Only observations use JavaScript.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

from .deadline import budget_time as time
from .language_startup_observer import validate_observation
from .steps import StepError

ACTION_BUDGET_MS = 1500
SDK_PROBE_TIMEOUT_MS = 5000
EDITED_SOURCE = "export const edited = 7;"
SOURCE_SCENARIOS = {
    "typescript": ("src/index.ts", "export const platform", EDITED_SOURCE),
    "java": ("src/Main.java", "public class Main", "public class Main { int value = 7; }"),
}


def selector(testid: str) -> str:
    return f'[data-testid="{testid}"]'


def pending_child(events: list[dict], now_ms: float, pid: int | None = None) -> dict:
    started = {event["pid"]: event["epochMs"] for event in events if event["phase"] == "started"}
    if len(started) > 1:
        raise StepError(f"Concurrent callers launched {len(started)} SDK probes for the same root; expected one shared probe")
    ended = {event["pid"] for event in events if event["phase"] in {
        "released", "rejected", "fixture-timeout",
    }}
    candidates = [event for event in events if event["phase"] == "waiting"
                  and event["pid"] not in ended and (pid is None or event["pid"] == pid)
                  and event["pid"] in started
                  and 0 <= now_ms - started[event["pid"]] < SDK_PROBE_TIMEOUT_MS
                  and 0 <= now_ms - event["epochMs"] <= 500]
    if not candidates:
        raise StepError("SDK child is no longer alive and waiting; a completed/timed-out probe is not responsiveness evidence")
    return max(candidates, key=lambda event: event["epochMs"])


def run(ctx: Any, args: Any) -> str:
    if not isinstance(args, dict) or not {"events", "gate"} <= set(args) or set(args) - {"events", "gate", "language"}:
        raise StepError("native_sdk_startup_probe expects {events, gate, language?}")
    language = args.get("language", "typescript")
    if not isinstance(language, str) or language not in SOURCE_SCENARIOS:
        raise StepError("native_sdk_startup_probe language must be typescript or java")
    source_path, initial_source, edited_source = SOURCE_SCENARIOS[language]
    events_path, gate = (Path(str(args[key])).resolve() for key in ("events", "gate"))
    if not all(path.is_relative_to(ctx.case_dir.resolve()) for path in (events_path, gate)):
        raise StepError("SDK probe files must belong to this retained QA case")
    if gate.exists():
        raise StepError("SDK release gate already exists before the responsiveness check")
    report: dict = {"passed": False, "sourcePath": source_path, "actionBudgetMs": ACTION_BUDGET_MS, "actions": []}
    session = ctx.session
    source_row = selector("code-workspace-tree-file") + f'[data-path="{source_path}"]'
    notes_row = selector("code-workspace-tree-file") + '[data-path="Documents/notes.txt"]'
    editor = selector("workspace-file-editor") + " .cm-content"

    def read(expression: str) -> Any:
        return session.execute("return (" + expression + ");")

    def observation() -> dict:
        state = read("window.__taomniQaLanguageStartup?.observe() ?? null")
        return validate_observation(state)

    def events() -> list[dict]:
        # Each child appends one short JSON line per heartbeat; ignore only an
        # unfinished final line, which the next read must replace with a full one.
        text = events_path.read_text(encoding="utf-8")
        return [json.loads(line) for line in text.splitlines(keepends=True) if line.endswith("\n")]

    child_pid: int | None = None

    def require_pending(state: dict | None = None) -> dict:
        if gate.exists():
            raise StepError("SDK was released before the UI actions finished")
        child = pending_child(events(), time.time() * 1000, child_pid)
        state = observation() if state is None else state
        pending = [event for event in state["events"] if event["status"] == "pending"
                   and event["command"] in {"sdk_resolve_workspace", "lsp_open_document", "lsp_document_status"}]
        if not pending:
            raise StepError("SDK child exists but the actual SDK/LSP IPC is no longer pending")
        return {"child": child, "pendingInvocations": pending}

    def until(expression: str, expires: float) -> Any:
        while time.monotonic() < expires:
            value = read(expression)
            if value:
                return value
            time.sleep(.01)
        raise StepError("UI result did not appear within the unchanged 1500ms responsiveness budget")

    def action(label: str, invoke: Callable[[], Any], expression: str, *, pending: bool = True) -> None:
        started = time.monotonic()
        record = {"label": label, "started": started, "passed": False}
        report["actions"].append(record)
        try:
            invoke()
            until(expression, started + ACTION_BUDGET_MS / 1000)
            if pending:
                record["sdkPending"] = require_pending()
            record["durationMs"] = (time.monotonic() - started) * 1000
            if record["durationMs"] > ACTION_BUDGET_MS:
                raise StepError(f"{label} exceeded {ACTION_BUDGET_MS}ms: {record['durationMs']:.1f}ms")
            record["passed"] = True
        finally:
            record.setdefault("durationMs", (time.monotonic() - started) * 1000)

    def content_is(text: str) -> str:
        return f"document.querySelector({json.dumps(editor)})?.textContent === {json.dumps(text)}"

    try:
        observation()
        # File read/publication must complete without awaiting SDK discovery.
        action("open-source", lambda: session.dblclick(source_row),
               "document.querySelector(" + json.dumps(editor) + ")?.textContent.includes(" + json.dumps(initial_source) + ")", pending=False)
        started = time.monotonic()
        while time.monotonic() - started < 1.5:
            state = observation()
            try:
                child_pid = require_pending(state)["child"]["pid"]
                break
            except StepError:
                time.sleep(.01)
        if child_pid is None:
            raise StepError("Opening a real source never reached the held SDK process")
        report["sourceOpenWhileSdkPending"] = require_pending()
        action("edit-source", lambda: session.fill(editor, edited_source), content_is(edited_source))
        action("home", lambda: session.click(selector("nav-mode-home")),
               "!!document.querySelector('[data-testid=\"welcome-panel\"]')")
        action("restore-workspace", lambda: session.click(selector("nav-mode-workspaces")), content_is(edited_source))
        action("open-ordinary-file", lambda: session.dblclick(notes_row),
               "document.querySelector(" + json.dumps(editor) + ")?.textContent.includes('Weekly notes')")
        report["finalPending"] = require_pending()
        report["sdkProbeStarts"] = len({event["pid"] for event in events() if event["phase"] == "started"})
        report["passed"] = True
        return "Source editing, Home/Workspace restoration and ordinary-file opening completed during real SDK discovery"
    finally:
        try:
            try:
                report["invokeObservation"] = observation()
                report["sdkEvents"] = events()
            except Exception as error:
                report["captureError"] = str(error)
                if report["passed"]:
                    report["passed"] = False
                    raise
            finally:
                (ctx.case_dir / "sdk-startup-responsiveness.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        finally:
            gate.write_text("release\n", encoding="utf-8")
