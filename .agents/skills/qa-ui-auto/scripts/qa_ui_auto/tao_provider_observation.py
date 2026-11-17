"""Read-only real-provider outcome oracle. Artifacts contain no keys or text."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .deadline import budget_time as time
from .steps import StepError

INSTALL = Path(__file__).with_name("tao_provider_observer.js").read_text(encoding="utf-8")
READ = r"""return (() => {
  const root = document.querySelector('[data-testid="tao-ai-chat"][data-tao-active="true"]')
    ?? document.querySelector('[data-testid="tao-ai-chat"]');
  if (!root) return {missingRoot:true};
  const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const errors = [...root.querySelectorAll('[data-testid="tao-home-error-state"]')].filter(visible);
  const text = errors.map(el => el.textContent || '').join('\n');
  const credential = /\bHTTP\s*[:=]?\s*(?:401|403)\b/i.test(text)
    || /(?:api[ _-]?key|credential|token|密钥|凭据).{0,50}(?:expired|has expired|过期|已失效)|(?:expired|过期).{0,50}(?:api[ _-]?key|credential|token|密钥|凭据)/i.test(text);
  const category = /network|connection|proxy|timeout|网络|代理|超时/i.test(text) ? 'network'
    : /protocol|parameter|请求参数|协议/i.test(text) ? 'protocol'
    : /configuration|config|配置/i.test(text) ? 'configuration' : 'provider';
  const assistants = [...root.querySelectorAll('[data-testid="tao-home-message-assistant"]')];
  const usageText = assistants.at(-1)?.querySelector('.tao-home-usage-line')?.textContent || '';
  const input = /Input\s+(\d+)/.exec(usageText), output = /Output\s+(\d+)/.exec(usageText);
  const replyLength = assistants.reduce((n, el) => n + [...el.querySelectorAll('[data-testid="tao-home-markdown-reply"]')]
    .reduce((sum, body) => sum + (body.textContent || '').trim().length, 0), 0);
  const retry = [...root.querySelectorAll('[data-testid="tao-home-retry"]')].some(el => visible(el) && !el.disabled);
  return {transport:window.__taomniQaTaoProvider?.observe() ?? null,
    assistantCount:assistants.length, replyLength, errorCount:errors.length,
    credentialInvalid:credential, errorCategory:category, retryVisible:retry,
    running:visible(root.querySelector('[data-testid="tao-home-stop"]')),
    noKeyVisible:visible(root.querySelector('[data-testid="tao-home-no-key"]')),
    usage:input && output ? {inputTokens:Number(input[1]), outputTokens:Number(output[1])} : null};
})();"""


def classify(state: Any) -> str | None:
    if not isinstance(state, dict) or state.get("missingRoot"):
        return None
    transport = state.get("transport")
    if not isinstance(transport, dict) or not transport.get("valid"):
        raise StepError("Tao real-provider observation transport is unavailable or invalid")
    calls = transport.get("calls", [])
    if len(calls) != 1 or calls[0].get("status") == "pending" or state.get("running"):
        return None
    if state.get("errorCount", 0):
        if not state.get("retryVisible"):
            raise StepError("Tao real-provider error has no visible enabled retry entry")
        if state.get("credentialInvalid"):
            return "credential-invalid"
        raise StepError("Tao real-provider request failed: " + state.get("errorCategory", "provider"))
    if calls[0].get("status") == "rejected":
        raise StepError("Tao real-provider request was rejected without a visible classified error")
    if state.get("noKeyVisible"):
        raise StepError("Tao real-provider request has no configured credential")
    if state.get("assistantCount") == 1 and state.get("replyLength", 0) > 0:
        return "response-complete"
    return None


def observe(ctx: Any, args: Any) -> str:
    if args is not None:
        raise StepError("observe_tao_provider does not accept arguments")
    result = ctx.session.execute("return (" + INSTALL + ")();")
    if result != {"installed": True, "forwarding": True}:
        raise StepError("Tao real-provider observer did not install")
    end = time.monotonic() + 5
    while time.monotonic() < end:
        state = ctx.session.execute("return window.__taomniQaTaoProvider?.observe() ?? null;")
        if isinstance(state, dict) and state.get("valid"):
            return "Verified forwarding-only observer of the configured native provider invocation"
        if isinstance(state, dict) and state.get("failure"):
            break
        time.sleep(.05)
    raise StepError("Tao real-provider observer control request did not complete")


def assert_outcome(ctx: Any, args: Any) -> str:
    if not isinstance(args, dict) or set(args) - {"timeout_sec", "require_success"}:
        raise StepError("assert_tao_provider_outcome expects timeout_sec and optional require_success")
    if not isinstance(args.get("require_success", False), bool):
        raise StepError("require_success must be a boolean")
    timeout = float(args.get("timeout_sec", 120))
    if not 0 < timeout <= 150:
        raise StepError("assert_tao_provider_outcome timeout must be in (0,150]")
    end = time.monotonic() + timeout
    state = None
    outcome = "failed"
    reason = "request did not finish with a nonempty assistant reply"
    try:
        while time.monotonic() < end:
            state = ctx.session.execute(READ)
            classified = classify(state)
            if classified:
                if args.get("require_success") and classified != "response-complete":
                    raise StepError("Tao real-provider requires a successful reply; credentials were rejected")
                outcome = classified
                reason = "visible enabled retry" if outcome == "credential-invalid" else "nonempty assistant reply without error"
                return f"Real provider outcome: {outcome}; {reason}"
            time.sleep(.1)
        raise StepError("Tao real-provider request did not complete before the outcome deadline")
    except StepError as error:
        reason = str(error)
        raise
    finally:
        # READ emits only booleans/counts and fixed classifications, never text.
        artifact = {"outcome": outcome, "reason": reason, "state": state}
        (ctx.case_dir / "real-provider-outcome.json").write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
        # Native verbs receive NativeStepContext, not the fixture context.
        # Both owners share the case directory, but only fixtures have values.
        status = ctx.case_dir / "real-provider-status.txt"
        if status.exists():
            with status.open("a", encoding="utf-8") as stream:
                stream.write(outcome + "\n")
