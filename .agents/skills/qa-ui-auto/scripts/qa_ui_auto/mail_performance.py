"""UI-driven latency probes. No IPC bypass; protocol overlap is observed independently."""
from __future__ import annotations
import json
import math
import platform
import re
import time
from pathlib import Path
from .steps import StepError


def percentile(samples, fraction):
    if not samples:
        raise ValueError("No timing samples")
    return sorted(samples)[max(0, math.ceil(len(samples) * fraction) - 1)]


class UI:
    def __init__(self, ctx):
        self.ctx = ctx
        self.native = hasattr(ctx, "session")

    def read(self, expression):
        if self.native:
            return self.ctx.session.execute("return (" + expression + ");")
        return self.ctx.page.evaluate("() => (" + expression + ")")

    def act(self, verb, args):
        if self.native:
            from .native_steps import VERBS
            return VERBS[verb](self.ctx, args)
        from .steps import get
        return get(verb)(self.ctx, args)

    def until(self, expression, timeout=10):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            last = self.read(expression)
            if last:
                return last
            time.sleep(.025)
        raise StepError(f"mail_performance_probe timed out: {expression}; last={last!r}")


def text(selector):
    return f"(document.querySelector({json.dumps(selector)})?.textContent || '')"


def native_observation():
    from . import mail_fake_server
    server = mail_fake_server.ACTIVE
    if server is None:
        raise StepError("mail_performance_probe requires mail_server")
    with server.state.lock:
        result = {"messages": server.state.count("INBOX"), "activeFetches": server.state.fetch_active,
                  "maxParallelFetches": server.state.fetch_max_parallel,
                  "fetchCount": len(server.state.fetch_events), "smtpCount": len(server.state.smtp_messages)}
    result["processes"] = []
    # Linux resource samples are supplemental. Timing/protocol assertions are portable.
    for entry in Path("/proc").glob("[0-9]*"):
        try:
            executable = str((entry / "exe").resolve())
            if "/target/qa-ui-auto/" not in executable or not executable.endswith("/taomni"):
                continue
            status = (entry / "status").read_text()
            result["processes"].append({"pid": int(entry.name), "executable": executable,
                "rssKiB": int(re.search(r"VmRSS:\s+(\d+)", status)[1]),
                "threads": int(re.search(r"Threads:\s+(\d+)", status)[1]),
                "stat": (entry / "stat").read_text()})
        except (OSError, TypeError):
            continue
    return result


