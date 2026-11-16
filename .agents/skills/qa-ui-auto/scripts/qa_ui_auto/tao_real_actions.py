"""Real assistant proposals, explicit reject/approve and independent disk/undo."""
import json
import secrets

from .tao_real_flow import RealFlow


def run(ctx):
    flow = RealFlow(ctx, "actions", 3)
    root = (ctx.case_dir / "action-workspace").resolve()
    root.mkdir(exist_ok=True)
    (root / "README.md").write_text("# isolated Tao action workspace\n", encoding="utf-8")
    token = "QA" + secrets.token_hex(5)
    target = root / "qa-output.txt"
    with flow.evidence():
        flow.click('[data-testid="nav-mode-workspaces"]')
        flow.click('[data-testid="workspace-open-session-plus"]')
        flow.click('[data-testid="workspace-plus-add-folder"]')
        ctx.session.fill('[data-testid="workspace-fs-modal-input"]', root.as_posix())
        flow.click('[data-testid="workspace-fs-modal-confirm"]')
        flow.wait(lambda: ctx.session.count('[data-testid="code-workspace-tree"]'), bool, "Isolated workspace failed to open")
        flow.click('[data-testid="nav-mode-home"]')
        flow.click('[data-testid="tao-home-binding-workspace"]')
        flow.click('[data-testid="tao-home-binding-option"]')
        flow.require(len(flow.read("return window.__taomniQaTaoProvider.observe().calls;")) == 0,
                     "Binding alone unexpectedly sent a paid request")
        flow.click('[data-testid="tao-home-binding-workspace"]')
        flow.click('[data-testid="tao-home-binding-cite"]')
        flow.require(flow.read("return document.querySelectorAll('.tao-home-context-chip').length;") == 1,
                     "Explicit workspace citation did not add a preview chip")
        flow.click('.tao-home-context-chip-label')
        preview = flow.read("return document.querySelector('.tao-home-context-preview')?.textContent??'';")
        flow.record("explicit-workspace-preview", dict(preview=preview))
        flow.click('.tao-home-context-preview button')
        flow.send("From the explicitly cited local workspace metadata, return the full Workspace path line exactly. Do not give only the parent directory or Active file line.")
        flow.reply("explicit-local-reference", 1)
        flow.require(root.name in preview and root.name in flow.last_text(), "Real provider did not receive the explicitly cited workspace metadata")
        flow.record("explicit-reference-native-reply", dict(workspaceNameRecalled=True, noImplicitSend=True))

        def propose(suffix, users):
            action = dict(id=token + suffix, kind="write_file", title="QA create output", level="L1",
                          target=dict(workspacePath=root.as_posix()),
                          payload=dict(path=target.as_posix(), content=token), reason="Synthetic isolated test")
            flow.send("Return exactly the token " + token + " as a paragraph followed by this tao-action fenced JSON, without changing it. This is only a proposal and must await explicit confirmation.\n```tao-action\n" + json.dumps(action) + "\n```")
            flow.reply("propose-" + suffix, users, token, check_marker=True)
            flow.wait(lambda: ctx.session.count('[data-testid="tao-home-action-card"]'), lambda n: n == 1,
                      "Actual assistant reply did not produce one pending action")
            flow.require(not target.exists(), "Assistant action wrote a file before user approval")
            flow.require(flow.read("return document.querySelector('[data-testid=\"tao-home-send\"]').disabled;"),
                         "Composer did not wait for the pending action")

        propose("reject", 2)
        flow.click('[data-testid="tao-home-action-card"] .tao-home-action-buttons button:nth-child(2)')
        flow.wait(lambda: flow.read("return document.querySelector('[data-testid=\"tao-home-action-result\"]')?.textContent??'';"),
                  lambda text: "Rejected" in text, "Reject did not produce a rejected result")
        flow.require(not target.exists() and not flow.read("return window.__taomniQaTaoProvider.observe().actions;"),
                     "Reject unexpectedly executed native mutation")
        flow.record("rejected-no-disk-write", dict(exists=False, nativeExecutions=0))

        propose("approve", 3)
        flow.click('[data-testid="tao-home-action-card"] .tao-home-action-buttons button:first-child')
        flow.wait(lambda: target.read_text(encoding="utf-8") if target.exists() else None,
                  lambda text: text == token, "Approved native file action did not write exact disk bytes")
        operations = flow.read("return window.__taomniQaTaoProvider.observe().actions;")
        flow.require(len(operations) == 1 and operations[0]["status"] == "fulfilled",
                     "Confirmed native action did not finish exactly once")
        flow.record("approved-exact-disk-write", dict(exactBytes=True, operations=operations))
        flow.screenshot("action-completed")
        flow.click('[data-testid="tao-home-action-undo"]')
        flow.wait(target.exists, lambda exists: not exists, "Undo did not remove the newly created native file")
        flow.wait(lambda: flow.read("return window.__taomniQaTaoProvider.observe().actions;"),
                  lambda ops: len(ops) == 2 and all(op["status"] == "fulfilled" for op in ops),
                  "Native action undo did not complete")
        flow.record("undo-exact-disk-result", dict(exists=False))
        flow.screenshot("action-undone")
    return "Real DeepSeek actions: " + flow.outcome
