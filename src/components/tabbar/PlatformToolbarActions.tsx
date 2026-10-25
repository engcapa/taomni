import { Columns2, Grid2X2, LayoutGrid, PanelBottom, PanelRight, Radio, Search, Square } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import { useTabOverviewStore } from "../../stores/tabOverviewStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { useWorkspaceUiStore, type WorkspaceCanvasLayout } from "../../stores/workspaceUiStore";
import { TitleBarTrayControls } from "../window/TitleBarTrayControls";

export function PlatformToolbarActions({ children, onOpenSearch }: { children?: ReactNode; onOpenSearch?: () => void }) {
  const t = useT();
  const mode = useAppStore((s) => s.activeSideTab);
  const rightCollapsed = useAppStore((s) => s.rightSidebarCollapsed);
  const split = useAppStore((s) => s.terminalSplitActive);
  const splitLayout = useAppStore((s) => s.terminalSplitLayout);
  const broadcast = useAppStore((s) => s.multiExecActive);
  const workspace = useWorkspacePlatformStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId));
  const layouts = useWorkspaceUiStore((s) => s.canvasLayouts);
  const overviewOpen = useTabOverviewStore((s) => s.open);
  const workspaceMode = mode === "workspaces";
  const sessionMode = mode === "sessions";
  const currentLayout = workspaceMode ? layouts[workspace?.id ?? ""] ?? "single" : !split ? "single" : splitLayout === "grid" ? "grid" : "split";
  const setLayout = (layout: WorkspaceCanvasLayout) => {
    if (workspaceMode && workspace) {
      useWorkspaceUiStore.getState().setCanvasLayout(workspace.id, layout);
    } else {
      const app = useAppStore.getState();
      if (layout !== "single") app.setTerminalSplitLayout(layout === "grid" ? "grid" : "horizontal");
      app.setTerminalSplitActive(layout !== "single");
    }
  };
  return (
    <div data-testid="platform-toolbar-actions" data-mode={mode} className="taomni-platform-toolbar-actions">
      {mode === "home" && <>
        <button data-testid="home-toolbar-workspaces" className="taomni-toolbar-pill" onClick={() => useAppStore.getState().setActiveSideTab("workspaces")}>{t("platform.enterWorkspaces")}</button>
        <button data-testid="home-toolbar-sessions" className="taomni-toolbar-pill" data-primary="true" onClick={() => useAppStore.getState().setActiveSideTab("sessions")}>{t("platform.enterSessions")}</button>
      </>}
      {mode === "tools" && <button data-testid="tools-toolbar-workspaces" className="taomni-toolbar-pill" onClick={() => useAppStore.getState().setActiveSideTab("workspaces")}>{t("platform.returnToWorkspace")}</button>}
      {sessionMode && <ToolbarButton testId="tab-multiexec-toggle" title={t(broadcast ? "titlebar.disableMultiExec" : "titlebar.enableMultiExec")} active={broadcast} onClick={() => useAppStore.getState().toggleMultiExec()}><Radio /></ToolbarButton>}
      {(workspaceMode || sessionMode) && <div data-testid="platform-layout-presets" className="taomni-layout-presets">
        <ToolbarButton testId="platform-layout-single" title={t("platform.singleView")} active={currentLayout === "single"} onClick={() => setLayout("single")}><Square /></ToolbarButton>
        <ToolbarButton testId={sessionMode ? "tab-split-view" : "workspace-layout-split"} title={t("platform.splitView")} active={currentLayout === "split"} onClick={() => setLayout(currentLayout === "split" ? "single" : "split")}><Columns2 /></ToolbarButton>
        <ToolbarButton testId="platform-layout-grid" title={t("platform.gridView")} active={currentLayout === "grid"} onClick={() => setLayout("grid")}><Grid2X2 /></ToolbarButton>
      </div>}
      {workspaceMode && workspace && <ToolbarButton testId="workspace-toolbar-bottom-dock" title={t("platform.toggleBottomDock")} active={workspace.bottomDock.open} onClick={() => useWorkspacePlatformStore.getState().setBottomDockOpen(workspace.id, !workspace.bottomDock.open)}><PanelBottom /></ToolbarButton>}
      {children}
      <span className="taomni-toolbar-divider" />
      <ToolbarButton testId="global-search-trigger" title={`${t("platform.globalSearch")} (Ctrl/Cmd+K)`} onClick={onOpenSearch}><Search /></ToolbarButton>
      <ToolbarButton testId="tab-overview-trigger" title={`${t("platform.tabOverview")} (Ctrl/Cmd+Shift+E)`} active={overviewOpen} onClick={() => useTabOverviewStore.getState().toggle()}><LayoutGrid /></ToolbarButton>
      {mode !== "home" && <ToolbarButton testId="toggle-right-sidebar" title={t("platform.toggleRightSidebar")} active={!rightCollapsed} onClick={() => useAppStore.getState().toggleRightSidebar()}><PanelRight /></ToolbarButton>}
      <TitleBarTrayControls compact layoutActions={false} />
    </div>
  );
}

function ToolbarButton({ children, title, testId, active, onClick }: { children: ReactNode; title: string; testId: string; active?: boolean; onClick?: () => void }) {
  return <button type="button" data-testid={testId} title={title} aria-label={title} aria-pressed={active} data-active={active || undefined} className="taomni-platform-toolbar-button" onClick={onClick}>{children}</button>;
}
