"""Commercial native Markdown, branch and history checks via the actual UI."""
from __future__ import annotations

import json
import uuid
from typing import Any

from .deadline import budget_time as time
from .steps import StepError
from .tao_real_scenarios import INPUT, SEND, assert_tail_visible, checkpoint, snapshot

DOCUMENT = r"""return (() => {
  const root = document.querySelector('[data-testid="tao-ai-chat"][data-tao-active="true"]');
  const bodies = [...root.querySelectorAll('[data-testid="tao-home-markdown-reply"]')];
  return {heading:bodies.some(el => [...el.querySelectorAll('h2')].some(h => h.textContent.trim() === 'QA Markdown')),
    table:bodies.some(el => [...el.querySelectorAll('table')].some(t => t.rows.length === 2 && t.rows[1].cells[0]?.textContent.trim() === '2 + 3' && t.rows[1].cells[1]?.textContent.trim() === '5')),
    code:bodies.some(el => [...el.querySelectorAll('pre code')].some(code => code.textContent.includes('print(') && code.textContent.includes(MARKER)))};
})();"""


def assert_document(state: dict) -> None:
    if not all(state.get(key) is True for key in ("heading", "table", "code")):
        raise StepError("Real reply did not render the requested heading, table and fenced code")


def history_selector(title: str) -> str:
    # JSON's \uXXXX form is not a CSS string escape (the Branch separator is ·).
    return '.tao-home-history-row[data-title=' + json.dumps(title, ensure_ascii=False) + ']'


def run(ctx: Any, args: Any) -> str:
    if args is not None:
        raise StepError("tao_real_provider_documents does not accept arguments")
    marker = "TQ" + uuid.uuid4().hex[:12]
    other = "TQ" + uuid.uuid4().hex[:12]
    prompt = (f"{marker} Markdown check. Return only the following Markdown, with no outer fence and no commentary. "
              "Keep this token in our conversation.\n\n## QA Markdown\n\n"
              f"Token: {marker}\n\n| Expression | Result |\n| --- | --- |\n| 2 + 3 | 5 |\n\n"
              f"```python\nprint(\"{marker}\")\n```")
    title = prompt[:48]
    stages = []
    outcome = "failed"

    def state(token=marker, draft=""):
        return snapshot(ctx, token, draft)

    def record(name, observed, result="passed"):
        stages.append({"stage": name, "outcome": result, "state": observed})

    def wait_reply(name, calls, users, token=marker):
        end = time.monotonic() + 120
        while time.monotonic() < end:
            observed = state(token)
            result = checkpoint(observed, calls, users)
            if result:
                record(name, observed, result)
                return result != "credential-invalid"
            time.sleep(.1)
        raise StepError(f"Real document scenario {name} did not finish before its deadline")

    def send(text):
        ctx.session.fill(INPUT, text)
        ctx.session.click(SEND)

    def document():
        end = time.monotonic() + 5
        observed = {}
        while time.monotonic() < end:
            observed = ctx.session.execute(DOCUMENT.replace("MARKER", json.dumps(marker)))
            if all(observed.values()) and len(observed) == 3:
                break
            time.sleep(.1)
        assert_document(observed)
        return observed

    def select_history(selected_title):
        ctx.session.click('[data-testid="tao-home-history"]')
        ctx.session.click(history_selector(selected_title))

    try:
        send(prompt)
        if not wait_reply("markdown-reply", 1, 1):
            outcome = "credential-invalid"
            return "DeepSeek key invalid; Markdown, branch and history checks were not completed"
        record("markdown-structure", document())
        record("markdown-in-viewport", assert_tail_visible(ctx, '[data-testid="tao-home-markdown-reply"]'))
        ctx.session.screenshot(ctx.case_dir / "real-markdown.png")

        ctx.session.click('[data-testid="tao-home-message-branch"]')
        end = time.monotonic() + 10
        while time.monotonic() < end:
            observed = state()
            operations = observed["transport"].get("operations", [])
            if len(operations) > 1 or any(op["status"] == "rejected" for op in operations):
                raise StepError("Native context clone failed or was invoked more than once")
            if len(operations) == 1 and operations[0]["status"] == "fulfilled":
                break
            time.sleep(.05)
        else:
            raise StepError("Native branch context clone did not complete")
        if checkpoint(observed, 1, 1) != "response-complete":
            raise StepError("Branching lost or duplicated the real source transcript")
        record("native-context-cloned", observed)
        send("Reply only with the synthetic test token from my first message. Do not include any other text.")
        if not wait_reply("branch-context-recall", 2, 2):
            outcome = "credential-invalid"
            return "DeepSeek key invalid on branch reply; remaining history checks were not completed"
        draft = "QA branch draft 保留草稿"
        ctx.session.fill(INPUT, draft)
        ctx.session.screenshot(ctx.case_dir / "real-branch.png")

        ctx.session.click('[data-testid="tao-home-new-chat"]')
        send(f"This is a separate synthetic conversation. Reply exactly with {other}, no other text.")
        if not wait_reply("separate-conversation", 3, 1, other):
            outcome = "credential-invalid"
            return "DeepSeek key invalid in separate chat; remaining history checks were not completed"

        select_history(title)
        observed = state()
        if checkpoint(observed, 3, 1) != "response-complete" or not observed["draftRetained"]:
            raise StepError("History did not restore the unchanged original conversation and empty draft")
        record("original-history-unchanged", {**observed, "document": document()})
        select_history(title + " · Branch")
        observed = state(draft=draft)
        if checkpoint(observed, 3, 2) != "response-complete" or not observed["draftRetained"]:
            raise StepError("History did not restore the branch's two turns and independent draft")
        record("branch-history-draft-restored", observed)
        record("history-tail-in-viewport", assert_tail_visible(ctx, '[data-testid="tao-home-markdown-reply"]'))
        time.sleep(1)
        observed = state(draft=draft)
        if len(observed["transport"]["calls"]) != 3 or observed["running"] or observed["errorCount"]:
            raise StepError("History selection automatically sent a request or exposed an error")
        record("history-no-automatic-request", observed)
        ctx.session.screenshot(ctx.case_dir / "real-history-restored.png")
        outcome = "documents-complete"
        return "Real DeepSeek Markdown, native branch context, original/branch history and draft isolation passed (3 requests)"
    finally:
        artifact = {"outcome": outcome, "maximumRequests": 3, "stages": stages,
                    "boundary": "Actual commercial replies and native context clone; history reopening in the same process. Restart persistence is covered by TC-TAO-HOME-004."}
        (ctx.case_dir / "real-provider-documents.json").write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
        with (ctx.case_dir / "real-provider-status.txt").open("a", encoding="utf-8") as stream:
            stream.write(outcome + "\n")
