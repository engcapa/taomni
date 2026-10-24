import { Bot, GitBranch, Plus } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useAgentsStore } from "../../stores/agentsStore";

export interface AgentsSidebarProps {
  onDispatchTask: () => void;
}

/** Agents mode left panel: worktree task queue (AC-02 / TASK-09). */
export function AgentsSidebar({ onDispatchTask }: AgentsSidebarProps) {
  const t = useT();
  const tasks = useAgentsStore((s) => s.tasks);
  const selectedTaskId = useAgentsStore((s) => s.selectedTaskId);
  const selectTask = useAgentsStore((s) => s.selectTask);

  const statusLabel = (status: string) => {
    if (status === "waiting") return t("platform.agentWaiting");
    if (status === "done") return t("platform.agentDone");
    if (status === "cancelled") return t("common.cancel");
    return t("platform.agentRunning");
  };

  return (
    <div data-testid="agents-sidebar-panel" className="flex min-h-0 flex-1 flex-col">
      <div
        className="h-7 flex items-center justify-between gap-1 px-2 border-b shrink-0 font-semibold text-[var(--taomni-text)]"
        style={{ borderColor: "var(--taomni-divider)", fontSize: "var(--taomni-ui-font-size)" }}
      >
        <span className="inline-flex items-center gap-1.5">
          <Bot className="w-3.5 h-3.5" />
          {t("platform.agentsTitle")}
        </span>
        <button
          type="button"
          data-testid="agents-dispatch-task"
          className="taomni-btn h-6 px-1.5 inline-flex items-center gap-1"
          onClick={onDispatchTask}
        >
          <Plus className="w-3 h-3" />
          {t("platform.dispatchTask")}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5" data-testid="agents-task-list">
        {tasks.length === 0 && (
          <div className="px-1 py-2 text-[11px] text-[var(--taomni-text-muted)]">{t("platform.agentsSubtitle")}</div>
        )}
        {tasks.map((task) => (
          <button
            key={task.id}
            type="button"
            data-testid="agents-task-row"
            data-task-id={task.id}
            aria-pressed={selectedTaskId === task.id || (!selectedTaskId && tasks[0]?.id === task.id)}
            className="mb-1 w-full rounded border px-2 py-1.5 text-left hover:bg-[var(--taomni-hover)] data-[selected=true]:bg-[var(--taomni-selected)]"
            style={{
              borderColor: "var(--taomni-card-border)",
              background: selectedTaskId === task.id ? "var(--taomni-selected)" : "var(--taomni-card-bg)",
            }}
            onClick={() => selectTask(task.id)}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="truncate text-[var(--taomni-text)]" style={{ fontSize: "var(--taomni-ui-font-size)" }}>{task.name}</span>
              <span className="shrink-0 rounded px-1 text-[9.5px] text-[var(--taomni-text-muted)]" style={{ border: "1px solid var(--taomni-divider)" }}>
                {statusLabel(task.status)}
              </span>
            </div>
            <div className="mt-0.5 line-clamp-2 text-[10.5px] text-[var(--taomni-text-muted)]">{task.task}</div>
            <div className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-[var(--taomni-text-muted)]">
              <GitBranch className="w-3 h-3" />
              <span className="truncate">{task.branch}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
