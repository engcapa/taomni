import { type ReactNode } from "react";
import { X } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useShellLayoutStore } from "../../stores/shellLayoutStore";
import { useAppStore } from "../../stores/appStore";
import { tabLane } from "../../lib/shell/tabPresentation";
import { SurfaceSlot } from "./SurfaceSlot";
import type { RecentWorkspace } from "../../types";
import { getPanelActions } from "../../lib/shell/panelActions";
import type { RecentWorkspaceLaunch } from "../../hooks/useRecentWorkspaceLaunch";

export function ShellNavigator({ children, onOpenWorkspace, workspaceLaunches, onRelocateWorkspace }: { children: ReactNode; onOpenWorkspace(workspace: RecentWorkspace): void; workspaceLaunches?: Record<string, RecentWorkspaceLaunch>; onRelocateWorkspace?(workspace: RecentWorkspace): void }) {
  const shell = useShellLayoutStore(), t = useT(), app = useAppStore();
  const page = shell.navigatorPage, setPage = shell.setNavigatorPage;
  const active = app.tabs.find((tab) => tab.id === app.activeTabId), lane = shell.laneSelection ?? (active ? tabLane(active, shell.laneOverrides[active.id]) : "home");
  const workspaces = shell.layout.navigator.lastArea === "workspaces";
  return <aside data-testid="shell-navigator" data-area={shell.layout.navigator.lastArea} data-page={page} className="h-full min-h-0 flex flex-col border-r border-[var(--taomni-divider)]" style={{ background: "var(--taomni-sidebar-bg)", color: "var(--taomni-text)" }}>
    <header className="h-10 shrink-0 flex items-center px-2 gap-2"><strong className="flex-1 text-xs">{t(workspaces ? "shell.workspaces" : "shell.sessions")}</strong><button aria-label={t("common.close")} data-testid="shell-navigator-hide" onClick={() => shell.setNavigatorCollapsed(lane, true)}><X className="w-4 h-4" /></button></header>
    {workspaces && <div className="flex gap-2 shrink-0 px-2 h-8 text-xs" role="tablist">{(["recent", "project", "tools"] as const).map((p) => <button key={p} role="tab" data-testid="shell-navigator-page" data-page={p} aria-selected={page === p} onClick={() => { setPage(p); if (p === "tools") useAppStore.setState({ activeSideTab: "tools" }); if (p === "project" && active?.codeWorkspace?.workspaceInstanceId) void getPanelActions(`workspace:${active.codeWorkspace.workspaceInstanceId}:project`)?.focus?.(); }}>{t(`shell.${p}`)}</button>)}</div>}
    <div className="flex-1 min-h-0" style={{ display: !workspaces || page === "tools" ? "block" : "none" }} inert={workspaces && page !== "tools"}>{children}</div>
    <div className="flex-1 min-h-0 overflow-auto p-2" style={{ display: workspaces && page === "recent" ? "block" : "none" }} inert={!workspaces || page !== "recent"}>
      {app.recentWorkspaces.map((w) => <div key={w.id} data-workspace-id={w.id}>
        <button data-testid="shell-recent-workspace" disabled={workspaceLaunches?.[w.id]?.state === "opening"} className="block w-full min-w-0 text-left p-2 rounded hover:bg-[var(--taomni-hover)]" onClick={() => onOpenWorkspace(w)}><span className="text-xs block truncate">{w.name}</span><span className="text-[10px] opacity-60 block truncate">{w.roots.map((r) => r.path).join(", ")}</span></button>
        {workspaceLaunches?.[w.id]?.state === "failed" && <div role="alert" data-testid="shell-navigator-workspace-error" className="text-xs p-2"><p>{workspaceLaunches[w.id].error}</p><button data-testid="shell-navigator-workspace-relocate" onClick={() => onRelocateWorkspace?.(w)}>{t("shell.relocateWorkspace")}</button></div>}
      </div>)}
    </div>
    <div className="flex-1 min-h-0" style={{ display: workspaces && page === "project" ? "block" : "none" }} inert={!workspaces || page !== "project"}>
      <SurfaceSlot id="navigator-project" />
    </div>
  </aside>;
}
