import {
  Terminal as TerminalIcon,
  Plus,
  Shield,
  FolderOpen,
  Folder,
  MessageCircle,
  History,
  ArrowUpDown,
  Search,
  X,
  Server,
  Play,
  Edit3,
  Copy,
  Trash2,
  CheckSquare,
  Square,
  Settings2,
  ListTree,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  listLocalShells,
  listWslDistros,
  openLocalShellAsAdministrator,
  type LocalShellOption,
  type SessionConfig,
  type WslDistro,
} from "../lib/ipc";
import { getAppPlatform } from "../lib/runtime";
import { sftpLocalHome } from "../lib/sftp";
import { useAppStore } from "../stores/appStore";
import { useSessionStore } from "../stores/sessionStore";
import type { LocalShellSelection } from "../types";
import { useT, type TranslateFn } from "../lib/i18n";
import { sessionTypeLabel } from "../lib/terminalProfile";
import { SESSION_ROOT_LABEL, collectFolderPaths, folderOptionLabel } from "../lib/sessionPaths";
import { useContextMenu, type MenuItem } from "./ContextMenu";
import { useConfirmDialog } from "./sidebar/ConfirmDialog";

interface WelcomePanelProps {
  onStartLocalTerminal: (shell?: LocalShellSelection) => void;
  onNewSession: () => void;
  onOpenLocalPath?: (path: string, opts?: { embedFolder?: boolean }) => void;
  onOpenLanChat?: () => void;
  recentSessions?: SessionConfig[];
  onOpenRecentSession?: (session: SessionConfig) => void;
  onOpenRecentSessions?: (sessions: SessionConfig[]) => void;
  onEditRecentSession?: (session: SessionConfig) => void;
  onRevealRecentSession?: (session: SessionConfig) => void;
  onOpenSettings?: () => void;
}

const EMPTY_RECENT_SESSIONS: SessionConfig[] = [];
type RecentSessionSort =
  | "last-desc"
  | "last-asc"
  | "name-asc"
  | "name-desc"
  | "type-asc"
  | "type-desc"
  | "host-asc"
  | "host-desc";

