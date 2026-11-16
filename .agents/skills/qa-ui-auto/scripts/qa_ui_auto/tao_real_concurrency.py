"""Actual native background stream ownership across independent conversations."""
import secrets

from .tao_real_documents import history_selector
from .tao_real_flow import RealFlow
from .tao_real_scenarios import INPUT, checkpoint, snapshot


def run(ctx):
    flow = RealFlow(ctx, "concurrency", 2)
    first, second = ("QA" + secrets.token_hex(5) for _ in range(2))
    prompt = first + " Synthetic test: begin with this exact token, then write 60 numbered software test checks of one sentence each. No tools."
    draft = "Independent draft while background stream is running"
    with flow.evidence():
        flow.send(prompt)
        observed = flow.wait(lambda: snapshot(ctx, first),
                             lambda s: s["running"] and s["lastReplyLength"] > 20,
                             "First actual native stream did not begin", 120)
        flow.record("first-stream-running", observed)
        ctx.session.fill(INPUT, draft)
        flow.new_chat()
        flow.send("Reply exactly with " + second + ", no other text.")
        # Both callbacks must finish through their own native stream owners.
        flow.wait(lambda: flow.read("return window.__taomniQaTaoProvider.observe().calls;"),
                  lambda calls: len(calls) == 2 and all(call["status"] != "pending" for call in calls),
                  "One native stream failed to finish after switching conversations", 150)
        flow.reply("second-thread", 1, second, check_marker=True)
        flow.require(first not in flow.last_text(), "Second thread contains the first thread's synthetic marker")
        flow.click('[data-testid="tao-home-history"]')
        flow.click(history_selector(prompt[:48]))
        restored = snapshot(ctx, first, draft)
        flow.require(checkpoint(restored, 2, 1) == "response-complete" and restored["draftRetained"] and second not in flow.last_text(),
                     "Background reply/draft was lost, crossed threads, duplicated or automatically resent")
        flow.record("background-completed-with-independent-draft", restored)
        flow.screenshot("background-restored")
    return "Real DeepSeek concurrent threads: " + flow.outcome
