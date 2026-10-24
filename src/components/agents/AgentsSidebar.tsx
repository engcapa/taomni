import { Bot } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useAgentTasksStore } from "./agentTasksStore";

/**
 * Agents-mode sidebar (v6.1 TASK-09): the parallel coding-agent task list.
 * Each row links to the orchestrator view's selected task.
 */
export function AgentsSidebar() {
  const t = useT();
  const tasks = useAgentTasksStore((s) => s.tasks);
  const selectedId = useAgentTasksStore((s) => s.selectedTaskId);
  const selectTask = useAgentTasksStore((s) => s.selectTask);
  return (
    <div data-testid="agents-sidebar" className="flex min-h-0 flex-1 flex-col" style={{ background: "var(--taomni-sidebar-bg)" }}>
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b px-2 text-[12px] font-semibold" style={{ borderColor: "var(--taomni-divider)", color: "var(--taomni-text)" }}>
        <Bot className="h-3.5 w-3.5" />
        {t("agentsPlatform.title")}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {tasks.length === 0 ? (
          <div className="px-2 py-1 text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>{t("agentsPlatform.empty")}</div>
        ) : (
          tasks.map((task) => (
            <button
              key={task.id}
              type="button"
              data-testid={`agents-sidebar-task-${task.id}`}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-[var(--taomni-hover)]"
              style={{
                color: "var(--taomni-text)",
                background: task.id === selectedId ? "var(--taomni-selected)" : undefined,
              }}
              onClick={() => selectTask(task.id)}
            >
              <Bot className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{task.title}</span>
              <span className="shrink-0 rounded px-1 text-[9px] font-semibold uppercase" style={{ background: "var(--taomni-hover)", color: "var(--taomni-text-muted)" }}>
                {task.status}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