export function WelcomePanel({
  onStartLocalTerminal,
  onNewSession,
  onOpenLocalPath,
  onOpenLanChat,
  recentSessions = EMPTY_RECENT_SESSIONS,
  onOpenRecentSession,
  onOpenRecentSessions,
  onEditRecentSession,
  onRevealRecentSession,
  onOpenSettings,
}: WelcomePanelProps) {
  const [localShells, setLocalShells] = useState<LocalShellOption[]>([]);
  const [selectedShellId, setSelectedShellId] = useState("");
  const [shellStatus, setShellStatus] = useState<"loading" | "ready" | "error">("loading");
  const [wslDistros, setWslDistros] = useState<WslDistro[]>([]);
  const [selectedDistro, setSelectedDistro] = useState("");
  const [wslStatus, setWslStatus] = useState<"loading" | "ready" | "error" | "unsupported">("loading");
  const [recentQuery, setRecentQuery] = useState("");
  const [recentType, setRecentType] = useState("all");
  const [recentSort, setRecentSort] = useState<RecentSessionSort>("last-desc");
  const [selectedRecentIds, setSelectedRecentIds] = useState<string[]>([]);
  const { setStatusMessage } = useAppStore();
  const t = useT();

  useEffect(() => {
    let cancelled = false;

    listLocalShells()
      .then((shells) => {
        if (cancelled) return;
        const list = Array.isArray(shells) ? shells : [];
        setLocalShells(list);
        setSelectedShellId(list.find((shell) => shell.isDefault)?.id ?? list[0]?.id ?? "");
        setShellStatus("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setShellStatus("error");
        setStatusMessage(t("status.localShellDetectionFailed", { error: String(error) }));
      });

    if (getAppPlatform() === "windows") {
      listWslDistros()
        .then((distros) => {
          if (cancelled) return;
          const list = Array.isArray(distros) ? distros : [];
          setWslDistros(list);
          setSelectedDistro(list.find((d) => d.isDefault)?.name ?? list[0]?.name ?? "");
          setWslStatus("ready");
        })
        .catch((error) => {
          if (cancelled) return;
          setWslStatus("error");
          setStatusMessage(t("welcome.wslDetectFailed", { error: String(error) }));
        });
    } else {
      setWslStatus("unsupported");
    }

    return () => {
      cancelled = true;
    };
  }, [setStatusMessage, t]);

  const mergedShells = useMemo<LocalShellOption[]>(() => {
    if (wslDistros.length === 0) return localShells;
    const virtual: LocalShellOption[] = wslDistros.map((d) => ({
      id: `wsl:${d.name}`,
      name: `WSL: ${d.name}`,
      path: "wsl.exe",
      args: ["-d", d.name],
      isDefault: false,
      canElevate: true,
    }));
    return [...localShells, ...virtual];
  }, [localShells, wslDistros]);

  const selectedShell = useMemo(
    () => mergedShells.find((shell) => shell.id === selectedShellId),
    [mergedShells, selectedShellId],
  );

  const recentTypeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const session of recentSessions) {
      const label = sessionTypeLabel(session.session_type, session.options_json);
      if (!seen.has(label)) seen.set(label, label);
    }
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [recentSessions]);

  const filteredRecentSessions = useMemo(() => {
    const q = recentQuery.trim().toLowerCase();
    const filtered = recentSessions.filter((session) => {
      const label = sessionTypeLabel(session.session_type, session.options_json);
      if (recentType !== "all" && label !== recentType) return false;
      if (!q) return true;
      return [
        session.name,
        session.host,
        session.username ?? "",
        session.group_path ?? "",
        session.session_type,
        label,
        String(session.port ?? ""),
      ]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
    return filtered.sort((a, b) => compareRecentSessions(a, b, recentSort));
  }, [recentQuery, recentSessions, recentSort, recentType]);

  useEffect(() => {
    const known = new Set(recentSessions.map((session) => session.id));
    setSelectedRecentIds((ids) => {
      const next = ids.filter((id) => known.has(id));
      return next.length === ids.length ? ids : next;
    });
  }, [recentSessions]);

  useEffect(() => {
    if (recentType === "all") return;
    if (!recentTypeOptions.some((option) => option.value === recentType)) {
      setRecentType("all");
    }
  }, [recentType, recentTypeOptions]);

  const selectedRecentSet = useMemo(() => new Set(selectedRecentIds), [selectedRecentIds]);
  const selectedRecentSessions = useMemo(
    () => {
      const byId = new Map(recentSessions.map((session) => [session.id, session]));
      return selectedRecentIds.flatMap((id) => {
        const session = byId.get(id);
        return session ? [session] : [];
      });
    },
    [recentSessions, selectedRecentIds],
  );

  const handleStartAsAdministrator = async () => {
    try {
      await openLocalShellAsAdministrator(selectedShell?.id);
      setStatusMessage(t("status.administratorRequested", {
        shell: selectedShell?.name ?? t("welcome.defaultShell"),
      }));
    } catch (error) {
      setStatusMessage(t("status.administratorFailed", { error: String(error) }));
    }
  };

  const handleOpenHomeFolder = async () => {
    if (!onOpenLocalPath) return;
    try {
      const home = await sftpLocalHome();
      if (home) onOpenLocalPath(home, { embedFolder: true });
    } catch (error) {
      setStatusMessage(t("status.homeLookupFailed", { error: String(error) }));
    }
  };

  return (
    <div data-testid="welcome-panel" className="w-full h-full min-w-0 overflow-auto" style={{ background: "var(--taomni-bg)" }}>
      <div className="w-full max-w-[1320px] mx-auto px-6 sm:px-8 lg:px-10 py-8">
        <div className="flex items-center gap-3 mb-5">
          <div
            data-testid="welcome-brand-mark"
            className="w-12 h-12 rounded-lg flex items-center justify-center text-white font-bold text-xl"
            style={{ background: "linear-gradient(135deg, #1e5fa8, #62d36f)" }}
          >
            T
          </div>
          <div>
            <div className="text-xl font-semibold">{t("app.welcomeTitle")}</div>
            <div className="text-[12px] text-[var(--taomni-text-muted)]">
              {t("app.tagline")}
            </div>
            <div
              data-testid="welcome-version"
              className="text-[11px] mt-0.5 taomni-mono"
              style={{ color: "var(--taomni-text-muted)" }}
            >
              {t("welcome.versionLabel", { version: __APP_VERSION__ })}
            </div>
          </div>
        </div>

        <div
          className="grid gap-4 items-stretch"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))" }}
        >
          <LocalTerminalCard
            translate={t}
            shells={mergedShells}
            selectedShell={selectedShell}
            selectedShellId={selectedShellId}
            shellStatus={shellStatus}
            onSelectShell={setSelectedShellId}
            kbd="Ctrl+Shift+T"
            onStart={() => {
              if (!selectedShell) {
                onStartLocalTerminal();
                return;
              }
              onStartLocalTerminal({
                // Real shells have id === path; virtual WSL entries map id="wsl:<distro>"
                // to path="wsl.exe" — pass the executable path so the backend can resolve it.
                id: selectedShell.path,
                name: selectedShell.name,
                ...(selectedShell.args && selectedShell.args.length > 0
                  ? { args: selectedShell.args }
                  : {}),
              });
            }}
            onStartAsAdministrator={handleStartAsAdministrator}
            onOpenHomeFolder={onOpenLocalPath ? () => void handleOpenHomeFolder() : undefined}
          />
          {wslStatus === "ready" && wslDistros.length > 0 && (
            <WslCard
              translate={t}
              distros={wslDistros}
              selectedDistro={selectedDistro}
              onSelectDistro={setSelectedDistro}
              onStart={() => {
                if (!selectedDistro) return;
                onStartLocalTerminal({
                  id: "wsl.exe",
                  name: `WSL: ${selectedDistro}`,
                  args: ["-d", selectedDistro],
                });
              }}
            />
          )}
          <ActionCard
            icon={<Plus className="w-5 h-5" />}
            title={t("welcome.newSessionTitle")}
            desc={t("welcome.newSessionDesc")}
            kbd="Ctrl+Shift+N"
            onClick={() => onNewSession()}
          />
          {onOpenLanChat ? (
            <ActionCard
              testId="welcome-open-lanchat"
              icon={<MessageCircle className="w-5 h-5" />}
              title={t("welcome.lanChatTitle")}
              desc={t("welcome.lanChatDesc")}
              kbd=""
              onClick={onOpenLanChat}
            />
          ) : null}
        </div>

        <RecentSessionsPanel
          translate={t}
          sessions={recentSessions}
          filteredSessions={filteredRecentSessions}
          typeOptions={recentTypeOptions}
          query={recentQuery}
          typeFilter={recentType}
          sort={recentSort}
          selectedIds={selectedRecentSet}
          selectedCount={selectedRecentIds.length}
          onQueryChange={setRecentQuery}
          onTypeFilterChange={setRecentType}
          onSortChange={setRecentSort}
          onToggleSession={(id) => {
            setSelectedRecentIds((ids) =>
              ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
            );
          }}
          onClearFilter={() => {
            setRecentQuery("");
            setRecentType("all");
          }}
          onSelectFiltered={() => setSelectedRecentIds(filteredRecentSessions.map((session) => session.id))}
          onClearSelection={() => setSelectedRecentIds([])}
          onOpenSession={onOpenRecentSession}
          onOpenSessions={onOpenRecentSessions}
          onEditSession={onEditRecentSession}
          onRevealSession={onRevealRecentSession}
          selectedSessions={selectedRecentSessions}
          onSetSelectedSessions={setSelectedRecentIds}
          onOpenSettings={onOpenSettings}
        />

        <div className="mt-7 text-[12px] text-[var(--taomni-text-muted)]">
          <div className="font-semibold text-[var(--taomni-text)] mb-1">{t("welcome.tipsHeading")}</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li
              dangerouslySetInnerHTML={{
                __html: t("welcome.tipQuickConnect", {
                  example: '<span class="taomni-mono px-1 border rounded" style="background: var(--taomni-input-bg); border-color: var(--taomni-divider);">ssh user@host:22</span>',
                }),
              }}
            />
            <li>{t("welcome.tipRightClick")}</li>
            <li>{t("welcome.tipDrag")}</li>
          </ul>
        </div>

        <div
          data-testid="welcome-version-footer"
          className="mt-7 pt-3 flex items-center justify-between text-[11px] taomni-mono"
          style={{
            borderTop: "1px solid var(--taomni-divider)",
            color: "var(--taomni-text-muted)",
          }}
        >
          <span>{t("app.name")}</span>
          <span>v{__APP_VERSION__}</span>
        </div>
      </div>
    </div>
  );
}

