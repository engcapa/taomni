"""Real-provider UI scenarios; never replace IPC, responses or application state."""
from __future__ import annotations

import json
import uuid
from typing import Any

from .deadline import budget_time as time
from .steps import StepError
from .tao_provider_observation import READ, classify

INPUT = '[data-testid="tao-home-composer-input"]'
SEND = '[data-testid="tao-home-send"]'
DETAIL = r"""return (() => {
  const root = document.querySelector('[data-testid="tao-ai-chat"][data-tao-active="true"]');
  const replies = [...root.querySelectorAll('[data-testid="tao-home-message-assistant"]')];
  const last = replies.at(-1);
  const text = [...(last?.querySelectorAll('[data-testid="tao-home-markdown-reply"]') ?? [])]
    .map(el => el.textContent || '').join('').trim();
  const usage = last?.querySelector('.tao-home-usage-line')?.textContent || '';
  const input = /Input\s+(\d+)/.exec(usage), output = /Output\s+(\d+)/.exec(usage);
  const stopped = root.querySelector('[data-testid="tao-home-stopped-state"]');
  return {userCount:root.querySelectorAll('[data-testid="tao-home-message-user"]').length,
    lastReplyLength:text.length, markerRetained:text.includes(MARKER),
    draftRetained:root.querySelector('textarea')?.value === DRAFT,
    stopped:!!stopped && !!stopped.getClientRects().length,
    usage:input && output ? {inputTokens:Number(input[1]), outputTokens:Number(output[1])} : null};
})();"""


def snapshot(ctx: Any, marker: str, draft: str = "") -> dict:
    base = ctx.session.execute(READ)
    detail = ctx.session.execute(DETAIL.replace("MARKER", json.dumps(marker)).replace("DRAFT", json.dumps(draft)))
    return {**base, **detail}


def checkpoint(state: dict, calls: int, users: int, *, marker: bool = True) -> str | None:
    transport = state.get("transport")
    if not isinstance(transport, dict) or not transport.get("valid"):
        raise StepError("Real-provider transport observation is invalid")
    observed = transport.get("calls", [])
    if len(observed) > calls:
        raise StepError("Unexpected additional paid native invocation")
    if len(observed) < calls or state.get("running") or observed[-1].get("status") == "pending":
        return None
    if observed[-1].get("status") not in {"fulfilled", "rejected"}:
        raise StepError("Real-provider completion callback has an unknown status")
    if any(call.get("status") != "fulfilled" for call in observed[:-1]):
        raise StepError("An earlier provider invocation failed")
    normalized = {**state, "transport": {**transport, "calls": [observed[-1]]},
                  "assistantCount": 1, "replyLength": state.get("lastReplyLength", 0)}
    outcome = classify(normalized)
    if outcome == "credential-invalid":
        return outcome
    if outcome is None:
        return None
    if state.get("userCount") != users or state.get("assistantCount") != users:
        raise StepError("Real conversation duplicated or lost a user/assistant message")
    if marker and not state.get("markerRetained"):
        raise StepError("Real provider did not retain the synthetic token from the preceding turn")
    return outcome


def tail_visible(state: dict | None) -> bool:
    return bool(state and state.get("feedHeight", 0) > 0 and 0 <= state.get("gap", -1) <= 2
                and state.get("topVisible") is True and state.get("bottomVisible") is True)


def assert_tail_visible(ctx: Any, selector: str) -> dict:
    script = r"""return (() => {
      const root = document.querySelector('[data-testid="tao-ai-chat"][data-tao-active="true"]');
      const feed = root?.querySelector('.tao-home-feed');
      const child = [...(root?.querySelectorAll(SELECTOR) ?? [])].at(-1);
      if (!feed || !child) return null;
      const f = feed.getBoundingClientRect(), c = child.getBoundingClientRect();
      return {feedHeight:feed.clientHeight, gap:Math.max(0,feed.scrollHeight-feed.clientHeight-feed.scrollTop),
        topVisible:c.top >= f.top - 1, bottomVisible:c.bottom <= f.bottom + 1};
    })();""".replace("SELECTOR", json.dumps(selector))
    end = time.monotonic() + 5
    observed = None
    while time.monotonic() < end:
        observed = ctx.session.execute(script)
        if tail_visible(observed):
            return observed
        time.sleep(.05)
    raise StepError("The completed native reply/control was not followed into view: " + json.dumps(observed))


