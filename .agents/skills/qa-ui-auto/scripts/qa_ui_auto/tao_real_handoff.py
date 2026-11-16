"""Tao -> existing ACP bridge -> result preview -> explicit Tao continuation."""
import json

from .tao_real_flow import RealFlow


def run(ctx):
    flow = RealFlow(ctx, "handoff", 2)
    log = ctx.case_dir / "acp-handoff.json"
    with flow.evidence():
        flow.send("Build a Python development plan including tests, failure diagnosis, repair and feature extension. No actions yet.")
        flow.reply("initial-plan", 1)
        ctx.session.fill('[data-testid="tao-home-composer-input"]', "Private unsent draft")
        flow.click('[data-testid="tao-home-message-acp"]')
        preview = flow.read("return document.querySelector('[data-testid=\"tao-home-handoff-preview\"]')?.textContent??'';")
        flow.require("Build a Python" in preview and "Private unsent" not in preview, "Handoff preview lost its goal or leaked the unsent draft")
        flow.click('[data-testid="tao-home-handoff-preview"] + button + button')
        flow.require(not log.exists(), "Cancel unexpectedly dispatched the coding agent")
        flow.click('[data-testid="tao-home-message-acp"]')
        flow.click('[data-testid="tao-home-handoff-confirm"]')
        received = flow.wait(lambda: json.loads(log.read_text(encoding="utf-8")) if log.exists() else None, bool, "The native ACP peer did not receive its handoff", 45)
        flow.require(received.get("hasGoal") and received.get("hasHistory") and not received.get("hasUnsavedDraft"), "The actual native ACP request did not preserve the reviewed context")
        flow.wait(lambda: flow.read("return document.querySelector('[data-testid=\"ai-chat-drawer\"]')?.textContent?.includes('QA coding agent result') && !document.querySelector('[data-testid=\"ai-chat-send-button\"] .animate-spin');"), bool, "Native ACP result did not finish in the existing chat drawer")
        flow.record("actual-acp-process", received)
        flow.screenshot("acp-result")
        flow.click('[data-testid="nav-mode-home"]')
        flow.click('[data-testid="tao-home-handoff-return"]')
        chips = flow.wait(lambda: flow.read("return document.querySelector('[data-testid=\"tao-home-context-chips\"]')?.textContent??'';"), bool, "Coding agent result was not brought back for review")
        flow.require("Coding agent result" in chips, "Returned context did not identify the coding agent")
        flow.require(len(flow.read("return window.__taomniQaTaoProvider.observe().calls;")) == 1, "Bringing back a result sent an unapproved Tao request")
        flow.send("Use the returned coding agent result to continue the original development plan. No actions yet.")
        flow.reply("tao-continuation", 2)
        flow.record("returned-result-explicit-send", dict(nativeAcp=True, taoContinued=True))
    return "Native coding agent handoff: " + flow.outcome
