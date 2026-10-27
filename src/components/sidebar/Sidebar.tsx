import { useEffect } from "react";
import { useAppStore } from "../../stores/appStore";
import { useMainRailHostStore } from "../../stores/mainRailHostStore";
import { useWorkspaceUiStore } from "../../stores/workspaceUiStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import type { SessionConfig } from "../../lib/ipc";
import type { AppCommand } from "../menubar/commands";
import { PrimaryNavigationRail } from "./PrimaryNavigationRail";
import { SessionsSidebarPanel } from "./SessionsSidebarPanel";
import { ToolsPanel } from "./ToolsPanel";
import { HomeSidebar } from "./HomeSidebar";
import { AgentsSidebar } from "./AgentsSidebar";
import { WorkspaceSidebar } from "../workspace/WorkspaceSidebar";

interface SidebarProps {
  onNewSession?: (groupPath?: string | null) => void;
  onNewSftpSession?: () => void;
  onEditSession?: (session: SessionConfig) => void;
  onConnectSession?: (session: SessionConfig) => void;
  onOpenSettings?: () => void;
  onCommand?: (command: AppCommand) => void;
  onStartLocalTerminal?: () => void;
  compact?: boolean;
  railOnly?: boolean;
  panelOnly?: boolean;
}

/**
 * Window sidebar shell (v6.1 AC-02..AC-05).
 *
 * One primary rail is always present; the panel to its right is the active
 * mode's content: Home overview, Workspaces project tree, Sessions tree,
 * Agents worktree queue or the standalone Tools list.
 */
export function Sidebar({
  onNewSession,
  onEditSession,
  onConnectSession,
  onOpenSettings,
  onCommand,
  onStartLocalTerminal,
  compact = false,
  railOnly = false,
  panelOnly = false,
}: SidebarProps) {
  const activeSideTab = useAppStore((state) => state.activeSideTab);
  const setRailHost = useMainRailHostStore((state) => state.setHost);
  const activeWorkspaceId = useWorkspacePlatformStore((state) => state.activeWorkspaceId);
  const openSessionPicker = useWorkspaceUiStore((state) => state.openSessionPicker);
  const setActiveLeftToolWindow = useWorkspacePlatformStore((state) => state.setActiveLeftToolWindow);

  // Workspaces mode owns the rail: the legacy Code Workspace tool window rail
  // merges into it so the canvas never grows a second stripe (AC-03).
  useEffect(() => {
    if (panelOnly) return;
    return () => setRailHost(null);
  }, [panelOnly, setRailHost]);

  const panel = (() => {
    if (compact || railOnly) return null;
    switch (activeSideTab) {
      case "home":
        return (
          <HomeSidebar
            onStartLocalTerminal={() => onStartLocalTerminal?.()}
            onNewSession={() => onNewSession?.()}
            onConnectSession={onConnectSession}
          />
        );
      case "workspaces":
        return <WorkspaceSidebar onOpenSessionPicker={() => openSessionPicker(activeWorkspaceId)} />;
      case "agents":
        return <AgentsSidebar />;
      case "tools":
        return <ToolsPanel onCommand={onCommand} />;
      case "sessions":
      default:
        return (
          <SessionsSidebarPanel
            onNewSession={onNewSession}
            onEditSession={onEditSession}
            onConnectSession={onConnectSession}
          />
        );
    }
  })();

  return (
    <div data-testid={panelOnly ? undefined : "sidebar"} className="h-full flex">
      {!panelOnly && <PrimaryNavigationRail
        compact={compact}
        railHostRef={setRailHost}
        onOpenSettings={onOpenSettings}
        onOpenWorkspaceSessionPicker={() => {
          setActiveLeftToolWindow(activeWorkspaceId, "sessions");
          useAppStore.getState().setActiveSideTab("workspaces");
          openSessionPicker(activeWorkspaceId);
        }}
      />}
      {!compact && !railOnly && (
        <div
          data-testid="sidebar-mode-panel"
          className="flex min-w-0 flex-1 flex-col"
          style={{ background: "var(--taomni-panel-bg)" }}
        >
          {panel}
        </div>
      )}
    </div>
  );
}
