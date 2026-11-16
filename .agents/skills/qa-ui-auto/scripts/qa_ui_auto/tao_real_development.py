"""Native coding rounds: model-authored files, approved actions and real tests.

Only the UI sends prompts and approves proposals. Inspect actual files and exit
states; never manufacture the model's reply, patches or test results.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import sys
from pathlib import Path

from .deadline import budget_time as time
from .tao_real_flow import RealFlow

CARDS = r"""return [...document.querySelectorAll('[data-tao-active="true"] [data-testid="tao-home-action-card"]')].map(e=>({title:e.querySelector('strong')?.textContent,preview:e.querySelector('pre')?.textContent,content:e.querySelector('[data-testid="tao-home-action-content"]')?.textContent}));"""
RESULTS = r"""return [...document.querySelectorAll('[data-tao-active="true"] [data-testid="tao-home-action-result"]')].map(e=>e.textContent);"""


def open_workspace(flow, root):
    flow.click('[data-testid="nav-mode-workspaces"]')
    flow.click('[data-testid="workspace-open-session-plus"]')
    flow.click('[data-testid="workspace-plus-add-folder"]')
    flow.ctx.session.fill('[data-testid="workspace-fs-modal-input"]', root.as_posix())
    flow.click('[data-testid="workspace-fs-modal-confirm"]')
    flow.wait(lambda: flow.ctx.session.count('[data-testid="code-workspace-tree"]'), bool, "Isolated development workspace failed to open")
    flow.click('[data-testid="nav-mode-home"]')
    flow.click('[data-testid="tao-home-binding-workspace"]')
    flow.click('[data-testid="tao-home-binding-option"]')
    geometry = flow.read("const header=document.querySelector('.tao-home-topbar').getBoundingClientRect(); return [...document.querySelectorAll('.tao-home-binding-chip')].every(e=>{const rect=e.getBoundingClientRect();return rect.top>=header.top && rect.bottom<=header.bottom;});")
    flow.require(geometry, "A long native workspace binding wrapped outside the Home header")
    flow.click('[data-testid="tao-home-mode-do"]')


def approve_files(flow, root, allowed):
    cards = flow.read(CARDS)
    flow.require(bool(cards), "The real model did not propose reviewable file actions")
    before = len(flow.read(RESULTS))
    total = len(cards)
    for card in cards:
        path = Path(card["preview"] or "")
        resolved = (root / path).resolve() if not path.is_absolute() else path.resolve()
        flow.require(resolved.is_relative_to(root) and resolved.name in allowed and card.get("content") is not None,
                     "A coding proposal was not a permitted, reviewable file in the isolated workspace")
    for approved in range(total):
        flow.click('[data-testid="tao-home-action-card"] .tao-home-action-buttons button:first-child')
        flow.wait(lambda: flow.read(RESULTS), lambda results: len(results) == before + approved + 1,
                  "Approved native write did not return its actual execution result")
    results = flow.read(RESULTS)
    flow.require(all("Completed" in result and "exit 0" in result for result in results[before:]), "A native project write failed")


def test_project(flow, command, users, stage, failed=False, minimum=1):
    before = len(flow.read(RESULTS))
    flow.send("Propose exactly one run_command tao-action to execute this test command in the bound workspace. Copy the command exactly; do not run it yourself or propose files. Command: " + command)
    flow.reply(stage + "-proposal", users)
    flow.require(len(flow.read(CARDS)) == 1 and flow.read(CARDS)[0]["preview"] == command,
                 "The test proposal changed the authorized test command")
    flow.click('[data-testid="tao-home-action-card"] .tao-home-action-buttons button:first-child')
    results = flow.wait(lambda: flow.read(RESULTS), lambda r: len(r) == before + 1, "Native test process did not settle", 90)
    output = results[-1]
    count = re.search(r"Ran\s+(\d+)\s+tests?", output)
    if not count:
        count = re.search(r"(?:#|ℹ)\s*tests\s+(\d+)", output)
    flow.require(bool(count) and int(count[1]) >= minimum, "The native test process did not execute the required tests")
    flow.require(("Execution failed" in output and "exit 1" in output) if failed else ("Completed" in output and "exit 0" in output),
                 "Actual test process did not have the expected exit state")
    flow.record(stage, dict(exitCode=1 if failed else 0, testsRun=int(count[1]), nativeProcess=True, output=output[-3000:]))
    flow.screenshot(stage)


def run(ctx):
    flow = RealFlow(ctx, "development", 14)
    root = (ctx.case_dir / "agent-python-project").resolve()
    root.mkdir(exist_ok=True)
    python = f'& "{sys.executable}"' if os.name == "nt" else shlex.quote(sys.executable)
    command = python + " -m unittest discover -v"
    with flow.evidence():
        open_workspace(flow, root)
        contract = " Use write_file tao-action fences, one per file, at most five. All paths stay in the bound workspace. No shell commands in this response; await explicit approval."
        flow.send("Design and create a minimal Python calculator project from scratch. Create calculator.py exposing add(a,b) and multiply(a,b), and test_calculator.py with unittest covering positive, negative and zero operands. No dependencies or network. Include a short plan, then the two file proposals." + contract)
        flow.reply("design-and-develop", 1)
        flow.require(not (root / "calculator.py").exists(), "File was written before explicit approval")
        approve_files(flow, root, {"calculator.py", "test_calculator.py"})
        flow.require(all((root / name).is_file() for name in ("calculator.py", "test_calculator.py")), "Development proposals did not create both real project files")
        test_project(flow, command, 2, "initial-tests")

        # Deliberate regression represents real user feedback; preserve the
        # authored source and change one implementation through the same UI.
        flow.send("For a controlled failure-recovery test, propose replacing only calculator.py with add(a,b) returning a-b (intentionally wrong), preserving multiply. This is an explicit temporary regression; keep the tests unchanged." + contract)
        flow.reply("controlled-regression", 3)
        approve_files(flow, root, {"calculator.py"})
        test_project(flow, command, 4, "reported-failure", failed=True)

        flow.send("Use the actual failed test output from the previous confirmed execution to diagnose and repair calculator.py. Read the bound files if needed. Preserve correct multiplication and all current tests. Propose only the necessary file repair." + contract)
        flow.reply("diagnose-and-repair", 5)
        approve_files(flow, root, {"calculator.py"})
        test_project(flow, command, 6, "repair-tests")

        flow.send("Extend the existing project with divide(a,b), raising ValueError for division by zero. Preserve add and multiply. Update calculator.py and test_calculator.py to cover the new function, fractional division and the error branch. Include code changes and tests." + contract)
        flow.reply("feature-extension", 7)
        approve_files(flow, root, {"calculator.py", "test_calculator.py"})
        test_project(flow, command, 8, "feature-tests")
        flow.send("Review the actual confirmed development and test results. Summarize what was implemented, the observed failure and repair, and any remaining uncertainty. Do not propose actions or claim unexecuted tests passed.")
        flow.reply("final-review", 9)
        flow.require(not flow.read(CARDS), "The final review unexpectedly blocked on a new action")
        flow.record("project-files", dict(files=sorted(path.name for path in root.glob("*.py")), actualDisk=True))
        flow.screenshot("development-final")
    return "Real native coding loop: " + flow.outcome
