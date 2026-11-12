import { Bookmark, Bug, Database, ListTodo, Search, Server, Terminal, TriangleAlert, X } from "lucide-react";
import { useCallback } from "react";
import { useT } from "../../lib/i18n";
import { useWorkspaceEditorHostStore } from "../../stores/workspaceEditorHostStore";
import { useWorkspacePlatformStore, type PlatformWorkspace, type WorkspaceBottomTool } from "../../stores/workspacePlatformStore";

const DOCK_TOOLS: WorkspaceBottomTool[] = ["terminal", "problems", "run", "find", "bookmarks", "todo", "services", "database"];
const DOCK_ICONS = { terminal: Terminal, problems: TriangleAlert, run: Bug, find: Search, bookmarks: Bookmark, todo: ListTodo, services: Server, database: Database };

/** Workspace presentation only: the retained editor runtime owns terminal effects. */
export function WorkspaceBottomDock({ workspace }: { workspace: PlatformWorkspace }) {
  const t = useT();
  const dock = workspace.bottomDock;
  const setTerminalHost = useWorkspaceEditorHostStore((state) => state.setTerminalHost);
  const hostRef = useCallback((element: HTMLDivElement | null) => {
    setTerminalHost(workspace.id, element);
  }, [setTerminalHost, workspace.id]);
  return <div data-testid="workspace-bottom-dock" className="flex shrink-0 flex-col border-t"
    style={{ display: dock.open ? undefined : "none", borderColor: "var(--taomni-divider)", height: dock.heightPx, background: "var(--taomni-panel-bg)" }}>
    <div className="flex h-7 shrink-0 items-center gap-1 border-b px-2" style={{ borderColor: "var(--taomni-divider)" }}>
      {DOCK_TOOLS.map((tool) => {
        const Icon = DOCK_ICONS[tool];
        const label = t(`platform.${tool === "run" ? "runDebug" : tool}` as never) || tool;
        return <button key={tool} type="button" data-testid={`workspace-dock-tab-${tool}`}
          title={label} aria-label={label} aria-pressed={dock.activeTool === tool}
          className="flex h-6 w-7 shrink-0 items-center justify-center rounded"
          style={{ background: dock.activeTool === tool ? "var(--taomni-selected)" : "transparent", color: dock.activeTool === tool ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }}
          onClick={() => useWorkspacePlatformStore.getState().setBottomDockTool(workspace.id, tool)}>
          <Icon className="h-3.5 w-3.5" />
        </button>;
      })}
      <div className="flex-1" />
      <button type="button" data-testid="workspace-dock-close" aria-label={t("common.close")}
        className="rounded p-1 hover:bg-[var(--taomni-hover)]"
        onClick={() => useWorkspacePlatformStore.getState().setBottomDockOpen(workspace.id, false)}>
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
    <div className="min-h-0 flex-1 overflow-auto" data-testid="workspace-dock-content" data-tool={dock.activeTool}>
      <div ref={hostRef} className="h-full min-h-0" style={{ display: dock.activeTool === "terminal" ? undefined : "none" }} />
      {dock.activeTool !== "terminal" && <div className="p-3 text-[11.5px]" style={{ color: "var(--taomni-text-muted)" }}>
        {t("platform.emptyWorkspaceHint")}
      </div>}
    </div>
  </div>;
}
