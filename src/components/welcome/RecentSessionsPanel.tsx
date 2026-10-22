import { ArrowUpDown, Search, X, Server, Play, CheckSquare, Square, Settings, ListTree } from "lucide-react";
import { useMemo } from "react";
import { type SessionConfig } from "../../lib/ipc";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { type TranslateFn } from "../../lib/i18n";
import { sessionTypeLabel } from "../../lib/terminalProfile";
import { collectFolderPaths } from "../../lib/sessionPaths";
import type { SessionTerminalAppearancePatch } from "../../lib/sessionTerminalTheme";
import { useContextMenu } from "../ContextMenu";
import { useConfirmDialog } from "../sidebar/ConfirmDialog";
import { type RecentSessionSort } from "./types";
import { uniqueRecentSessionsById, recentSessionTarget, formatRecentSessionTime } from "./sessionModel";
import { recentSessionMenuItems } from "./sessionMenu";


export function RecentSessionsPanel({
  translate: t,
  sessions,
  filteredSessions,
  typeOptions,
  query,
  typeFilter,
  sort,
  selectedIds,
  selectedCount,
  selectedSessions,
  onQueryChange,
  onTypeFilterChange,
  onSortChange,
  onToggleSession,
  onClearFilter,
  onSelectFiltered,
  onClearSelection,
  onOpenSession,
  onOpenSessions,
  onEditSession,
  onRevealSession,
  onSetSelectedSessions,
  onOpenSettings,
}: {
  translate: TranslateFn;
  sessions: SessionConfig[];
  filteredSessions: SessionConfig[];
  typeOptions: Array<{ value: string; label: string; }>;
  query: string;
  typeFilter: string;
  sort: RecentSessionSort;
  selectedIds: Set<string>;
  selectedCount: number;
  selectedSessions: SessionConfig[];
  onQueryChange: (value: string) => void;
  onTypeFilterChange: (value: string) => void;
  onSortChange: (value: RecentSessionSort) => void;
  onToggleSession: (id: string) => void;
  onClearFilter: () => void;
  onSelectFiltered: () => void;
  onClearSelection: () => void;
  onOpenSession?: (session: SessionConfig) => void;
  onOpenSessions?: (sessions: SessionConfig[]) => void;
  onEditSession?: (session: SessionConfig) => void;
  onRevealSession?: (session: SessionConfig) => void;
  onSetSelectedSessions: (ids: string[]) => void;
  onOpenSettings?: () => void;
}) {
  const hasFilter = query.trim().length > 0 || typeFilter !== "all";
  const canOpen = Boolean(onOpenSessions);
  const ctx = useContextMenu();
  const deleteConfirm = useConfirmDialog();
  const {
    sessions: allSessions,
    groups,
    duplicateSessions,
    moveSessionsToGroup,
    removeSessions,
    updateSessionsTerminalAppearance,
  } = useSessionStore();
  const { setStatusMessage } = useAppStore();
  const folderPaths = useMemo(
    () => collectFolderPaths(allSessions, groups),
    [allSessions, groups],
  );

  const connectMenuSessions = (targetSessions: readonly SessionConfig[], sourceLabel: string) => {
    const uniqueSessions = uniqueRecentSessionsById(targetSessions);
    if (uniqueSessions.length === 0) return;
    onOpenSessions?.(uniqueSessions);
    setStatusMessage(t("sessionTree.sessionsStarted", {
      count: uniqueSessions.length,
      plural: uniqueSessions.length === 1 ? "" : "s",
      source: sourceLabel,
    }));
  };

  const confirmDeleteSessions = async (targetSessions: readonly SessionConfig[]) => {
    const uniqueSessions = uniqueRecentSessionsById(targetSessions);
    if (uniqueSessions.length === 0) return;
    const confirmed = await deleteConfirm.confirm(
      uniqueSessions.length > 1
        ? {
          title: t("sessionTree.confirmDeleteSelectedTitle"),
          message: t("sessionTree.confirmDeleteSelected", { count: uniqueSessions.length }),
          confirmLabel: t("sessionTree.deleteAction"),
          danger: true,
        }
        : {
          title: t("sessionTree.confirmDeleteTitle"),
          message: t("sessionTree.confirmDelete", { name: uniqueSessions[0].name }),
          confirmLabel: t("sessionTree.deleteAction"),
          danger: true,
        },
    );
    if (!confirmed) return;
    await removeSessions(uniqueSessions.map((session) => session.id));
  };

  const setTerminalAppearance = async (
    patch: SessionTerminalAppearancePatch,
    targetSessions: readonly SessionConfig[],
  ) => {
    const updatedCount = await updateSessionsTerminalAppearance(
      uniqueRecentSessionsById(targetSessions).map((session) => session.id),
      patch,
    );
    setStatusMessage(t("sessionTree.terminalAppearanceUpdated", { count: updatedCount }));
  };

  return (
    <section
      data-testid="welcome-recent-sessions"
      className="min-w-0"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="relative min-w-[min(100%,220px)] flex-[1_1_220px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--taomni-text-muted)]" />
          <input
            data-testid="welcome-recent-filter"
            className="taomni-input h-8 w-full"
            style={{ paddingLeft: "2rem" }}
            type="search"
            aria-label={t("welcome.recentSessionsSearch")}
            placeholder={t("welcome.recentSessionsSearch")}
            value={query}
            disabled={sessions.length === 0}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
        <select
          data-testid="welcome-recent-type-filter"
          className="taomni-input h-8 w-[132px] max-w-full"
          aria-label={t("welcome.recentSessionsType")}
          value={typeFilter}
          disabled={sessions.length === 0}
          onChange={(event) => onTypeFilterChange(event.target.value)}
        >
          <option value="all">{t("welcome.recentSessionsAllTypes")}</option>
          {typeOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <div className="relative w-[172px] max-w-full">
          <ArrowUpDown className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--taomni-text-muted)]" />
          <select
            data-testid="welcome-recent-sort"
            className="taomni-input h-8 w-full"
            style={{ paddingLeft: "2rem" }}
            aria-label={t("welcome.recentSessionsSort")}
            title={t("welcome.recentSessionsSort")}
            value={sort}
            disabled={sessions.length === 0}
            onChange={(event) => onSortChange(event.target.value as RecentSessionSort)}
          >
            <option value="last-desc">{t("welcome.recentSessionsSortLastDesc")}</option>
            <option value="last-asc">{t("welcome.recentSessionsSortLastAsc")}</option>
            <option value="name-asc">{t("welcome.recentSessionsSortNameAsc")}</option>
            <option value="name-desc">{t("welcome.recentSessionsSortNameDesc")}</option>
            <option value="type-asc">{t("welcome.recentSessionsSortTypeAsc")}</option>
            <option value="type-desc">{t("welcome.recentSessionsSortTypeDesc")}</option>
            <option value="host-asc">{t("welcome.recentSessionsSortHostAsc")}</option>
            <option value="host-desc">{t("welcome.recentSessionsSortHostDesc")}</option>
          </select>
        </div>
        <button
          data-testid="welcome-recent-clear-filter"
          className="taomni-btn h-8 max-w-full px-3 inline-flex items-center justify-center gap-1.5"
          type="button"
          disabled={!hasFilter}
          onClick={onClearFilter}
        >
          <X className="w-3.5 h-3.5" />
          <span>{t("welcome.recentSessionsClearFilter")}</span>
        </button>
        <div className="h-6 w-px" style={{ background: "var(--taomni-divider)" }} />
        <button
          data-testid="welcome-recent-select-filtered"
          className="taomni-btn h-8 max-w-full px-3 inline-flex items-center justify-center gap-1.5"
          type="button"
          disabled={filteredSessions.length === 0}
          onClick={onSelectFiltered}
        >
          <CheckSquare className="w-3.5 h-3.5" />
          <span>{t("welcome.recentSessionsSelectFiltered")}</span>
        </button>
        <button
          data-testid="welcome-recent-open-all"
          className="taomni-btn h-8 max-w-full px-3 inline-flex items-center gap-1.5"
          type="button"
          disabled={!canOpen || sessions.length === 0}
          onClick={() => onOpenSessions?.(sessions)}
        >
          <Play className="w-3.5 h-3.5" />
          <span>{t("welcome.recentSessionsOpenAll")}</span>
        </button>
        <button
          data-testid="welcome-recent-open-filtered"
          className="taomni-btn h-8 max-w-full px-3 inline-flex items-center gap-1.5"
          type="button"
          disabled={!canOpen || filteredSessions.length === 0}
          onClick={() => onOpenSessions?.(filteredSessions)}
        >
          <Play className="w-3.5 h-3.5" />
          <span>{t("welcome.recentSessionsOpenFiltered")}</span>
        </button>
        <button
          data-testid="welcome-recent-open-selected"
          className="taomni-btn h-8 max-w-full px-3 inline-flex items-center gap-1.5"
          type="button"
          disabled={!canOpen || selectedSessions.length === 0}
          onClick={() => onOpenSessions?.(selectedSessions)}
        >
          <Play className="w-3.5 h-3.5" />
          <span>{t("welcome.recentSessionsOpenSelected")}</span>
        </button>
        {onOpenSettings ? (
          <button
            data-testid="welcome-recent-settings"
            className="taomni-btn h-8 w-8 p-0 inline-flex items-center justify-center"
            type="button"
            title={t("welcome.recentSessionsSettings")}
            aria-label={t("welcome.recentSessionsSettings")}
            onClick={onOpenSettings}
          >
            <Settings className="w-[18px] h-[18px]" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className="mt-2 min-h-[26px] flex flex-wrap items-center gap-2 text-[11px] text-[var(--taomni-text-muted)]">
        <span>{t("welcome.recentSessionsSelectedCount", { count: selectedCount })}</span>
        {selectedCount > 0 ? (
          <button
            data-testid="welcome-recent-clear-selection"
            className="taomni-btn h-6 px-2"
            type="button"
            onClick={onClearSelection}
          >
            {t("welcome.recentSessionsClearSelection")}
          </button>
        ) : null}
      </div>

      <div className="mt-2 max-h-[260px] overflow-auto">
        {sessions.length === 0 ? (
          <div
            data-testid="welcome-recent-empty"
            className="py-4 text-[12px] text-[var(--taomni-text-muted)]"
          >
            {t("welcome.recentSessionsEmpty")}
          </div>
        ) : filteredSessions.length === 0 ? (
          <div
            data-testid="welcome-recent-no-matches"
            className="py-4 text-[12px] text-[var(--taomni-text-muted)]"
          >
            {t("welcome.recentSessionsNoMatches")}
          </div>
        ) : (
          <div className="space-y-1">
            {filteredSessions.map((session) => {
              const typeLabel = sessionTypeLabel(session.session_type, session.options_json);
              const title = session.name || session.host || typeLabel;
              const selected = selectedIds.has(session.id);
              return (
                <div
                  key={session.id}
                  data-testid="welcome-recent-session-row"
                  data-session-id={session.id}
                  data-session-name={title}
                  data-session-type={typeLabel}
                  className="grid grid-cols-[32px_minmax(0,1fr)_32px] items-center gap-2 rounded border px-2 py-1.5"
                  style={{
                    borderColor: selected ? "var(--taomni-accent)" : "var(--taomni-divider)",
                    background: selected ? "var(--taomni-selected)" : "var(--taomni-input-bg)",
                  }}
                  onContextMenu={(event) => {
                    const targetSessions = selected ? selectedSessions : [session];
                    if (!selected) onSetSelectedSessions([session.id]);
                    ctx.show(event, recentSessionMenuItems({
                      t,
                      session,
                      targetSessions,
                      allSessions,
                      folderPaths,
                      setStatusMessage,
                      onOpenSession,
                      onOpenSessions,
                      onEditSession,
                      onDuplicateSessions: duplicateSessions,
                      onMoveSessionsToGroup: moveSessionsToGroup,
                      onSetTerminalAppearance: setTerminalAppearance,
                      onDeleteSessions: confirmDeleteSessions,
                      onConnectMenuSessions: connectMenuSessions,
                    }));
                  }}
                >
                  <button
                    data-testid="welcome-recent-select"
                    className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-control-hover)]"
                    type="button"
                    aria-label={t("welcome.recentSessionsSelectAria", { name: title })}
                    onClick={() => onToggleSession(session.id)}
                  >
                    {selected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                  </button>
                  <div className="min-w-0 text-left">
                    <div className="min-w-0 flex items-center gap-2">
                      <Server className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-accent)]" />
                      <button
                        data-testid="welcome-recent-open"
                        className="min-w-0 truncate text-left text-[12px] font-medium text-[var(--taomni-accent)] hover:underline focus-visible:underline"
                        type="button"
                        aria-label={t("welcome.recentSessionsOpenAria", { name: title })}
                        onClick={() => onOpenSession?.(session)}
                      >
                        {title}
                      </button>
                      <span className="shrink-0 text-[10px] taomni-mono px-1.5 py-0.5 rounded border text-[var(--taomni-text-muted)]" style={{ borderColor: "var(--taomni-divider)" }}>
                        {typeLabel}
                      </span>
                    </div>
                    <div data-testid="welcome-recent-details" className="mt-0.5 truncate text-[11px] text-[var(--taomni-text-muted)]">
                      {recentSessionTarget(session)} · {t("welcome.recentSessionsUpdated", { time: formatRecentSessionTime(session.last_connected_at, t) })}
                    </div>
                  </div>
                  <button
                    data-testid="welcome-recent-reveal"
                    className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-control-hover)]"
                    type="button"
                    disabled={!onRevealSession}
                    title={t("welcome.recentSessionsReveal")}
                    aria-label={t("welcome.recentSessionsRevealAria", { name: title })}
                    onClick={() => onRevealSession?.(session)}
                  >
                    <ListTree className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {ctx.render}
      {deleteConfirm.render}
    </section>
  );
}
