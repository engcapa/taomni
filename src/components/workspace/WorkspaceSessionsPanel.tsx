import { Search, Star } from "lucide-react";
import { useMemo, useState } from "react";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/sessionStore";
import type { SessionConfig } from "../../lib/ipc";
import {
  useWorkspacePlatformStore,
  type PlatformWorkspace,
} from "../../stores/workspacePlatformStore";

export interface WorkspaceSessionsPanelProps {
  workspace: PlatformWorkspace;
  onOpenSessionPicker: () => void;
  onOpenSession: (session: SessionConfig) => void;
}

const PROTOCOL_FILTERS = ["all", "SSH", "SFTP", "Database", "RDP", "VNC"] as const;

function matchesProtocol(session: SessionConfig, filter: string): boolean {
  if (filter === "all") return true;
  const type = session.session_type.toUpperCase();
  if (filter === "Database") return !["SSH", "SFTP", "RDP", "VNC", "FILE"].includes(type);
  if (filter === "RDP") return type === "RDP";
  if (filter === "VNC") return type === "VNC";
  return type === filter;
}

/**
 * Workspaces "Sessions" tool window (AC-07 entry 3): frequently used sessions
 * of this workspace on top, then every global session. Clicking any row opens
 * an isolated runtime tab in the workspace, never in the Sessions mode strip.
 */
export function WorkspaceSessionsPanel({ workspace, onOpenSessionPicker, onOpenSession }: WorkspaceSessionsPanelProps) {
  const t = useT();
  const sessions = useSessionStore((s) => s.sessions);
  const togglePinSession = useWorkspacePlatformStore((s) => s.togglePinSession);
  const openTabs = workspace.openTabs;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string>("all");

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions.filter((session) => {
      if (!matchesProtocol(session, filter)) return false;
      if (!needle) return true;
      return session.name.toLowerCase().includes(needle)
        || (session.host ?? "").toLowerCase().includes(needle)
        || session.session_type.toLowerCase().includes(needle);
    });
  }, [filter, query, sessions]);

  const pinned = visible.filter((session) => workspace.pinnedSessionIds.includes(session.id));
  const all = visible;

  const isOpen = (sessionId: string) => openTabs.some((tab) => tab.sessionId === sessionId);

  const row = (session: SessionConfig) => (
    <div
      key={session.id}
      role="treeitem"
      tabIndex={0}
      data-testid="workspace-session-row"
      data-session-id={session.id}
      data-open={isOpen(session.id) || undefined}
      className="group flex h-[24px] cursor-pointer items-center gap-1.5 rounded px-1.5 hover:bg-[var(--taomni-hover)]"
      onClick={() => onOpenSession(session)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpenSession(session);
      }}
    >
      <span
        className="shrink-0 rounded px-1 text-[9px] uppercase"
        style={{ border: "1px solid var(--taomni-divider)", color: "var(--taomni-text-muted)" }}
      >
        {session.session_type.slice(0, 4)}
      </span>
      <span className="min-w-0 flex-1 truncate" style={{ fontSize: "var(--taomni-ui-font-size)" }}>
        {session.name || session.host}
      </span>
      <span className="shrink-0 text-[10px] text-[var(--taomni-text-muted)]">
        {isOpen(session.id) ? "●" : session.host}
      </span>
      <button
        type="button"
        data-testid="workspace-session-pin"
        aria-label={t("platform.frequentSessions")}
        aria-pressed={workspace.pinnedSessionIds.includes(session.id)}
        title={t("platform.frequentSessions")}
        className="shrink-0 rounded p-0.5 opacity-0 hover:bg-[var(--taomni-hover)] group-hover:opacity-100"
        onClick={(event) => {
          event.stopPropagation();
          togglePinSession(workspace.id, session.id);
        }}
      >
        <Star
          className="h-3 w-3"
          style={{ color: workspace.pinnedSessionIds.includes(session.id) ? "var(--taomni-warning, #d97706)" : undefined }}
        />
      </button>
    </div>
  );

  return (
    <div data-testid="workspace-sessions-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 py-1" style={{ borderBottom: "1px solid var(--taomni-divider)" }}>
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
          <input
            type="search"
            data-testid="workspace-session-search"
            className="taomni-input h-6 w-full"
            style={{ paddingLeft: 22 }}
            aria-label={t("platform.searchSessions")}
            placeholder={t("platform.searchSessions")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button
          type="button"
          data-testid="workspace-session-browse-all"
          className="taomni-btn h-6 shrink-0 px-1.5"
          onClick={onOpenSessionPicker}
        >
          {t("platform.openAnySession")}
        </button>
      </div>
      <div className="flex shrink-0 flex-wrap gap-1 px-2 py-1">
        {PROTOCOL_FILTERS.map((entry) => (
          <button
            key={entry}
            type="button"
            data-testid={`workspace-session-filter-${entry.toLowerCase()}`}
            aria-pressed={filter === entry}
            className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
            style={{
              border: "1px solid var(--taomni-divider)",
              background: filter === entry ? "var(--taomni-selected)" : "transparent",
              color: filter === entry ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
            }}
            onClick={() => setFilter(entry)}
          >
            {entry === "all" ? t("common.all") : entry}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-2">
        <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--taomni-text-muted)]">
          {t("platform.frequentSessions")} ({pinned.length})
        </div>
        {pinned.length === 0 && <div className="px-2 text-[10.5px] text-[var(--taomni-text-muted)]">—</div>}
        {pinned.map(row)}
        <div className="mt-1 border-t px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--taomni-text-muted)]" style={{ borderColor: "var(--taomni-divider)" }}>
          {t("platform.allSessions")} ({all.length})
        </div>
        {all.map(row)}
      </div>
    </div>
  );
}
