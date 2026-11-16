"""Real Markdown/ZIP exports and native ancillary panels on a commercial reply."""
import json
import secrets
import zipfile

from . import file_dialog
from .tao_real_flow import RealFlow


def run(ctx):
    flow = RealFlow(ctx, "archive", 1)
    marker = "QA" + secrets.token_hex(5)
    with flow.evidence():
        flow.send("Reply with exactly this Markdown, no outer fence:\n## QA Export\n\n" + marker + "\n\n```python\nprint(1 + 2)\n```")
        flow.reply("commercial-export-source", 1, marker, check_marker=True)
        raw = flow.copy_raw_reply()
        flow.click('[data-testid="tao-home-side-toggle"]')
        flow.click('[data-testid="tao-home-side-tab-artifacts"]')
        markdown = (ctx.case_dir / "actual-reply.md").resolve()
        file_dialog.run(ctx, dict(kind="save", action="choose", path=str(markdown),
                                 trigger='[data-testid="tao-home-artifacts"] article button'))
        flow.wait(lambda: markdown.read_text(encoding="utf-8").replace("\r", "") if markdown.exists() else None,
                  lambda text: text == raw, "Actual Markdown export differs from the real assistant reply")
        flow.record("native-markdown-export-exact", dict(exact=True, bytes=markdown.stat().st_size))
        flow.click('[data-testid="tao-home-side-tab-archive"]')
        archive = (ctx.case_dir / "actual-conversations.zip").resolve()
        file_dialog.run(ctx, dict(kind="save", action="choose", path=str(archive),
                                 trigger='[data-testid="tao-home-archive-export"]'))
        flow.wait(archive.exists, bool, "Native archive was not written")
        with zipfile.ZipFile(archive) as source:
            data = json.loads(source.read("conversations.json"))
        threads = [thread for thread in data["conversations"] if any(marker in message.get("text", "") for message in thread.get("messages", []))]
        flow.require(data["export_format_version"] == 3 and len(threads) == 1 and len(threads[0]["messages"]) == 2,
                     "Native ZIP v3 did not contain the real paired conversation")
        flow.record("native-zip-v3", dict(version=3, matchingConversations=1, messages=2))
        file_dialog.run(ctx, dict(kind="open", action="choose", path=str(archive), title="打开",
                                 trigger='[data-testid="tao-home-archive-import"]'))
        flow.wait(lambda: flow.read("return document.querySelector('[data-testid=\"tao-home-archive\"] [role=\"status\"]')?.textContent??'';"),
                  lambda text: "Imported" in text, "Native archive import did not report success")
        flow.require(marker in flow.last_text(), "Archive import did not preserve the actual transcript")
        flow.record("native-import-transcript", dict(markerRetained=True))

        flow.click('[data-testid="tao-home-side-tab-workflows"]')
        flow.wait(lambda: ctx.session.count('[data-testid="tao-home-workflows"] article button'), lambda n: n >= 5,
                  "Native built-in workflows did not load")
        flow.click('[data-testid="tao-home-workflows"] article:first-of-type button')
        flow.wait(lambda: ctx.session.count('[data-testid="tao-home-workflow-run"]'), lambda n: n == 1,
                  "Native workflow creation did not produce one durable pending run")
        flow.click('[data-testid="tao-home-side-toggle"]')
        flow.click('[data-testid="tao-home-side-toggle"]')
        flow.wait(lambda: ctx.session.count('[data-testid="tao-home-workflow-run"]'), lambda n: n == 1,
                  "Native workflow run disappeared on panel reopen")
        flow.record("workflow-create-and-reopen", dict(runs=1, scope="Creation/persistence only; step execution UI remains separate acceptance"))
        flow.click('[data-testid="tao-home-side-tab-memory"]')
        flow.wait(lambda: ctx.session.count('[data-testid="tao-home-memory"]'), bool, "Memory panel did not open")
        flow.click('[data-testid="tao-home-side-tab-skills"]')
        flow.wait(lambda: ctx.session.count('[data-testid="tao-home-memory"]'), bool, "Skills panel did not open")
        flow.click('[data-testid="tao-home-side-tab-voice"]')
        flow.click('[data-testid="tao-home-tts-stop"]')
        flow.require(not flow.read("return document.querySelector('[data-testid=\"tao-home-speech\"] [role=\"alert\"]')?.textContent??'';"),
                     "Native speech Stop exposed an error")
        flow.record("memory-skills-speech-panels", dict(opened=True, speechStop=True, positiveSpeechRecognition="not tested: fixture has no microphone/model input"))
        flow.require(len(flow.read("return window.__taomniQaTaoProvider.observe().calls;")) == 1,
                     "Ancillary panels automatically sent another paid request")
        flow.screenshot("archive-ancillary")
    return "Real configured provider archive and panels: " + flow.outcome