def run(ctx: Any, args: Any) -> str:
    if args is not None:
        raise StepError("tao_real_provider_scenarios does not accept arguments")
    marker = "TQ" + uuid.uuid4().hex[:12]
    stages = []
    outcome = "failed"

    def record(name: str, state: dict, result: str = "passed"):
        # State contains only counts, fixed metadata and booleans, never text or keys.
        stages.append({"stage": name, "outcome": result, "state": state})

    def wait_reply(name: str, calls: int, users: int) -> bool:
        end = time.monotonic() + 120
        state = None
        while time.monotonic() < end:
            state = snapshot(ctx, marker)
            result = checkpoint(state, calls, users)
            if result:
                record(name, state, result)
                ctx.session.screenshot(ctx.case_dir / f"real-{name}.png")
                return result != "credential-invalid"
            time.sleep(.1)
        record(name, state or {}, "timeout")
        raise StepError(f"Real-provider {name} did not complete before its deadline")

    def send(text: str):
        ctx.session.fill(INPUT, text)
        ctx.session.click(SEND)

    try:
        send(f"This is a synthetic UI test. Remember the test token {marker}. Reply with exactly that token, no other text.")
        if not wait_reply("first-turn", 1, 1):
            outcome = "credential-invalid"
            return "Real DeepSeek key invalid; no subsequent paid request was attempted"

        draft = "QA draft 保留草稿"
        ctx.session.fill(INPUT, draft)
        for language in ("zh-CN", "en"):
            ctx.session.click('[data-testid="language-switcher"]')
            ctx.session.click(f'[data-testid="language-option-{language}"]')
            state = snapshot(ctx, marker, draft)
            if not state["draftRetained"] or len(state["transport"]["calls"]) != 1:
                raise StepError("Language switch lost the draft or invoked the provider")
            record("locale-" + language, state)

        send("Return only the synthetic test token from my previous message. Do not invent a different token.")
        if not wait_reply("context-recall", 2, 2):
            outcome = "credential-invalid"
            return "Real DeepSeek key invalid during context recall; later requests were not attempted"

        ctx.session.click('.tao-home-message.assistant:last-child [data-testid="tao-home-message-regenerate"]')
        if not wait_reply("regenerate", 3, 2):
            outcome = "credential-invalid"
            return "Real DeepSeek key invalid during regeneration; later requests were not attempted"

        ctx.session.click('[data-testid="tao-home-new-chat"]')
        state = snapshot(ctx, marker)
        if state["assistantCount"] or state["userCount"] or not state["draftRetained"] or len(state["transport"]["calls"]) != 3:
            raise StepError("New chat retained the prior transcript/draft or invoked the provider")
        record("new-chat-isolation", state)

        send("Write a numbered list of 300 detailed software testing recommendations. Each item must contain two full sentences. Begin immediately with item 1; do not summarize or use any tools.")
        end = time.monotonic() + 120
        while time.monotonic() < end:
            state = snapshot(ctx, marker)
            if len(state["transport"]["calls"]) > 4:
                raise StepError("Unexpected paid request while waiting for a real stream")
            if state.get("running") and state.get("lastReplyLength", 0) >= 20:
                record("streaming-before-stop", state)
                break
            result = checkpoint(state, 4, 1, marker=False)
            if result == "credential-invalid":
                record("streaming-before-stop", state, result)
                outcome = result
                return "Real DeepSeek key invalid before stop; no retry was attempted"
            if result:
                raise StepError("Real reply finished before Stop could be exercised")
            time.sleep(.05)
        else:
            raise StepError("Real-provider stream did not produce text before the deadline")

        ctx.session.click('[data-testid="tao-home-side-toggle"]')
        layout = ctx.session.execute("return {chatRight:document.querySelector('.tao-home-main').getBoundingClientRect().right, sidebarLeft:document.querySelector('.tao-home-side-panel').getBoundingClientRect().left};")
        if layout["chatRight"] > layout["sidebarLeft"] + 1:
            raise StepError("The sidebar covered the real streaming conversation")
        record("streaming-sidebar-reflow", {**snapshot(ctx, marker), "layout": layout})
        ctx.session.click('[data-testid="tao-home-stop"]')
        end = time.monotonic() + 15
        while time.monotonic() < end:
            state = snapshot(ctx, marker)
            stops = state["transport"].get("stops", [])
            if checkpoint(state, 4, 1, marker=False) and state["stopped"] and len(stops) == 1 and stops[0]["status"] == "fulfilled":
                break
            time.sleep(.1)
        else:
            raise StepError("Stop did not finish the native invocation and retain a stopped partial reply")
        record("stopped", state)
        length = state["lastReplyLength"]
        time.sleep(1)
        state = snapshot(ctx, marker)
        if not state["stopped"] or state["running"] or state["errorCount"] or len(state["transport"]["calls"]) != 4 or state["lastReplyLength"] != length:
            raise StepError("Stopped reply changed, failed, or automatically invoked the provider")
        record("stopped-stable-no-retry", state)
        record("stopped-control-visible", assert_tail_visible(ctx, '[data-testid="tao-home-stopped-state"]'))
        ctx.session.screenshot(ctx.case_dir / "real-stopped.png")
        outcome = "scenarios-complete"
        return "Real DeepSeek: context recall, locale/draft retention, regeneration, new chat and Stop passed (4 requests)"
    finally:
        artifact = {"outcome": outcome, "tokenBudget": 1_000_000, "maximumRequests": 4,
                    "stages": stages,
                    "boundary": "Native IPC/renderer Stop completion; independent server socket-close evidence belongs to the loopback cases."}
        (ctx.case_dir / "real-provider-scenarios.json").write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
        status = ctx.case_dir / "real-provider-status.txt"
        with status.open("a", encoding="utf-8") as stream:
            stream.write(outcome + "\n")
