"""Bounded real-provider flows. All mutations go through public native UI paths."""
from __future__ import annotations

import json
import traceback
from contextlib import contextmanager
from typing import Any

from .deadline import budget_time as time
from .steps import StepError
from .tao_real_scenarios import INPUT, SEND, checkpoint, snapshot


class CredentialInvalid(Exception):
    """Only an explicit expired credential/HTTP 401 or 403 can end early."""


class RealFlow:
    def __init__(self, ctx: Any, scenario: str, maximum: int):
        self.ctx, self.scenario, self.maximum = ctx, scenario, maximum
        self.calls = 0
        self.stages: list[dict] = []
        self.usage: dict[int, dict] = {}
        self.outcome = "failed"

    def read(self, script: str):
        value = self.ctx.session.execute("try { " + script + " } catch(error) { return {__qaReadError:String(error)}; }")
        if isinstance(value, dict) and value.get("__qaReadError"):
            raise StepError("Expanded observation failed: " + value["__qaReadError"])
        return value

    def click(self, selector: str):
        self.ctx.session.click(selector)

    def wait(self, read, accept, message: str, seconds=15):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            observed = read()
            if accept(observed):
                return observed
            time.sleep(.1)
        self.record("deadline-" + message, observed, "failed")
        raise StepError(message)

    def record(self, stage: str, observed: Any, outcome="passed"):
        self.stages.append(dict(stage=stage, outcome=outcome, state=observed))

    def screenshot(self, label: str):
        self.ctx.session.screenshot(self.ctx.case_dir / ("expanded-" + label + ".png"))

    def send(self, text: str):
        if self.calls >= self.maximum:
            raise StepError("Real-provider request budget exhausted")
        self.ctx.session.fill(INPUT, text)
        self.calls += 1
        self.click(SEND)

    def reply(self, stage: str, users: int, marker="", *, check_marker=False):
        def complete(observed):
            return checkpoint(observed, self.calls, users, marker=check_marker)
        observed = self.wait(lambda: snapshot(self.ctx, marker), complete,
                             "Real-provider " + stage + " did not complete", 150)
        result = complete(observed)
        self.record(stage, observed, result)
        if result == "credential-invalid":
            raise CredentialInvalid()
        if observed.get("usage"):
            self.usage[self.calls] = observed["usage"]
        return observed

    def last_text(self):
        return self.read("return [...([...document.querySelectorAll('[data-tao-active=\"true\"] [data-testid=\"tao-home-message-assistant\"]')].at(-1)?.querySelectorAll('[data-testid=\"tao-home-markdown-reply\"]')??[])].map(e=>e.textContent).join('').trim();")

    def copy_raw_reply(self):
        from . import host_clipboard
        previous = host_clipboard.get_text()
        sentinel = "QA waiting for explicit native message Copy"
        try:
            host_clipboard.set_text(sentinel)
            self.click('[data-testid="tao-home-message-assistant"]:last-child button[aria-label="Copy"]')
            # Keep any prior host text out of recorded deadline diagnostics.
            self.wait(lambda: host_clipboard.get_text() != sentinel, bool,
                      "Native message Copy did not replace the test clipboard sentinel")
            return host_clipboard.get_text().replace("\r", "")
        finally:
            host_clipboard.set_text(previous)

    def require(self, condition: bool, message: str):
        if not condition:
            raise StepError(message)

    def new_chat(self):
        self.click('[data-testid="tao-home-new-chat"]')
        value = snapshot(self.ctx, "")
        self.require(value["userCount"] == value["assistantCount"] == 0 and value["draftRetained"],
                     "New chat did not start with empty messages and draft")
        self.record("new-chat", value)

    def option(self, name: str):
        self.click('[data-testid="tao-home-capabilities"]')
        self.click('[data-testid="tao-home-capability-' + name + '"]')

    @contextmanager
    def evidence(self):
        try:
            yield self
            self.outcome = self.scenario + "-complete"
        except CredentialInvalid:
            self.outcome = "credential-invalid"
            self.record("remaining-stages-unverified", {"reason": "API key invalid; no further paid request attempted"}, "unrun")
        except Exception:
            (self.ctx.case_dir / "expanded-failure-traceback.txt").write_text(traceback.format_exc(), encoding="utf-8")
            raise
        finally:
            observed = snapshot(self.ctx, "")
            count = len((observed.get("transport") or {}).get("calls", []))
            config_path = self.ctx.case_dir / "real-provider-config.json"
            config = json.loads(config_path.read_text(encoding="utf-8")) if config_path.exists() else {}
            artifact = dict(outcome=self.outcome, provider=config.get("provider", "deepseek-app"), model=config.get("model"), tokenBudget=config.get("tokenBudget", 2_000_000), maximumRequests=self.maximum,
                            reasoningEffort=config.get("reasoningEffort"), actualRequests=count, usageByRequest=self.usage, stages=self.stages,
                            boundary="Loopback scripted provider with real desktop/native actions and processes" if config.get("transport") == "loopback" else "Real desktop UI, native IPC and configured commercial provider. No provider/state replacement; cancelled stream usage may be absent.")
            (self.ctx.case_dir / ("real-expanded-" + self.scenario + ".json")).write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
            with (self.ctx.case_dir / "real-provider-status.txt").open("a", encoding="utf-8") as stream:
                stream.write(self.outcome + "\n")
