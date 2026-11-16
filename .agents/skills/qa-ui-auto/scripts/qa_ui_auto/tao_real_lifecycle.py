"""Actual edit-branch isolation and Stop -> Continue with retained stream prefix."""
import secrets

from .tao_real_documents import history_selector
from .tao_real_flow import RealFlow
from .tao_real_scenarios import INPUT, snapshot, checkpoint


def run(ctx):
    flow = RealFlow(ctx, "lifecycle", 4)
    marker = "QA" + secrets.token_hex(5)
    edited = "QA" + secrets.token_hex(5)
    prompt = "Synthetic test: reply exactly " + marker
    with flow.evidence():
        flow.send(prompt)
        flow.reply("original", 1, marker, check_marker=True)
        flow.click('[data-testid="tao-home-message-edit"]')
        observed = flow.wait(lambda: snapshot(ctx, "", prompt),
                             lambda s: len(s["transport"]["operations"]) == 1 and s["transport"]["operations"][0]["status"] == "fulfilled",
                             "Edit did not finish native context clone")
        flow.require(observed["userCount"] == observed["assistantCount"] == 0 and observed["draftRetained"],
                     "Editing the first message did not start an isolated branch with the original draft")
        flow.send("Synthetic edited test: reply exactly " + edited)
        flow.reply("edited-branch", 1, edited, check_marker=True)
        flow.require(marker not in flow.last_text(), "Edited branch leaked the original assistant token")
        flow.click('[data-testid="tao-home-history"]')
        flow.click(history_selector(prompt[:48]))
        original = snapshot(ctx, marker)
        flow.require(checkpoint(original, flow.calls, 1) == "response-complete" and edited not in flow.last_text(),
                     "Editing changed the original conversation")
        flow.record("original-unchanged-after-edit", original)

        flow.new_chat()
        flow.send("Write a numbered list of 120 detailed software testing checks. Each item has two sentences. Start immediately with item 1; no tools or summary.")
        flow.wait(lambda: snapshot(ctx, ""), lambda s: s["running"] and s["lastReplyLength"] >= 80,
                  "Real native stream did not begin before Stop", 120)
        flow.click('[data-testid="tao-home-stop"]')
        stopped = flow.wait(lambda: snapshot(ctx, ""),
                            lambda s: not s["running"] and s["stopped"] and s["transport"]["calls"][-1]["status"] == "fulfilled",
                            "Native Stop did not retain a partial response")
        prefix = flow.copy_raw_reply()
        flow.require(len(prefix) >= 80, "Stopped reply lost the observed stream prefix")
        flow.record("stopped-before-continue", stopped)
        flow.screenshot("before-continue")
        flow.calls += 1
        flow.click('[data-testid="tao-home-continue"]')
        completed = flow.reply("real-continue", 1)
        continued = flow.copy_raw_reply()
        flow.require(continued.startswith(prefix) and len(continued) > len(prefix) and not completed["stopped"],
                     "Continue lost/duplicated the retained prefix or did not append actual text")
        flow.require(completed["transport"]["calls"][-1]["command"] == "deepseek_app_continue",
                     "Continue did not use the native continuation path")
        flow.record("continued-prefix-retained", dict(prefixLength=len(prefix), continuedLength=len(continued), userCount=1, assistantCount=1))
        flow.screenshot("continued")
    return "Real DeepSeek lifecycle: " + flow.outcome
