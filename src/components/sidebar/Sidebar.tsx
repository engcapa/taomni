import {
  Search,
  Plus,
  Edit3,
  Copy,
  Trash2,
  RefreshCw,
  Star,
  Wrench,
  Settings,
  GitBranch,
  Server,
  Network,
  FileText,
  MessageSquare,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { SessionTree } from "./SessionTree";
import { ConfirmDialog } from "./ConfirmDialog";
import { useAppStore, type SideTab } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import type { SessionConfig } from "../../lib/ipc";
import { useT, type TranslateFn } from "../../lib/i18n";
import type { AppCommand } from "../menubar/commands";

interface SidebarProps {
  onNewSession?: (groupPath?: string | null) => void;
  onNewSftpSession?: () => void;
  onEditSession?: (session: SessionConfig) => void;
  onConnectSession?: (session: SessionConfig) => void;
  onOpenSettings?: () => void;
  onCommand?: (command: AppCommand) => void;
  gitAction?: {
    label: string;
    title: string;
    disabled?: boolean;
    onOpen: () => void;
  };
  compact?: boolean;
}

export function Sidebar({
  onNewSession,
  onEditSession,
  onConnectSession,
  onOpenSettings,
  onCommand,
  gitAction,
  compact = false,
}: SidebarProps) {
  const {
    activeSideTab,
    setActiveSideTab,
    setSidebarCollapsed,
  } = useAppStore();
  const {
    sessions,
    selectedSessionIds,
    searchQuery,
    setSearchQuery,
    loadSessions,
    removeSessions,
    duplicateSessions,
    moveSessionsToGroup,
  } = useSessionStore();
  const t = useT();
  const selectedSessions = sessions.filter((session) => selectedSessionIds.includes(session.id));
  const selectionCount = selectedSessions.length;
  const [deleteConfirm, setDeleteConfirm] = useState<SessionConfig[] | null>(null);

  const handleDelete = () => {
    if (selectionCount === 0) return;
    setDeleteConfirm(selectedSessions);
  };

  const handleFavorite = () => {
    if (selectionCount === 0) return;
    void moveSessionsToGroup(selectedSessionIds, "User sessions / Favorites");
  };

  const handleSideTabClick = (tab: SideTab) => {
    if (compact) {
      setActiveSideTab(tab);
      setSidebarCollapsed(false);
      return;
    }

    if (activeSideTab === tab) {
      setSidebarCollapsed(true);
      return;
    }

    setActiveSideTab(tab);
  };

  const handleSideTabCollapse = (event: React.MouseEvent) => {
    event.preventDefault();
    setSidebarCollapsed(true);
  };

  const handleSideTabContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
  };

  return (
    <>
    <div data-testid="sidebar" className="h-full flex">
      <div
        className="w-[30px] flex flex-col shrink-0"
        style={{ background: "var(--taomni-tab-inactive)", borderRight: "1px solid var(--taomni-sidebar-border)" }}
      >
        {(["sessions", "tools"] as const).map((tab) => {
          const label = labelForSideTab(t, tab);
          return (
            <div
              key={tab}
              className="taomni-side-tab"
              data-active={activeSideTab === tab && !compact}
              data-testid={`side-tab-${tab}`}
              onClick={() => handleSideTabClick(tab)}
              onDoubleClick={handleSideTabCollapse}
              onContextMenu={handleSideTabContextMenu}
              title={compact ? t("sidebar.showLabel", { label }) : t("sidebar.sideTabHint", { label })}
            >
              {label}
            </div>
          );
        })}
        <div className="flex-1" />
        {gitAction && (
          <button
            data-testid="ribbon-git"
            type="button"
            aria-label={gitAction.title}
            className="group relative mb-1 h-8 w-full inline-flex items-center justify-center border-t hover:bg-[var(--taomni-hover)] text-[var(--taomni-text)] disabled:cursor-not-allowed disabled:opacity-50"
            style={{ borderColor: "var(--taomni-sidebar-border)" }}
            disabled={gitAction.disabled}
            onClick={gitAction.onOpen}
          >
            <GitBranch className="w-[17px] h-[17px]" />
            <span
              role="tooltip"
              className="pointer-events-none absolute left-full bottom-1/2 z-50 ml-2 translate-y-1/2 whitespace-nowrap rounded border px-2 py-1 text-[11px] opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
              style={{
                background: "var(--taomni-card-bg)",
                borderColor: "var(--taomni-card-border)",
                color: "var(--taomni-text)",
              }}
            >
              {gitAction.label}
            </span>
          </button>
        )}
        <button
          data-testid="ribbon-settings"
          type="button"
          aria-label={t("menu.settings")}
          className="group relative mb-2 h-8 w-full inline-flex items-center justify-center border-t hover:bg-[var(--taomni-hover)] text-[var(--taomni-text)]"
          style={{ borderColor: "var(--taomni-sidebar-border)" }}
          onClick={onOpenSettings}
        >
          <Settings className="w-[18px] h-[18px]" />
          <span
            role="tooltip"
            className="pointer-events-none absolute left-full bottom-1/2 z-50 ml-2 translate-y-1/2 whitespace-nowrap rounded border px-2 py-1 text-[11px] opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            style={{
              background: "var(--taomni-card-bg)",
              borderColor: "var(--taomni-card-border)",
              color: "var(--taomni-text)",
            }}
          >
            {t("menu.settings")}
          </span>
        </button>
      </div>
      {compact && null}
      {!compact && (
      <div className="flex-1 flex flex-col min-w-0" style={{ background: "var(--taomni-sidebar-bg)", borderRight: "1px solid var(--taomni-sidebar-border)" }}>
        {activeSideTab === "sessions" ? (
          <>
            <div className="h-7 flex items-center gap-1 px-1.5 border-b shrink-0" style={{ borderColor: "var(--taomni-divider)" }}>
              <IconBtn testId="session-new" title={t("sidebar.newSessionTitle")} icon={<Plus className="w-3.5 h-3.5" />} onClick={() => onNewSession?.()} />
              <IconBtn testId="session-edit" title={t("sidebar.editTitle")} icon={<Edit3 className="w-3.5 h-3.5" />} onClick={() => selectionCount === 1 && onEditSession?.(selectedSessions[0])} disabled={selectionCount !== 1} />
              <IconBtn testId="session-duplicate" title={t("sidebar.duplicateTitle")} icon={<Copy className="w-3.5 h-3.5" />} onClick={() => selectionCount > 0 && void duplicateSessions(selectedSessionIds)} disabled={selectionCount === 0} />
              <IconBtn testId="session-delete" title={t("sidebar.deleteTitle")} icon={<Trash2 className="w-3.5 h-3.5" />} onClick={handleDelete} disabled={selectionCount === 0} />
              <span className="taomni-divider-v h-4 mx-1" />
              <IconBtn title={t("sidebar.refreshTitle")} icon={<RefreshCw className="w-3.5 h-3.5" />} onClick={() => void loadSessions()} />
              <IconBtn title={t("sidebar.favoriteTitle")} icon={<Star className="w-3.5 h-3.5" />} onClick={handleFavorite} disabled={selectionCount === 0} />
              <div className="flex-1" />
              <div className="relative">
                <Search className="w-3 h-3 absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
                <input
                  data-testid="session-search"
                  aria-label={t("sidebar.searchSessions")}
                  className="taomni-input pl-6 w-[140px]"
                  style={{ paddingLeft: "24px" }}
                  placeholder={t("sidebar.searchPlaceholder")}
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
              </div>
            </div>
            <SessionTree onNewSession={onNewSession} onConnectSession={onConnectSession} onEditSession={onEditSession} />
          </>
        ) : (
          <ToolsPanel onCommand={onCommand} />
        )}
      </div>
      )}
    </div>
    {deleteConfirm && (
      <ConfirmDialog
        title={t("sidebar.confirmDeleteSessionTitle")}
        message={
          deleteConfirm.length === 1
            ? t("sidebar.confirmDeleteSession", { name: deleteConfirm[0].name })
            : t("sidebar.confirmDeleteSessions", { count: deleteConfirm.length })
        }
        confirmLabel={t("common.delete")}
        danger
        onCancel={() => setDeleteConfirm(null)}
        onConfirm={() => {
          const ids = deleteConfirm.map((session) => session.id);
          setDeleteConfirm(null);
          void removeSessions(ids);
        }}
      />
    )}
    </>
  );
}