def run(ctx, args):
    kind = args["kind"]
    label = args["label"]
    count = int(args.get("samples", 5))
    budget = float(args.get("max_p95_ms", 2000))
    if kind not in {"terminal", "read", "send", "concurrency"} or not re.fullmatch(r"[A-Za-z0-9_-]+", label):
        raise StepError("Invalid mail performance probe")
    if not 5 <= count <= 20 or budget <= 0:
        raise StepError("mail_performance_probe needs 5–20 samples and a positive budget")
    if getattr(ctx, "dry_run", False):
        return
    ui = UI(ctx)
    samples = []
    result = {"kind": kind, "label": label, "mode": "native" if ui.native else "browser",
              "platform": platform.platform(), "clock": "Python monotonic; UI dispatch to observed result, including automation overhead",
              "samplesMs": samples, "maxP95Ms": budget, "warmup": "none; all samples retained"}
    path = ctx.case_dir / f"mail-performance-{label}.json"
    try:
        if ui.native:
            result["before"] = native_observation()
        if kind == "concurrency":
            if not ui.native:
                raise StepError("Concurrency protocol proof requires native mode")
            from . import mail_fake_server
            state = mail_fake_server.ACTIVE.state
            with state.lock:
                events = list(state.fetch_events)
            result["fetchEvents"] = events
            result["connections"] = sorted({e["connection"] for e in events})
            result["serverThreads"] = sorted({e["thread"] for e in events})
            assert result["before"]["messages"] >= 33913, "Large mailbox fixture missing"
            assert result["before"]["maxParallelFetches"] >= 2, "FETCH requests never overlapped"
            assert len(result["connections"]) >= 4, "Expected independent interaction/background connections for two accounts"
            assert len(result["serverThreads"]) >= 4, "Expected concurrent server worker threads"
            assert ui.read('document.querySelectorAll(\'[data-testid="tab-item"][data-tab-type="mail"]\').length') >= 2, "Two mail sessions must remain open"
            if platform.system() == "Linux":
                assert any(p["threads"] >= 4 for p in result["before"]["processes"]), "QA native multi-threaded process missing"
        else:
            for index in range(count):
                if kind == "terminal":
                    marker = f"QA_MAIL_{label}_{index}_{time.time_ns()}"
                    # Echo is available in POSIX shells, cmd and PowerShell. A
                    # complete result line distinguishes output from command echo.
                    selector = '[data-testid="terminal-pane"]'
                    started = time.monotonic()
                    ui.act("terminal_input", {"selector": selector + " .xterm-helper-textarea", "text": "echo " + marker, "submit": True})
                    expression = f"(document.querySelector({json.dumps(selector)})?.getAttribute('data-terminal-text') || '').split(/\\r?\\n/).some(line => line.trim() === {json.dumps(marker)})"
                    ui.until(expression)
                elif kind == "read":
                    rows = '[data-testid="mail-client-tab"][data-active="true"] [data-testid="mail-message-row"]'
                    uid = ui.read(f"document.querySelectorAll({json.dumps(rows)})[{index}]?.getAttribute('data-uid')")
                    subject = ui.read(f"document.querySelectorAll({json.dumps(rows)})[{index}]?.textContent.match(/Stress [0-9]+/)?.[0]")
                    if not uid or not subject:
                        raise StepError("Stress mail rows missing; sync the fixture before measuring")
                    started = time.monotonic()
                    ui.act("click", rows + f'[data-uid="{uid}"]')
                    body = text('[data-testid="mail-client-tab"][data-active="true"] main [data-testid="mail-message-body-view"]')
                    if ui.native:
                        # Native plain-text MIME also gets an HTML alternative.
                        # Read the rendered sandbox document, not its srcdoc or
                        # the header snippet (neither proves reader readiness).
                        frame = '[data-testid="mail-client-tab"][data-active="true"] main [data-testid="mail-reader-html"]'
                        body = f"({body} + (document.querySelector({json.dumps(frame)})?.contentDocument?.body?.textContent || ''))"
                    ui.until(body + f".includes({json.dumps(('Body of ' if ui.native else 'Subject: ') + subject)})")
                else:
                    subject = f"QA concurrent send {label} {index}"
                    ui.act("click", '[data-testid="mail-client-tab"][data-active="true"] [data-testid="mail-compose-open"]')
                    ui.until('Boolean(document.querySelector(\'[data-testid="mail-compose-dialog"]\'))')
                    ui.act("fill", {"selector": '[data-testid="mail-recipient-to"] input', "value": "receiver@example.com"})
                    ui.act("press", "Enter")
                    ui.act("fill", {"selector": '[data-testid="mail-compose-subject"]', "value": subject})
                    ui.act("type", {"selector": '[data-testid="mail-compose-editor"]', "text": "Concurrency probe body"})
                    started = time.monotonic()
                    ui.act("click", '[data-testid="mail-compose-send"]')
                    ui.until('!document.querySelector(\'[data-testid="mail-compose-dialog"]\') && ' + text('[data-testid="mail-client-tab"][data-active="true"]') + '.includes("Message sent")')
                samples.append((time.monotonic() - started) * 1000)
            result["p50Ms"] = percentile(samples, .5)
            result["p95Ms"] = percentile(samples, .95)
            assert result["p95Ms"] <= budget, f"{label}: p95 {result['p95Ms']:.1f}ms exceeds {budget}ms"
        if ui.native:
            result["after"] = native_observation()
            if args.get("require_background"):
                assert result["after"]["fetchCount"] > result["before"]["fetchCount"], "Background FETCH made no progress during the UI probes"
                assert result["after"]["maxParallelFetches"] >= 2, "No actual overlapping fetches"
            if kind == "send":
                assert result["after"]["smtpCount"] - result["before"]["smtpCount"] == count, "SMTP accepted missing or duplicate sends"
        result["passed"] = True
    except BaseException as error:
        result["passed"] = False
        result["error"] = str(error)
        raise
    finally:
        if ui.native:
            result["after"] = native_observation()
            from . import mail_fake_server
            with mail_fake_server.ACTIVE.state.lock:
                result["fetchEvents"] = list(mail_fake_server.ACTIVE.state.fetch_events)
        path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    return str(path)
