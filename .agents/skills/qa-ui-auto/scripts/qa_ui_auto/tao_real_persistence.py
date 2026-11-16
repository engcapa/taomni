"""Commercial conversation and preferences across a normal native process restart."""
import json
import secrets

from .deadline import budget_time as time
from .tao_real_documents import history_selector
from .tao_real_flow import RealFlow
from .tao_real_scenarios import INPUT, snapshot


def run(ctx, stage):
    flow = RealFlow(ctx, "persistence-" + stage, 1)
    path = ctx.case_dir / "restart-synthetic-context.json"
    with flow.evidence():
        if stage == "prepare":
            marker = "QA" + secrets.token_hex(6)
            prompt = "Remember this synthetic restart word " + marker + ". Reply exactly with it."
            flow.send(prompt)
            flow.reply("before-native-restart", 1, marker, check_marker=True)
            draft = "Unsent draft retained after real restart"
            ctx.session.fill(INPUT, draft)
            path.write_text(json.dumps(dict(marker=marker, prompt=prompt, draft=draft)), encoding="utf-8")
            # The product owns a documented 180ms disk debounce; do not reseed it.
            time.sleep(.5)
            flow.record("restart-ready", snapshot(ctx, marker, draft))
            flow.screenshot("restart-before")
        else:
            if not path.is_file():
                # Only a confirmed invalid credential in the prepare phase may
                # omit the content check; normal prepare failure stops the case.
                status = (ctx.case_dir / "real-expanded-persistence-prepare.json").read_text(encoding="utf-8")
                if json.loads(status)["outcome"] == "credential-invalid":
                    from .tao_real_flow import CredentialInvalid
                    raise CredentialInvalid()
                flow.require(False, "Missing retained restart context")
            expected = json.loads(path.read_text(encoding="utf-8"))
            flow.click('[data-testid="tao-home-history"]')
            flow.click(history_selector(expected["prompt"][:48]))
            state = snapshot(ctx, expected["marker"], expected["draft"])
            flow.require(state["userCount"] == state["assistantCount"] == 1 and state["markerRetained"] and state["draftRetained"] and not state["transport"]["calls"],
                         "Cold native restart lost transcript/draft or automatically sent a request")
            flow.record("cold-native-transcript-and-draft", state)
            flow.send("Return only the synthetic restart token from my earlier message.")
            flow.reply("commercial-context-after-restart", 2, expected["marker"], check_marker=True)
            flow.screenshot("restart-after")
    return "Real configured provider native persistence: " + flow.outcome
