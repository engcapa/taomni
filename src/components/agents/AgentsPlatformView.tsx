import { Bot, GitBranch, GitMerge, Plus, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import {
  reviewAgentDiffInWorkspace,
  selectedAgentTask,
  useAgentsStore,
} from "../../stores/agentsStore";
import { useWorkspaceUiStore } from "../../stores/workspaceUiStore";
import {
  useWorkspacePlatformStore,
  type PlatformWorkspace,
} from "../../stores/workspacePlatformStore";

const MODELS = [
  "Claude Code (claude-sonnet-4-5)",
  "OpenAI Codex CLI",
  "OpenCode Local",
];

/**
 * `🤖 Agents` primary mode (TASK-09): parallel coding-agent worktree
 * orchestration with an explicit sandbox policy, live trace, pending command
 * approval, diff review and a jump into the workspace's Git panel.
 */
export function AgentsPlatformView() {
  const t = useT();
  const selected = useAgentsStore(selectedAgentTask);
  const workspaces = useWorkspacePlatformStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspacePlatformStore((s) => s.activeWorkspaceId);
  const dispatchOpen = useWorkspaceUiStore((s) => s.agentDispatchOpen);
  const openDispatch = useWorkspaceUiStore((s) => s.openAgentDispatch);
  const closeDispatch = useWorkspaceUiStore((s) => s.closeAgentDispatch);
  const setActiveSideTab = useAppStore((s) => s.setActiveSideTab);
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const [taskText, setTaskText] = useState("");
  const [model, setModel] = useState(MODELS[0]);
  const [targetWorkspaceId, setTargetWorkspaceId] = useState(activeWorkspaceId);

  useEffect(() => {
    if (dispatchOpen) {
      setTaskText("");
      setModel(MODELS[0]);
      setTargetWorkspaceId(activeWorkspaceId);
    }
  }, [activeWorkspaceId, dispatchOpen]);

  const targetWorkspace: PlatformWorkspace | undefined = useMemo(
    () => workspaces.find((workspace) => workspace.id === targetWorkspaceId) ?? workspaces[0],
    [targetWorkspaceId, workspaces],
  );

  const dispatch = () => {
    const text = taskText.trim();
    if (!text) return;
    useAgentsStore.getState().dispatchTask({
      task: text,
      model,
      workspaceId: targetWorkspace?.id ?? activeWorkspaceId,
      workspaceName: targetWorkspace?.name,
      workspaceRoot: targetWorkspace?.rootFolders[0]?.path,
    });
    closeDispatch();
    setActiveSideTab("agents");
    setStatusMessage(`Dispatched ${model} in an isolated Git worktree`);
  };

  return (
    <div data-testid="agents-platform-view" className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div
        className="flex h-9 shrink-0 items-center gap-2 border-b px-2"
        style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-card-bg)" }}
      >
        <Bot className="h-4 w-4" style={{ color: "var(--taomni-accent)" }} />
        <span className="text-[12.5px] font-semibold">{t("platform.agentsTitle")}</span>
        {selected && (
          <span className="rounded px-1 text-[10px]" style={{ border: "1px solid var(--taomni-divider)", color: "var(--taomni-text-muted)" }}>
            {selected.worktree}
          </span>
        )}
        <div className="flex-1" />
        <button type="button" data-testid="agents-dispatch-open" className="taomni-btn taomni-btn-primary h-6 px-2 inline-flex items-center gap-1" onClick={openDispatch}>
          <Plus className="h-3 w-3" />
          {t("platform.dispatchTask")}
        </button>
      </div>

      {!selected ? (
        <div data-testid="agents-empty-state" className="flex flex-1 flex-col items-center justify-center gap-2 p-6">
          <Bot className="h-8 w-8" style={{ color: "var(--taomni-text-muted)" }} />
          <div className="text-[13px] font-semibold">{t("platform.agentsSubtitle")}</div>
          <div className="text-[11.5px]" style={{ color: "var(--taomni-text-muted)" }}>{t("platform.agentPolicy")}</div>
          <button type="button" className="taomni-btn h-7 px-2" onClick={openDispatch}>{t("platform.dispatchTask")}</button>
        </div>
      ) : (
        <div data-testid="agents-task-detail" data-task-id={selected.id} className="grid min-h-0 flex-1 grid-cols-[1.05fr_0.95fr] gap-px" style={{ background: "var(--taomni-divider)" }}>
          <div className="flex min-h-0 flex-col gap-2 overflow-auto p-3" style={{ background: "var(--taomni-bg)" }}>
            <div className="rounded-lg border p-3" style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-card-bg)" }}>
              <div className="text-[12.5px] font-semibold">{selected.task}</div>
              <div className="mt-1 text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
                {selected.workspaceName} · <span className="font-mono">{selected.worktree}</span>
              </div>
              <div className="mt-1 flex items-center gap-1 text-[10.5px]" style={{ color: "var(--taomni-accent)" }}>
                <GitBranch className="h-3 w-3" />
                {selected.branch}
              </div>
            </div>

            <div className="flex items-center gap-2 rounded-lg border p-2 text-[11px]" style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-card-bg)" }}>
              <ShieldCheck className="h-4 w-4" style={{ color: "var(--taomni-success, #10b981)" }} />
              <span className="font-semibold">{t("platform.agentAllowed")}</span>
              <span style={{ color: "var(--taomni-text-muted)" }}>{t("platform.agentPolicy")}</span>
            </div>

            {selected.pendingCommand && (
              <div data-testid="agents-pending-command" className="rounded-lg border p-2" style={{ borderColor: "var(--taomni-warning, #d97706)", background: "rgba(245,158,11,0.12)" }}>
                <div className="flex items-center gap-1 text-[11.5px] font-semibold" style={{ color: "var(--taomni-warning, #d97706)" }}>
                  <TriangleAlert className="h-3.5 w-3.5" />
                  {t("platform.agentWaiting")}
                </div>
                <div className="mt-1 rounded px-2 py-1 font-mono text-[11px]" style={{ background: "var(--taomni-term-bg, #0f172a)", color: "var(--taomni-term-fg, #e2e8f0)" }}>
                  $ {selected.pendingCommand}
                </div>
                <div className="mt-2 flex gap-2">
                  <button type="button" data-testid="agents-approve" className="taomni-btn taomni-btn-primary h-6 px-2" onClick={() => useAgentsStore.getState().approveCommand(selected.id)}>
                    {t("platform.agentApprove")}
                  </button>
                  <button type="button" data-testid="agents-deny" className="taomni-btn h-6 px-2" onClick={() => useAgentsStore.getState().denyCommand(selected.id)}>
                    {t("platform.agentDeny")}
                  </button>
                </div>
              </div>
            )}

            <div data-testid="agents-trace" className="min-h-0 flex-1 overflow-auto rounded-lg p-2 font-mono text-[11px]" style={{ background: "var(--taomni-term-bg, #0f172a)", color: "var(--taomni-term-fg, #e2e8f0)" }}>
              <div style={{ color: "var(--taomni-text-muted)" }}>[{t("platform.agentTrace")} — {selected.name} ({selected.model})]</div>
              {selected.trace.map((line, index) => (
                <div key={`${index}-${line}`}>✓ {line}</div>
              ))}
            </div>
          </div>

          <div className="flex min-h-0 flex-col gap-2 overflow-auto p-3" style={{ background: "var(--taomni-bg)" }}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-semibold">
                {t("platform.agentDiff")} ({selected.filesChanged} · +{selected.additions}/-{selected.deletions})
              </span>
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  data-testid="agents-merge"
                  className="taomni-btn taomni-btn-primary h-6 px-2 inline-flex items-center gap-1"
                  onClick={() => setStatusMessage(`Merged ${selected.branch} into the workspace branch`)}
                >
                  <GitMerge className="h-3 w-3" />
                  {t("platform.mergeIntoWorkspace")}
                </button>
              </span>
            </div>
            <button
              type="button"
              data-testid="agents-review-in-git"
              className="taomni-btn h-7 w-full px-2 inline-flex items-center justify-center gap-1"
              onClick={() => {
                reviewAgentDiffInWorkspace(selected);
                setActiveSideTab("workspaces");
              }}
            >
              <GitBranch className="h-3.5 w-3.5" />
              {t("platform.reviewInGit")}
            </button>
            <div className="min-h-0 flex-1 overflow-auto rounded-lg border p-2 text-[11px]" style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-code-bg, #111827)", color: "var(--taomni-code-text, #e5e7eb)" }}>
              <div style={{ color: "var(--taomni-text-muted)" }}>{selected.trace.filter((line) => line.includes("src/")).join("\n") || t("platform.emptyWorkspaceHint")}</div>
            </div>
          </div>
        </div>
      )}

      {dispatchOpen && (
        <div
          className="fixed inset-0 z-[905] flex items-start justify-center pt-[14vh]"
          style={{ background: "rgba(0,0,0,0.35)" }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDispatch();
          }}
        >
          <div
            data-testid="agents-dispatch-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t("platform.dispatchTask")}
            className="flex w-[520px] flex-col gap-2 rounded-lg border p-3 shadow-2xl"
            style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-panel-bg)" }}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeDispatch();
            }}
          >
            <div className="flex items-center justify-between">
              <span className="text-[12.5px] font-semibold">{t("platform.dispatchTask")}</span>
              <button type="button" data-testid="agents-dispatch-close" aria-label={t("common.close")} className="rounded p-1 hover:bg-[var(--taomni-hover)]" onClick={closeDispatch}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <label className="text-[10.5px]" style={{ color: "var(--taomni-text-muted)" }}>{t("platform.agentTaskTarget")}</label>
            <select data-testid="agents-dispatch-workspace" className="taomni-input h-7" value={targetWorkspace?.id ?? ""} onChange={(event) => setTargetWorkspaceId(event.target.value)}>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
              ))}
            </select>
            <label className="text-[10.5px]" style={{ color: "var(--taomni-text-muted)" }}>Model</label>
            <select data-testid="agents-dispatch-model" className="taomni-input h-7" value={model} onChange={(event) => setModel(event.target.value)}>
              {MODELS.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
            </select>
            <label className="text-[10.5px]" style={{ color: "var(--taomni-text-muted)" }}>{t("platform.dispatchTask")}</label>
            <textarea
              data-testid="agents-dispatch-task-input"
              rows={4}
              className="taomni-input p-1.5"
              placeholder={t("platform.agentTaskPrompt")}
              value={taskText}
              onChange={(event) => setTaskText(event.target.value)}
            />
            <div className="flex justify-end gap-2">
              <button type="button" className="taomni-btn h-7 px-2" onClick={closeDispatch}>{t("common.cancel")}</button>
              <button type="button" data-testid="agents-dispatch-submit" className="taomni-btn taomni-btn-primary h-7 px-2" disabled={!taskText.trim()} onClick={dispatch}>
                {t("platform.dispatch")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
