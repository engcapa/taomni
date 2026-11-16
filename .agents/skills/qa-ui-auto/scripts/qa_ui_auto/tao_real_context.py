"""Native saved note retrieval and provider-driven reads of a bound workspace."""
from .tao_real_development import CARDS, open_workspace
from .tao_real_flow import RealFlow


def run(ctx):
    flow = RealFlow(ctx, "context", 2)
    root = (ctx.case_dir / "context-workspace").resolve()
    root.mkdir(exist_ok=True)
    (root / "guide.md").write_text("# Deployment guide\nThe QA deployment has two review stages.\n", encoding="utf-8")
    with flow.evidence():
        flow.click('[data-testid="rail-chat-button"]')
        flow.click('[data-testid="tao-hub-tab-notes"]')
        # Use the supported pinned layout for this persistence fixture. A
        # floating drawer dismisses on outside pointer input and is covered by
        # Notes' own docking cases, rather than being a retrieval precondition.
        pinned = flow.read("return document.querySelector('[data-testid=\"ai-chat-drawer-pin\"]').getAttribute('aria-pressed');")
        if pinned != "true":
            flow.click('[data-testid="ai-chat-drawer-pin"]')
        flow.click('[data-testid="notes-new"]')
        ctx.session.fill('[data-testid="note-editor-title"]', "QAcontextnotes deployment guide")
        ctx.session.fill('[data-testid="note-editor-body"]', "Deploy after tests pass. api_key=qa-synthetic-private-value")
        flow.click('[data-testid="note-editor-back"]')
        flow.click('[data-testid="notes-list-item"]')
        flow.require(flow.read("return document.querySelector('[data-testid=\"note-editor-body\"]').value.includes('Deploy after tests pass');"),
                     "The real note did not persist before Tao retrieval")
        flow.click('[data-testid="rail-chat-button"]')
        open_workspace(flow, root)
        flow.click('[data-testid="tao-home-mode-ask"]')
        flow.click('[data-testid="tao-home-search"]')
        ctx.session.fill('[data-testid="tao-home-search-input"]', "QAcontextnotes source:notes")
        found = flow.wait(lambda: flow.read("return [...document.querySelectorAll('.tao-home-search-result')].map(e=>e.textContent);"),
                          lambda rows: len(rows) == 1, "Native search did not retrieve the persisted note")
        flow.require("qa-synthetic-private-value" not in found[0] and "Deploy after tests pass" in found[0],
                     "Native local search leaked a synthetic secret or lost the saved content")
        flow.click('.tao-home-search-result button:first-child')
        flow.require(ctx.session.count('.tao-home-context-chip') == 1, "Selected saved note did not become reviewable context")
        flow.record("saved-note-redacted-and-selected", dict(nativeNotes=True, secretRedacted=True, chips=1))
        flow.send("QA_CONTEXT_TOOL_ROUND: Use the selected saved note. Call list_workspace_files for '.', read_workspace_file for 'guide.md', and search_local_records for 'SSH source:capabilities'. Explain how the saved deployment note, bound guide and Taomni connection features can inform the plan. Do not modify files or propose actions. Cite only actual tool results; no network.")
        flow.reply("ask-with-native-local-tools", 1)
        sources = flow.read("return [...document.querySelectorAll('.tao-home-sources a')].map(e=>({title:e.querySelector('strong')?.textContent,site:e.querySelector('span')?.textContent}));")
        flow.require(any(row["site"] == "workspace" and row["title"] == "guide.md" for row in sources),
                     "The provider did not return an actual bound-file source")
        flow.require(any(row["site"] == "capabilities" for row in sources),
                     "The provider did not retrieve Taomni capability metadata")
        flow.require(not flow.read(CARDS), "Ask mode exposed a mutating action")
        flow.record("native-workspace-and-capability-sources", dict(sources=sources, askReadOnly=True))
        flow.screenshot("local-context-sources")
        flow.click('[data-testid="tao-home-mode-research"]')
        # Research supports a local-only plan; no configured external search is needed.
        active = flow.read("return document.querySelector('[data-testid=\"tao-home-capabilities\"]').textContent;")
        if "Web" in active:
            flow.option("web")
        flow.send("Using the actual local sources from our previous turn, compare two deployment approaches and produce a brief plan, risks and verification steps. Remain local only, propose no actions and explicitly retain any uncertainty.")
        flow.reply("local-research-follow-up", 2)
        flow.require(not flow.read(CARDS), "Local research unexpectedly proposed a mutation")
        flow.record("research-local-continuation", dict(turns=2, noMutations=True, externalResearchVerified=False,
                     executionPlanStateMachineVerified=False))
        flow.screenshot("local-research")
    return "Native local context and research continuation: " + flow.outcome
