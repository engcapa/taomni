import { Copy, Edit3, Plus, RefreshCw, Search, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import { SessionTree } from "./SessionTree";
import { ConfirmDialog } from "./ConfirmDialog";
import { useSessionStore } from "../../stores/sessionStore";
import type { SessionConfig } from "../../lib/ipc";
import { useT } from "../../lib/i18n";

export interface SessionsSidebarPanelProps {
  onNewSession?: (groupPath?: string | null) => void;
  onEditSession?: (session: SessionConfig) => void;
  onConnectSession?: (session: SessionConfig) => void;
}

/**
 * Sessions mode left panel: the unchanged 7-button toolbar, protocol filter,
 * search and full SessionTree (AC-09 / regression TC-013, TC-036, TC-053).
 */
export function SessionsSidebarPanel({
  onNewSession,
  onEditSession,
  onConnectSession,
}: SessionsSidebarPanelProps) {
  const t = useT();
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

  return (
    <div data-testid="sessions-sidebar-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="h-7 flex items-center gap-1 px-1.5 border-b shrink-0" style={{ borderColor: "var(--taomni-divider)" }}>
        <IconBtn testId="session-new" title={t("sidebar.newSessionTitle")} icon={<Plus className="w-3.5 h-3.5" />} onClick={() => onNewSession?.()} />
        <IconBtn testId="session-edit" title={t("sidebar.editTitle")} icon={<Edit3 className="w-3.5 h-3.5" />} onClick={() => selectionCount === 1 && onEditSession?.(selectedSessions[0])} disabled={selectionCount !== 1} />
        <IconBtn testId="session-duplicate" title={t("sidebar.duplicateTitle")} icon={<Copy className="w-3.5 h-3.5" />} onClick={() => selectionCount > 0 && void duplicateSessions(selectedSessionIds)} disabled={selectionCount === 0} />
        <IconBtn testId="session-delete" title={t("sidebar.deleteTitle")} icon={<Trash2 className="w-3.5 h-3.5" />} onClick={handleDelete} disabled={selectionCount === 0} />
        <span className="taomni-divider-v h-4 mx-1" />
        <IconBtn testId="session-refresh" title={t("sidebar.refreshTitle")} icon={<RefreshCw className="w-3.5 h-3.5" />} onClick={() => void loadSessions()} />
        <IconBtn testId="session-favorite" title={t("sidebar.favoriteTitle")} icon={<Star className="w-3.5 h-3.5" />} onClick={handleFavorite} disabled={selectionCount === 0} />
        <div className="flex-1" />
        <div className="relative min-w-[60px] flex-1">
          <Search className="w-3 h-3 absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
          <input
            type="search"
            data-testid="session-search"
            aria-label={t("sidebar.searchSessions")}
            className="taomni-input pl-6 w-full min-w-0"
            style={{ paddingLeft: "24px" }}
            placeholder={t("sidebar.searchPlaceholder")}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </div>
      </div>
      <SessionTree onNewSession={onNewSession} onConnectSession={onConnectSession} onEditSession={onEditSession} />
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
