import {
  Search,
  Plus,
  Edit3,
  Copy,
  Trash2,
  RefreshCw,
  Star,
  Clock,
  Terminal as TerminalIcon,
  Wrench,
  Bot,
  FolderTree,
} from "lucide-react";
import { useState } from "react";
import { SessionTree } from "./SessionTree";
import { ConfirmDialog } from "./ConfirmDialog";
import { useAppStore, type SideTab } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import type { SessionConfig } from "../../lib/ipc";
import { sessionTypeLabel } from "../../lib/terminalProfile";
import { useT, type TranslateFn } from "../../lib/i18n";

interface SidebarProps {
  onNewSession?: (groupPath?: string | null) => void;
  onNewSftpSession?: () => void;
  onEditSession?: (session: SessionConfig) => void;
  onConnectSession?: (session: SessionConfig) => void;
  compact?: boolean;
}

export function Sidebar({ onNewSession, onNewSftpSession, onEditSession, onConnectSession, compact = false }: SidebarProps) {
  const {
    activeSideTab,
    setActiveSideTab,
    setSidebarCollapsed,
  } = useAppStore();
  const {
    sessions,
    selectedSessionId,
    searchQuery,
    setSearchQuery,
    loadSessions,
    removeSession,
    duplicateSession,
    updateSession,
  } = useSessionStore();
  const t = useT();
  const selectedSession = sessions.find((session) => session.id === selectedSessionId);
  const recentSessions = sessions
    .filter((session) => session.last_connected_at)
    .sort((a, b) => (b.last_connected_at ?? 0) - (a.last_connected_at ?? 0))
    .slice(0, 6);

  const [deleteConfirm, setDeleteConfirm] = useState<SessionConfig | null>(null);

  const handleDelete = () => {
    if (!selectedSession) return;
    setDeleteConfirm(selectedSession);
  };

  const handleFavorite = () => {
    if (!selectedSession) return;
    void updateSession({
      ...selectedSession,
      group_path: "User sessions / Favorites",
      updated_at: Math.floor(Date.now() / 1000),
    });
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
        className="w-[26px] flex flex-col shrink-0"
        style={{ background: "var(--taomni-tab-inactive)", borderRight: "1px solid var(--taomni-sidebar-border)" }}
      >
        {(["sessions", "tools", "macros"] as const).map((tab) => {
          const label = labelForSideTab(t, tab);
          return (
            <div
              key={tab}
              className="taomni-side-tab"
              data-active={activeSideTab === tab && !compact}
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
      </div>
      {compact && null}
      {!compact && (
      <div className="flex-1 flex flex-col min-w-0" style={{ background: "var(--taomni-sidebar-bg)", borderRight: "1px solid var(--taomni-sidebar-border)" }}>
        <div className="h-7 flex items-center gap-1 px-1.5 border-b shrink-0" style={{ borderColor: "var(--taomni-divider)" }}>
          <IconBtn testId="session-new" title={t("sidebar.newSessionTitle")} icon={<Plus className="w-3.5 h-3.5" />} onClick={() => onNewSession?.()} />
          <IconBtn testId="session-edit" title={t("sidebar.editTitle")} icon={<Edit3 className="w-3.5 h-3.5" />} onClick={() => selectedSession && onEditSession?.(selectedSession)} disabled={!selectedSession} />
          <IconBtn testId="session-duplicate" title={t("sidebar.duplicateTitle")} icon={<Copy className="w-3.5 h-3.5" />} onClick={() => selectedSession && void duplicateSession(selectedSession.id)} disabled={!selectedSession} />
          <IconBtn testId="session-delete" title={t("sidebar.deleteTitle")} icon={<Trash2 className="w-3.5 h-3.5" />} onClick={handleDelete} disabled={!selectedSession} />
          <span className="taomni-divider-v h-4 mx-1" />
          <IconBtn title={t("sidebar.refreshTitle")} icon={<RefreshCw className="w-3.5 h-3.5" />} onClick={() => void loadSessions()} />
          <IconBtn title={t("sidebar.favoriteTitle")} icon={<Star className="w-3.5 h-3.5" />} onClick={handleFavorite} disabled={!selectedSession} />
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
        {activeSideTab === "sessions" ? (
          <SessionTree onNewSession={onNewSession} onConnectSession={onConnectSession} onEditSession={onEditSession} />
        ) : (
          <UtilityPanel tab={activeSideTab} />
        )}
        <div className="h-[160px] border-t flex flex-col shrink-0" style={{ borderColor: "var(--taomni-sidebar-border)", background: "var(--taomni-panel-bg)" }}>
          <div className="h-6 flex items-center px-2 font-semibold border-b" style={{ fontSize: "calc(var(--taomni-ui-font-size) - 1px)", borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}>
            <Clock className="w-3.5 h-3.5 mr-1 text-[var(--taomni-text-muted)]" />
            {t("sidebar.recentConnections")}
            <div className="ml-auto flex items-center gap-1">
              {onNewSftpSession && (
                <IconBtn
                  title={t("sidebar.sftpBrowserTitle")}
                  icon={<FolderTree className="w-3 h-3" />}
                  onClick={() => onNewSftpSession()}
                />
              )}
              <IconBtn title={t("sidebar.refreshTitle")} icon={<RefreshCw className="w-3 h-3" />} onClick={() => void loadSessions()} />
            </div>
          </div>
          <div className="flex-1 taomni-scroll-y py-1" style={{ fontSize: "var(--taomni-ui-font-size)" }}>
            {recentSessions.length === 0 ? (
              <div className="px-2 py-2 text-[var(--taomni-text-muted)]" style={{ fontSize: "calc(var(--taomni-ui-font-size) - 1px)" }}>
                {t("sidebar.noRecent")}
                {onNewSftpSession && (
                  <button
                    type="button"
                    className="block mt-1 underline text-[var(--taomni-accent)]"
                    onClick={() => onNewSftpSession()}
                  >
                    {t("sidebar.sftpBrowserCta")}
                  </button>
                )}
              </div>
            ) : (
              recentSessions.map((session) => {
                const typeLabel = sessionTypeLabel(session.session_type, session.options_json);
                return (
                <button
                  key={session.id}
                  className="taomni-tree-row w-full text-left"
                  onClick={() => onConnectSession?.(session)}
                  title={`${session.name} (${typeLabel})`}
                  type="button"
                >
                  <TerminalIcon className="w-3 h-3 text-[var(--taomni-accent)]" />
                  <span className="flex-1 truncate">{session.name}</span>
                  <span className="text-slate-500" style={{ fontSize: "calc(var(--taomni-ui-font-size) - 2px)" }}>{typeLabel}</span>
                </button>
                );
              })
            )}
          </div>
        </div>
      </div>
      )}
    </div>
    {deleteConfirm && (
      <ConfirmDialog
        title={t("sidebar.confirmDeleteSessionTitle")}
        message={t("sidebar.confirmDeleteSession", { name: deleteConfirm.name })}
        confirmLabel={t("common.delete")}
        danger
        onCancel={() => setDeleteConfirm(null)}
        onConfirm={() => {
          const id = deleteConfirm.id;
          setDeleteConfirm(null);
          void removeSession(id);
        }}
      />
    )}
    </>
  );
}

function UtilityPanel({ tab }: { tab: Exclude<SideTab, "sessions"> }) {
  const t = useT();
  const meta = {
    tools: { icon: <Wrench className="w-4 h-4" />, title: t("sidebar.utilityToolsTitle"), body: t("sidebar.utilityToolsBody") },
    macros: { icon: <Bot className="w-4 h-4" />, title: t("sidebar.utilityMacrosTitle"), body: t("sidebar.utilityMacrosBody") },
  }[tab];

  return (
    <div className="flex-1 p-3 text-[var(--taomni-text-muted)]" style={{ fontSize: "var(--taomni-ui-font-size)" }}>
      <div className="flex items-center gap-2 font-semibold text-[var(--taomni-text)] mb-2" style={{ fontSize: "var(--taomni-ui-font-size)" }}>
        {meta.icon}
        {meta.title}
      </div>
      <div>{meta.body}</div>
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
  icon: React.ReactNode;
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
    case "macros":
      return t("sidebar.sideTabMacros");
  }
}
