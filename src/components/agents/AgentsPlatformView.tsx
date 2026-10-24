import { useState } from "react";
import { Bot, GitBranch, Info, Plus, ShieldCheck, ShieldX } from "lucide-react";
import { TextInputDialog } from "../sidebar/ConfirmDialog";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { useAgentTasksStore } from "./agentTasksStore";

/**
 * Agents first-class mode (v6.1 TASK-09): parallel coding-agent orchestration
 * on isolated Git worktrees. Dispatching a task creates a worktree sandbox;
 * "review diff" jumps to the workspace's built-in Git panel.
 */
export function AgentsPlatformView({ visible }: { visible: boolean }) {
  const t = useT();
  const tasks = useAgentTasksStore((s) => s.tasks);
  const selectedTaskId = useAgentTasksStore((s) => s.selectedTaskId);
  const dispatchTask = useAgentTasksStore((s) => s.dispatchTask);
  const updateTask = useAgentTasksStore((s) => s.updateTask);
  const setActiveSideTab = useAppStore((s) => s.setActiveSideTab);
  const workspaces = useWorkspacePlatformStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspacePlatformStore((s) => s.activeWorkspaceId);
  const activeWorkspace = workspaces.find((ws) => ws.id === activeWorkspaceId) ?? workspaces[0];
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const selected = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0] ?? null;

  const reviewInGitPanel = () => {
    if (!activeWorkspace) return;
    setActiveSideTab("workspaces");
    useWorkspacePlatformStore.getState().openGitPanel(activeWorkspace.id);
  };

  return (
    <div data-testid="agents-platform-view" className="flex h-full min-h-0 w-full" style={{ background: "var(--taomni-bg)", color: "var(--taomni-text)" }} data-visible={visible || undefined}>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-8 shrink-0 items-center gap-2 border-b px-3" style={{ borderColor: "var(--taomni-divider)" }}>
          <Bot className="h-4 w-4" />
          <span className="text-[13px] font-semibold">{t("agentsPlatform.title")}</span>
          <span className="text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>{t("agentsPlatform.subtitle")}</span>
          <span className="flex-1" />
          <button
            type="button"
            data-testid="agents-review-diff"
            className="flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] hover:bg-[var(--taomni-hover)]"
            style={{ borderColor: "var(--taomni-divider)" }}
            onClick={reviewInGitPanel}
          >
            <GitBranch className="h-3.5 w-3.5" />
            {t("agentsPlatform.reviewDiff")}
          </button>
          <button
            type="button"
            data-testid="agents-dispatch-task"
            className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium text-white"
            style={{ background: "var(--taomni-accent)" }}
            onClick={() => setDispatchOpen(true)}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("agentsPlatform.dispatch")}
          </button>
        </div>
        {/* Honest state: this mode is a UI scaffold until an agent/worktree
            backend exists (v6.1 review H7). */}
        <div
          data-testid="agents-preview-notice"
          role="status"
          className="flex shrink-0 items-start gap-2 border-b px-3 py-1.5 text-[11px]"
          style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-panel-bg)", color: "var(--taomni-text-muted)" }}
        >
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{t("agentsPlatform.localOnlyNotice")}</span>
        </div>
        {tasks.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-[12px]" style={{ color: "var(--taomni-text-muted)" }}>
            {t("agentsPlatform.empty")}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="w-[300px] shrink-0 overflow-y-auto border-r p-2" style={{ borderColor: "var(--taomni-divider)" }} data-testid="agents-task-list">
              {tasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  data-testid={`agents-task-${task.id}`}
                  className="mb-1 flex w-full flex-col gap-1 rounded border px-2 py-2 text-left"
                  style={{
                    borderColor: task.id === (selected?.id ?? "") ? "var(--taomni-accent)" : "var(--taomni-divider)",
                    background: task.id === (selected?.id ?? "") ? "var(--taomni-selected)" : "var(--taomni-panel-bg)",
                  }}
                  onClick={() => useAgentTasksStore.getState().selectTask(task.id)}
                >
                  <span className="flex items-center gap-1.5 text-[12px] font-semibold">
                    <Bot className="h-3.5 w-3.5" />
                    <span className="min-w-0 flex-1 truncate">{task.title}</span>
                    <span className="rounded px-1 text-[9px] uppercase" style={{ background: "var(--taomni-hover)", color: "var(--taomni-text-muted)" }}>
                      {task.status}
                    </span>
                  </span>
                  <span className="flex items-center gap-2 text-[10px]" style={{ color: "var(--taomni-text-muted)" }}>
                    <span className="flex items-center gap-1"><GitBranch className="h-3 w-3" />{task.branch}</span>
                    <span className="truncate">{task.worktreePath}</span>
                  </span>
                </button>
              ))}
            </div>
            <div className="flex min-w-0 flex-1 flex-col p-3" data-testid="agents-task-detail">
              {selected && (
                <>
                  <div className="mb-2 text-[13px] font-semibold">{selected.title}</div>
                  <div className="mb-3 flex flex-wrap gap-2 text-[11px]">
                    <span className="flex items-center gap-1 rounded border px-2 py-1" style={{ borderColor: "var(--taomni-divider)" }}>
                      <ShieldCheck className="h-3.5 w-3.5" style={{ color: "#2ea043" }} />
                      {t("agentsPlatform.sandboxAllowed")}
                    </span>
                    <span className="flex items-center gap-1 rounded border px-2 py-1" style={{ borderColor: "var(--taomni-divider)" }}>
                      <ShieldX className="h-3.5 w-3.5" style={{ color: "#b22222" }} />
                      {t("agentsPlatform.sandboxDenied")}
                    </span>
                  </div>
                  <div className="mb-2 flex items-center gap-2 text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
                    {t("agentsPlatform.worktreeBranch")}: <span className="font-mono">{selected.branch}</span>
                    <span className="font-mono">+{selected.changes.insertions}/-{selected.changes.deletions}</span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      data-testid="agents-task-approve"
                      className="rounded border px-2 py-1 text-[11px] hover:bg-[var(--taomni-hover)]"
                      style={{ borderColor: "var(--taomni-divider)" }}
                      onClick={() => updateTask(selected.id, { status: selected.status === "waiting" ? "running" : "done" })}
                    >
                      {selected.status === "waiting" ? "✓ Approve & continue" : "Mark done"}
                    </button>
                    <button
                      type="button"
                      data-testid="agents-task-review-diff"
                      className="rounded px-2 py-1 text-[11px] font-medium text-white"
                      style={{ background: "var(--taomni-accent)" }}
                      onClick={reviewInGitPanel}
                    >
                      {t("agentsPlatform.reviewDiff")}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
      {dispatchOpen && (
        <TextInputDialog
          title={t("agentsPlatform.dispatch")}
          label={t("agentsPlatform.dispatch")}
          placeholder="Implement workspace switcher tests"
          onCancel={() => setDispatchOpen(false)}
          onConfirm={(value) => {
            setDispatchOpen(false);
            const task = dispatchTask({
              title: value.trim() || "Agent task",
              workspaceId: activeWorkspace?.id ?? "default-workspace",
              worktreePath: activeWorkspace?.rootFolders[0] ? `${activeWorkspace.rootFolders[0].path}/.taomni/agents/${Date.now().toString(36)}` : "",
            });
            useAgentTasksStore.getState().selectTask(task.id);
          }}
        />
      )}
    </div>
  );
}
