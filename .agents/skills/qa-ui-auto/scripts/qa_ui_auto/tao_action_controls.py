"""Uncovered native action branches: review edits, L2 gating and real cancellation."""
import ctypes
import json
import os
import shlex
import sys

from .tao_real_development import CARDS, RESULTS, open_workspace
from .tao_real_flow import RealFlow


def alive(pid):
    if os.name == "nt":
        kernel = ctypes.windll.kernel32
        kernel.OpenProcess.restype = ctypes.c_void_p
        handle = kernel.OpenProcess(0x100000, False, pid)
        if not handle:
            return False
        try:
            return kernel.WaitForSingleObject(ctypes.c_void_p(handle), 0) == 258
        finally:
            kernel.CloseHandle(ctypes.c_void_p(handle))
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def run(ctx):
    flow = RealFlow(ctx, "action-controls", 3)
    root = (ctx.case_dir / "action-controls-workspace").resolve()
    root.mkdir(exist_ok=True)
    def propose(command, number, stage):
        action = dict(id="same-proposal", kind="run_command", title="Reviewed QA command", payload=dict(command=command))
        flow.send("QA_ACTION_CONTROLS\n" + json.dumps(action) + "\nQA_END_ACTION")
        flow.reply(stage, number)
    with flow.evidence():
        open_workspace(flow, root)
        flow.click('[data-testid="tao-home-mode-ask"]')
        propose("echo QA_ORIGINAL_MUST_NOT_RUN", 1, "ask-stays-read-only")
        flow.require(not flow.read(CARDS), "Ask mode exposed an executable action")
        flow.click('[data-testid="tao-home-mode-do"]')
        propose("echo QA_ORIGINAL_MUST_NOT_RUN", 2, "pending-edit")
        flow.require(len(flow.read(CARDS)) == 1, "Do mode did not expose one proposal")
        calls = len(flow.read("return window.__taomniQaTaoProvider.observe().calls;"))
        flow.click('[data-testid="tao-home-message-assistant"]:last-child [data-testid="tao-home-message-regenerate"]')
        flow.require(len(flow.read("return window.__taomniQaTaoProvider.observe().calls;")) == calls and len(flow.read(CARDS)) == 1,
                     "Regeneration bypassed the pending action review")
        flow.click('[data-testid="tao-home-action-card"] .tao-home-action-buttons button:nth-child(3)')
        ctx.session.fill('[data-testid="tao-home-action-card"] textarea', "rm -rf /qa-never-execute")
        flow.require(flow.read("return document.querySelector('[data-testid=\"tao-home-action-card\"] .primary').disabled;"),
                     "Editing a command to L2 did not require explicit confirmation")
        ctx.session.fill('[data-testid="tao-home-action-card"] textarea', "echo QA_EDIT_EXECUTED")
        flow.click('[data-testid="tao-home-action-card"] .tao-home-action-buttons button:nth-child(3)')
        flow.click('[data-testid="tao-home-action-card"] .primary')
        output = flow.wait(lambda: flow.read(RESULTS), lambda r: len(r) == 1, "Edited command did not return a result")[-1]
        flow.require("QA_EDIT_EXECUTED" in output and "QA_ORIGINAL_MUST_NOT_RUN" not in output and "exit 0" in output,
                     "The actual native executor did not run only the reviewed edit")
        flow.record("edited-risk-gate-and-execution", dict(askReadOnly=True, regenerationBlocked=True, l2Blocked=True, editedCommandExecuted=True))
        flow.screenshot("reviewed-command-edit")

        script = "import os,time,pathlib;pathlib.Path('started.txt').write_text(str(os.getpid()));time.sleep(30);pathlib.Path('late.txt').write_text('must not happen')"
        command = ('& "' + sys.executable + '" -c "' + script + '"') if os.name == "nt" else shlex.quote(sys.executable) + " -c " + shlex.quote(script)
        propose(command, 3, "long-command-proposal")
        flow.click('[data-testid="tao-home-action-card"] .primary')
        flow.wait((root / "started.txt").exists, bool, "Native cancellable child never started")
        pid = int((root / "started.txt").read_text())
        flow.require(alive(pid), "The cancellation precondition had no live child process")
        flow.click('[data-testid="tao-home-action-stop"]')
        results = flow.wait(lambda: flow.read(RESULTS), lambda r: len(r) == 2, "Cancelled native action did not settle")
        flow.require("Cancelled" in results[-1], "Cancellation was not presented as cancelled")
        flow.wait(lambda: alive(pid), lambda running: not running, "Cancellation left the native child process running")
        flow.require(not (root / "late.txt").exists(), "Cancelled command performed its delayed write")
        flow.record("real-child-cancelled", dict(started=True, childExited=True, delayedWrite=False))
        flow.screenshot("cancelled-command")
    return "Native action controls: " + flow.outcome