/** Tool entries mirror the main menu Tools items (without packages/macros). */
function ToolsPanel({ onCommand }: { onCommand?: (command: AppCommand) => void }) {
  const t = useT();
  const items: Array<{
    id: AppCommand;
    label: string;
    icon: ReactNode;
    testId: string;
  }> = [
    {
      id: "servers",
      label: t("servers.dialogTitle"),
      icon: <Server className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-servers",
    },
    {
      id: "tunneling",
      label: t("menu.tunneling"),
      icon: <Network className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-tunneling",
    },
    {
      id: "git",
      label: t("menu.gitRepository"),
      icon: <GitBranch className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-git",
    },
    {
      id: "code-workspace",
      label: t("menu.codeWorkspace"),
      icon: <FileText className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-code-workspace",
    },
    {
      id: "lan-chat",
      label: t("tabs.lanChat"),
      icon: <MessageSquare className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-lan-chat",
    },
    {
      id: "tools",
      label: t("menu.networkTools"),
      icon: <Wrench className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-network-tools",
    },
  ];

  return (
    <div data-testid="sidebar-tools-panel" className="flex-1 flex flex-col min-h-0">
      <div
        className="h-7 flex items-center gap-1.5 px-2 border-b shrink-0 font-semibold text-[var(--taomni-text)]"
        style={{ borderColor: "var(--taomni-divider)", fontSize: "var(--taomni-ui-font-size)" }}
      >
        <Wrench className="w-3.5 h-3.5" />
        {t("sidebar.utilityToolsTitle")}
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            data-testid={item.testId}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)]"
            style={{ fontSize: "var(--taomni-ui-font-size)" }}
            onClick={() => onCommand?.(item.id)}
          >
            <span className="text-[var(--taomni-text-muted)]">{item.icon}</span>
            <span className="truncate">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function IconBtn({
  icon,
  title,
  testId,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  title: string;
  testId?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      data-testid={testId}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="w-6 h-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] disabled:opacity-40 disabled:cursor-default"
      type="button"
    >
      {icon}
    </button>
  );
}

function labelForSideTab(t: TranslateFn, tab: SideTab): string {
  switch (tab) {
    case "sessions":
      return t("sidebar.sideTabSessions");
    case "tools":
      return t("sidebar.sideTabTools");
  }
}