function RecentSessionsPanel({
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
  typeOptions: Array<{ value: string; label: string }>;
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

  return (
    <section
      data-testid="welcome-recent-sessions"
      className="mt-6 border-y py-4"
      style={{ borderColor: "var(--taomni-divider)" }}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-[var(--taomni-accent)]" />
            <div className="font-semibold">{t("welcome.recentSessionsHeading")}</div>
            <span className="text-[11px] taomni-mono text-[var(--taomni-text-muted)]">
              {t("welcome.recentSessionsCount", { count: filteredSessions.length })}
            </span>
          </div>
          <div className="mt-0.5 text-[12px] text-[var(--taomni-text-muted)]">
            {t("welcome.recentSessionsSubtitle")}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            data-testid="welcome-recent-open-all"
            className="taomni-btn h-8 px-3 inline-flex items-center gap-1.5"
            type="button"
            disabled={!canOpen || sessions.length === 0}
            onClick={() => onOpenSessions?.(sessions)}
          >
            <Play className="w-3.5 h-3.5" />
            <span>{t("welcome.recentSessionsOpenAll")}</span>
          </button>
          <button
            data-testid="welcome-recent-open-filtered"
            className="taomni-btn h-8 px-3 inline-flex items-center gap-1.5"
            type="button"
            disabled={!canOpen || filteredSessions.length === 0}
            onClick={() => onOpenSessions?.(filteredSessions)}
          >
            <Play className="w-3.5 h-3.5" />
            <span>{t("welcome.recentSessionsOpenFiltered")}</span>
          </button>
          <button
            data-testid="welcome-recent-open-selected"
            className="taomni-btn h-8 px-3 inline-flex items-center gap-1.5"
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
              className="taomni-btn h-8 w-8 inline-flex items-center justify-center"
              type="button"
              title={t("welcome.recentSessionsSettings")}
              aria-label={t("welcome.recentSessionsSettings")}
              onClick={onOpenSettings}
            >
              <Settings2 className="w-3.5 h-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_180px_180px_auto_auto]">
        <div className="relative min-w-0">
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
          className="taomni-input h-8 w-full"
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
        <div className="relative min-w-0">
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
          data-testid="welcome-recent-select-filtered"
          className="taomni-btn h-8 px-3 inline-flex items-center justify-center gap-1.5"
          type="button"
          disabled={filteredSessions.length === 0}
          onClick={onSelectFiltered}
        >
          <CheckSquare className="w-3.5 h-3.5" />
          <span>{t("welcome.recentSessionsSelectFiltered")}</span>
        </button>
        <button
          data-testid="welcome-recent-clear-filter"
          className="taomni-btn h-8 px-3 inline-flex items-center justify-center gap-1.5"
          type="button"
          disabled={!hasFilter}
          onClick={onClearFilter}
        >
          <X className="w-3.5 h-3.5" />
          <span>{t("welcome.recentSessionsClearFilter")}</span>
        </button>
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
                      folderPaths,
                      onOpenSession,
                      onOpenSessions,
                      onEditSession,
                      onDuplicateSessions: duplicateSessions,
                      onMoveSessionsToGroup: moveSessionsToGroup,
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
                  <button
                    data-testid="welcome-recent-open"
                    className="min-w-0 text-left group"
                    type="button"
                    aria-label={t("welcome.recentSessionsOpenAria", { name: title })}
                    onClick={() => onOpenSession?.(session)}
                  >
                    <div className="min-w-0 flex items-center gap-2">
                      <Server className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-accent)]" />
                      <span className="truncate text-[12px] font-medium text-[var(--taomni-accent)] group-hover:underline">{title}</span>
                      <span className="shrink-0 text-[10px] taomni-mono px-1.5 py-0.5 rounded border text-[var(--taomni-text-muted)]" style={{ borderColor: "var(--taomni-divider)" }}>
                        {typeLabel}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-[var(--taomni-text-muted)]">
                      {recentSessionTarget(session)} · {t("welcome.recentSessionsUpdated", { time: formatRecentSessionTime(session.last_connected_at, t) })}
                    </div>
                  </button>
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

function recentSessionMenuItems({
  t,
  session,
  targetSessions,
  folderPaths,
  onOpenSession,
  onOpenSessions,
  onEditSession,
  onDuplicateSessions,
  onMoveSessionsToGroup,
  onDeleteSessions,
  onConnectMenuSessions,
}: {
  t: TranslateFn;
  session: SessionConfig;
  targetSessions: readonly SessionConfig[];
  folderPaths: string[];
  onOpenSession?: (session: SessionConfig) => void;
  onOpenSessions?: (sessions: SessionConfig[]) => void;
  onEditSession?: (session: SessionConfig) => void;
  onDuplicateSessions: (ids: string[]) => Promise<void>;
  onMoveSessionsToGroup: (ids: string[], groupPath: string | null) => Promise<void>;
  onDeleteSessions: (sessions: readonly SessionConfig[]) => Promise<void>;
  onConnectMenuSessions: (sessions: readonly SessionConfig[], sourceLabel: string) => void;
}): MenuItem[] {
  const uniqueSessions = uniqueRecentSessionsById(targetSessions);
  const targetIds = uniqueSessions.map((candidate) => candidate.id);
  const hasMultiSelection = uniqueSessions.length > 1;
  const moveChildren: MenuItem[] = [
    {
      label: SESSION_ROOT_LABEL,
      icon: <FolderOpen className="w-3 h-3" />,
      onClick: () => void onMoveSessionsToGroup(targetIds, null),
    },
    ...folderPaths.map((path) => ({
      label: folderOptionLabel(path),
      icon: <Folder className="w-3 h-3" />,
      onClick: () => void onMoveSessionsToGroup(targetIds, path),
    })),
  ];

  return [
    ...(hasMultiSelection ? [
      {
        label: t("sessionTree.contextConnectSelected", { count: uniqueSessions.length }),
        testId: `context-menu-item-connect-selected-sessions-${uniqueSessions.length}`,
        icon: <Play className="w-3 h-3" />,
        onClick: () => onConnectMenuSessions(uniqueSessions, t("sessionTree.fromSelected")),
        disabled: !onOpenSessions,
      },
      { label: "", separator: true },
    ] satisfies MenuItem[] : []),
    {
      label: t("sessionTree.contextConnect"),
      icon: <Play className="w-3 h-3" />,
      disabled: !onOpenSession,
      onClick: () => onOpenSession?.(session),
    },
    {
      label: t("sessionTree.contextEdit"),
      icon: <Edit3 className="w-3 h-3" />,
      disabled: !onEditSession,
      onClick: () => onEditSession?.(session),
    },
    {
      label: hasMultiSelection
        ? t("sessionTree.contextDuplicateCount", { count: targetIds.length })
        : t("sessionTree.contextDuplicate"),
      testId: hasMultiSelection ? `context-menu-item-duplicate-selected-sessions-${targetIds.length}` : undefined,
      icon: <Copy className="w-3 h-3" />,
      onClick: () => void onDuplicateSessions(targetIds),
    },
    {
      label: t("sessionTree.contextMoveToFolder"),
      icon: <Folder className="w-3 h-3" />,
      children: moveChildren,
    },
    { label: "", separator: true },
    {
      label: hasMultiSelection
        ? t("sessionTree.contextDeleteCount", { count: targetIds.length })
        : t("sessionTree.contextDelete"),
      testId: hasMultiSelection ? `context-menu-item-delete-selected-sessions-${targetIds.length}` : undefined,
      icon: <Trash2 className="w-3 h-3" />,
      danger: true,
      onClick: () => void onDeleteSessions(uniqueSessions),
    },
  ];
}

function uniqueRecentSessionsById(sessions: readonly SessionConfig[]): SessionConfig[] {
  const seen = new Set<string>();
  const unique: SessionConfig[] = [];
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    unique.push(session);
  }
  return unique;
}

