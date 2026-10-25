import { FilePlus2, FolderPlus, MonitorSmartphone, Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { WorkspaceTabContextMenu } from "./WorkspaceTabContextMenu";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/sessionStore";
import { useAppStore } from "../../stores/appStore";
import { useWorkspaceUiStore } from "../../stores/workspaceUiStore";
import {
  useWorkspacePlatformStore,
  type WorkspaceIsolatedTab,
  type WorkspaceTabKind,
} from "../../stores/workspacePlatformStore";

const KIND_LABEL: Record<WorkspaceTabKind, string> = {
  file: "FILE",
  git: "GIT",
  code: "CODE",
  terminal: "TERM",
  sftp: "SFTP",
  database: "DB",
  rdp: "RDP",
  vnc: "VNC",
  session: "SESS",
};

const KIND_COLOR: Record<WorkspaceTabKind, string> = {
  file: "var(--taomni-text-muted)",
  git: "var(--taomni-accent)",
  code: "var(--taomni-purple, #8b5cf6)",
  terminal: "var(--taomni-success, #10b981)",
  sftp: "var(--taomni-warning, #d97706)",
  database: "var(--taomni-accent)",
  rdp: "#3b82f6",
  vnc: "#ec4899",
  session: "var(--taomni-accent)",
};

/**
 * Workspace tab strip rendered in the shared ControlBar (AC-01/AC-07).
 *
 * Shows the active workspace's own isolated tabs plus the `+` entry that opens
 * files or any global session. Sessions are opened here, never in the Sessions
 * mode tab strip.
 */
export function WorkspaceTabStrip() {
  const t = useT();
  const workspace = useWorkspacePlatformStore((s) => s.workspaces.find((candidate) => candidate.id === s.activeWorkspaceId));
  const setActiveTab = useWorkspacePlatformStore((s) => s.setActiveWorkspaceTab);
  const closeTab = useWorkspacePlatformStore((s) => s.closeWorkspaceTab);
  const openSessionInWorkspace = useWorkspacePlatformStore((s) => s.openSessionInWorkspace);
  const openLocalTerminal = useWorkspacePlatformStore((s) => s.openLocalTerminalInWorkspace);
  const sessions = useSessionStore((s) => s.sessions);
  const setActiveSideTab = useAppStore((s) => s.setActiveSideTab);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const openFsModal = useWorkspaceUiStore((s) => s.openFsModal);
  const openSessionPicker = useWorkspaceUiStore((s) => s.openSessionPicker);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  useEffect(() => { setMenu(null); setTabMenu(null); }, [workspace?.id]);

  if (!workspace) return null;

  const menuItems: MenuItem[] = [
    {
      label: t("platform.newFile"),
      testId: "workspace-plus-new-file",
      icon: <FilePlus2 className="h-3 w-3" />,
      onClick: () => openFsModal({ kind: "file", directory: "" }),
    },
    {
      label: t("platform.newFolder"),
      testId: "workspace-plus-new-folder",
      icon: <FolderPlus className="h-3 w-3" />,
      onClick: () => openFsModal({ kind: "folder", directory: "" }),
    },
    {
      label: t("platform.addRootFolder"),
      testId: "workspace-plus-add-folder",
      icon: <FolderPlus className="h-3 w-3" />,
      onClick: () => openFsModal({ kind: "root", directory: "" }),
    },
    { label: "", separator: true, onClick: () => undefined },
    {
      label: t("platform.newLocalTerminal"),
      testId: "workspace-plus-local-terminal",
      icon: <MonitorSmartphone className="h-3 w-3" />,
      onClick: () => openLocalTerminal(workspace.id),
    },
    {
      label: t("platform.openAnySession"),
      testId: "workspace-plus-open-session",
      shortcut: "Ctrl+Alt+O",
      icon: <Search className="h-3 w-3" />,
      onClick: () => openSessionPicker(workspace.id),
    },
    { label: "", separator: true, onClick: () => undefined },
    ...workspace.pinnedSessionIds
      .map((sessionId) => sessions.find((session) => session.id === sessionId))
      .filter((session): session is NonNullable<typeof session> => Boolean(session))
      .map((session) => ({
        label: `★ ${session.name || session.host} (${session.session_type})`,
        testId: `workspace-plus-pinned-${session.id}`,
        onClick: () => openSessionInWorkspace(workspace.id, session),
      })),
    {
      label: t("platform.workspaceSessions"),
      testId: "workspace-plus-sessions-lens",
      onClick: () => {
        useWorkspacePlatformStore.getState().setActiveLeftToolWindow(workspace.id, "sessions");
        setActiveSideTab("workspaces");
        setSidebarCollapsed(false);
      },
    },
  ];

  const tabButton = (tab: WorkspaceIsolatedTab) => (
    <div
      key={tab.id}
      role="tab"
      tabIndex={0}
      aria-selected={tab.id === workspace.activeTabId}
      data-testid="workspace-tab"
      data-tab-title={tab.title}
      data-session-id={tab.sessionId}
      data-tab-id={tab.id}
      data-tab-kind={tab.kind}
      data-active={tab.id === workspace.activeTabId || undefined}
      title={tab.title}
      className="taomni-workspace-tab group flex max-w-[185px] shrink-0 items-center gap-1 px-2 text-[12px]"
      onClick={() => setActiveTab(workspace.id, tab.id)}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu(null);
        setTabMenu({ tabId: tab.id, x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") setActiveTab(workspace.id, tab.id);
      }}
      onAuxClick={(event) => {
        if (event.button === 1 && tab.closable) closeTab(workspace.id, tab.id);
      }}
    >
      <span className="shrink-0 rounded px-0.5 text-[8.5px] font-bold" style={{ color: KIND_COLOR[tab.kind], border: `1px solid ${KIND_COLOR[tab.kind]}` }}>
        {KIND_LABEL[tab.kind]}
      </span>
      <span className="truncate">{tab.title}</span>
      {tab.closable && (
        <button
          type="button"
          data-testid="workspace-tab-close"
          aria-label={t("platform.closeTab")}
          className="ml-0.5 shrink-0 rounded px-0.5 text-[11px] opacity-50 hover:opacity-100"
          onClick={(event) => {
            event.stopPropagation();
            closeTab(workspace.id, tab.id);
          }}
        >
          ✕
        </button>
      )}
    </div>
  );

  return (
    <div data-testid="workspace-tab-strip" className="taomni-workspace-tab-strip flex h-full min-w-0 flex-1 items-end gap-0.5 overflow-x-auto">
      {workspace.openTabs.map(tabButton)}
      {tabMenu && workspace.openTabs.find((tab) => tab.id === tabMenu.tabId) && <WorkspaceTabContextMenu
        key={`${workspace.id}:${tabMenu.tabId}`}
        workspace={workspace}
        tab={workspace.openTabs.find((tab) => tab.id === tabMenu.tabId)!}
        x={tabMenu.x}
        y={tabMenu.y}
        onClose={() => setTabMenu(null)}
      />}
      <button
        type="button"
        data-testid="workspace-open-session-plus"
        aria-label={t("platform.openSessionPlus")}
        aria-haspopup="menu"
        title={t("platform.openSessionPlus")}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
        onClick={(event) => {
          setTabMenu(null);
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.left, y: rect.bottom + 2 });
        }}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      {menu && (
        <ContextMenu
          testId="workspace-open-session-menu"
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={menuItems}
        />
      )}
    </div>
  );
}