function compareRecentSessions(a: SessionConfig, b: SessionConfig, sort: RecentSessionSort): number {
  const labelA = sessionTypeLabel(a.session_type, a.options_json);
  const labelB = sessionTypeLabel(b.session_type, b.options_json);
  const nameA = (a.name || a.host || labelA).toLowerCase();
  const nameB = (b.name || b.host || labelB).toLowerCase();
  if (sort === "last-asc") return (a.last_connected_at ?? 0) - (b.last_connected_at ?? 0);
  if (sort === "name-asc") return nameA.localeCompare(nameB);
  if (sort === "name-desc") return nameB.localeCompare(nameA);
  if (sort === "type-asc") return labelA.localeCompare(labelB) || nameA.localeCompare(nameB);
  if (sort === "type-desc") return labelB.localeCompare(labelA) || nameA.localeCompare(nameB);
  if (sort === "host-asc") return (a.host || "").localeCompare(b.host || "") || nameA.localeCompare(nameB);
  if (sort === "host-desc") return (b.host || "").localeCompare(a.host || "") || nameA.localeCompare(nameB);
  return (b.last_connected_at ?? 0) - (a.last_connected_at ?? 0);
}

function recentSessionTarget(session: SessionConfig): string {
  const host = session.host?.trim();
  if (session.session_type === "File") return host || session.name || "File";
  if (session.session_type === "LocalShell") return host || session.name || "Local shell";
  if (!host) return session.group_path || session.session_type;
  const user = session.username ? `${session.username}@` : "";
  const port = session.port ? `:${session.port}` : "";
  return `${user}${host}${port}`;
}

function formatRecentSessionTime(value: number | null | undefined, t: TranslateFn): string {
  if (!value) return t("welcome.recentSessionsNever");
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value * 1000));
}

function LocalTerminalCard({
  translate: t,
  shells,
  selectedShell,
  selectedShellId,
  shellStatus,
  onSelectShell,
  kbd,
  onStart,
  onStartAsAdministrator,
  onOpenHomeFolder,
}: {
  translate: TranslateFn;
  shells: LocalShellOption[];
  selectedShell?: LocalShellOption;
  selectedShellId: string;
  shellStatus: "loading" | "ready" | "error";
  onSelectShell: (id: string) => void;
  kbd: string;
  onStart: () => void;
  onStartAsAdministrator: () => void;
  onOpenHomeFolder?: () => void;
}) {
  const hasChoices = shells.length > 1;
  const canElevate = selectedShell?.canElevate ?? false;
  const detail = selectedShell?.path ?? (
    shellStatus === "loading" ? t("welcome.detectingShells") : t("welcome.useDefault")
  );

  return (
    <div
      className="text-left p-4 min-h-[170px] h-full rounded-md border taomni-card-hover flex flex-col"
      style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-card-bg)" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: "var(--taomni-accent)" }}><TerminalIcon className="w-5 h-5" /></span>
        <span className="font-semibold">{t("welcome.localTerminal")}</span>
        {kbd && (
          <span
            className="ml-auto text-[10px] taomni-mono px-1.5 py-0.5 rounded border"
            style={{
              background: "var(--taomni-input-bg)",
              borderColor: "var(--taomni-divider)",
              color: "var(--taomni-text-muted)",
            }}
          >
            {kbd}
          </span>
        )}
      </div>
      <div className="text-[12px] text-[var(--taomni-text-muted)]">
        {selectedShell ? t("welcome.openShell", { shell: selectedShell.name }) : t("welcome.openLocalShell")}
      </div>

      <div className="mt-3 space-y-3">
        {hasChoices ? (
          <select
            className="taomni-input h-8 w-full"
            aria-label={t("welcome.terminalShellAria")}
            value={selectedShellId}
            title={selectedShell?.path}
            onChange={(event) => onSelectShell(event.target.value)}
          >
            {shells.map((shell) => (
              <option key={shell.id} value={shell.id}>
                {shell.name}{shell.isDefault ? t("welcome.defaultLabel") : ""}
              </option>
            ))}
          </select>
        ) : (
          <div
            className="taomni-input h-8 w-full flex items-center truncate"
            title={detail}
            style={{ color: selectedShell ? "var(--taomni-text)" : "var(--taomni-text-muted)" }}
          >
            {selectedShell?.name ?? (shellStatus === "loading" ? t("welcome.detectingShellsShort") : t("welcome.defaultShell"))}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 flex-wrap">
          <button data-testid="welcome-open-local-terminal" className="taomni-btn h-8 px-3" onClick={onStart} type="button">
            {t("welcome.open")}
          </button>
          {canElevate && (
            <button
              className="taomni-btn h-8 px-3 inline-flex items-center gap-1.5"
              onClick={onStartAsAdministrator}
              title={t("welcome.adminTitle")}
              aria-label={t("welcome.adminTitle")}
              type="button"
            >
              <Shield className="w-3.5 h-3.5" />
              <span>{t("welcome.admin")}</span>
            </button>
          )}
          {onOpenHomeFolder && (
            <button
              data-testid="welcome-open-home-folder"
              className="taomni-btn h-8 px-3 inline-flex items-center gap-1.5"
              onClick={onOpenHomeFolder}
              title={t("welcome.homeFolderTitle")}
              type="button"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span>{t("welcome.homeFolder")}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function WslCard({
  translate: t,
  distros,
  selectedDistro,
  onSelectDistro,
  onStart,
}: {
  translate: TranslateFn;
  distros: WslDistro[];
  selectedDistro: string;
  onSelectDistro: (name: string) => void;
  onStart: () => void;
}) {
  const current = distros.find((d) => d.name === selectedDistro);
  const detail = current
    ? t("welcome.wslDetail", {
        state: current.state,
        version: current.version != null ? String(current.version) : "?",
      })
    : t("welcome.wslOpenDesc");

  return (
    <div
      data-testid="welcome-wsl-card"
      className="text-left p-4 min-h-[170px] h-full rounded-md border taomni-card-hover flex flex-col"
      style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-card-bg)" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: "#0078d4" }}>
          <TerminalIcon className="w-5 h-5" />
        </span>
        <span className="font-semibold">{t("welcome.openWsl")}</span>
      </div>
      <div className="text-[12px] text-[var(--taomni-text-muted)]">{detail}</div>

      <div className="mt-3 space-y-3">
        <select
          data-testid="welcome-wsl-distro"
          className="taomni-input h-8 w-full"
          aria-label={t("welcome.wslDistroAria")}
          value={selectedDistro}
          onChange={(event) => onSelectDistro(event.target.value)}
        >
          {distros.map((d) => (
            <option key={d.name} value={d.name}>
              {d.name}{d.isDefault ? t("welcome.defaultLabel") : ""}
            </option>
          ))}
        </select>
        <div className="flex items-center justify-end gap-2 flex-wrap">
          <button
            data-testid="welcome-wsl-open"
            className="taomni-btn h-8 px-3"
            onClick={onStart}
            type="button"
          >
            {t("welcome.openWslButton")}
          </button>
        </div>
      </div>
    </div>
  );
}

function ActionCard({
  testId,
  icon,
  title,
  desc,
  kbd,
  onClick,
}: {
  testId?: string;
  icon: React.ReactNode;
  title: string;
  desc: string;
  kbd: string;
  onClick: () => void;
}) {
  return (
    <button
      data-testid={testId}
      className="text-left p-4 min-h-[138px] h-full rounded-md border taomni-card-hover flex flex-col"
      style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-card-bg)" }}
      onClick={onClick}
      type="button"
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: "var(--taomni-accent)" }}>{icon}</span>
        <span className="font-semibold">{title}</span>
        {kbd && (
          <span
            className="ml-auto text-[10px] taomni-mono px-1.5 py-0.5 rounded border"
            style={{
              background: "var(--taomni-input-bg)",
              borderColor: "var(--taomni-divider)",
              color: "var(--taomni-text-muted)",
            }}
          >
            {kbd}
          </span>
        )}
      </div>
      <div className="text-[12px] text-[var(--taomni-text-muted)]">{desc}</div>
    </button>
  );
}
