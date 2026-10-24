import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/sessionStore";
import { useAppStore } from "../../stores/appStore";
import type { SessionConfig } from "../../lib/ipc";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";

export type WorkspaceSessionPickerFilter = "all" | "ssh" | "db" | "sftp" | "desktop";

const FILTERS: Array<{ id: WorkspaceSessionPickerFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "ssh", label: "SSH" },
  { id: "db", label: "DB" },
  { id: "sftp", label: "SFTP" },
  { id: "desktop", label: "Desktop" },
];

const DESKTOP_TYPES = new Set(["RDP", "VNC"]);
const DB_TYPES = new Set([
  "MySQL", "MariaDB", "PostgreSQL", "PanWeiDB", "Oracle", "SQLServer",
  "StarRocks", "ClickHouse", "Presto", "Redis", "HBaseShell",
]);

function matchesFilter(session: SessionConfig, filter: WorkspaceSessionPickerFilter): boolean {
  if (filter === "all") return true;
  if (filter === "ssh") return session.session_type === "SSH" || ["Telnet", "Rlogin", "Mosh", "Serial", "FTP"].includes(session.session_type);
  if (filter === "db") return DB_TYPES.has(session.session_type);
  if (filter === "sftp") return session.session_type === "SFTP" || session.session_type === "File";
  return DESKTOP_TYPES.has(session.session_type);
}

export interface WorkspaceSessionPickerModalProps {
  open: boolean;
  workspaceId: string;
  onClose: () => void;
}

/**
 * "Open any session" picker (AC-07 entry 2, `Ctrl+Alt+O`).
 *
 * Lists every global session — not just the ones linked to the workspace — and
 * opens the chosen one as an isolated workspace tab. The optional checkbox also
 * pins it to this workspace's frequently used list.
 */
export function WorkspaceSessionPickerModal({ open, workspaceId, onClose }: WorkspaceSessionPickerModalProps) {
  const t = useT();
  const sessions = useSessionStore((s) => s.sessions);
  const openSessionInWorkspace = useWorkspacePlatformStore((s) => s.openSessionInWorkspace);
  const setActiveSideTab = useAppStore((s) => s.setActiveSideTab);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<WorkspaceSessionPickerFilter>("all");
  const [pin, setPin] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setFilter("all");
    setPin(false);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions.filter((session) => {
      if (!matchesFilter(session, filter)) return false;
      if (!needle) return true;
      return session.name.toLowerCase().includes(needle)
        || (session.host ?? "").toLowerCase().includes(needle)
        || session.session_type.toLowerCase().includes(needle);
    });
  }, [filter, query, sessions]);

  if (!open) return null;

  const pick = (session: SessionConfig) => {
    openSessionInWorkspace(workspaceId, session, { pinToWorkspace: pin });
    setActiveSideTab("workspaces");
    setSidebarCollapsed(false);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[910] flex items-start justify-center pt-[12vh]"
      style={{ background: "rgba(0,0,0,0.35)" }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        data-testid="workspace-session-picker-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("platform.openAnySession")}
        className="flex max-h-[70vh] w-[620px] flex-col overflow-hidden rounded-lg border shadow-2xl"
        style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-panel-bg)" }}
      >
        <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: "var(--taomni-divider)" }}>
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
          <input
            ref={inputRef}
            data-testid="workspace-session-picker-search"
            className="taomni-input h-7 min-w-0 flex-1"
            aria-label={t("platform.searchSessions")}
            placeholder={t("platform.openAnySession")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="button" data-testid="workspace-session-picker-close" className="rounded p-1 hover:bg-[var(--taomni-hover)]" aria-label={t("common.close")} onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex shrink-0 flex-wrap gap-1 border-b px-3 py-1.5" style={{ borderColor: "var(--taomni-divider)" }}>
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              data-testid={`workspace-session-picker-filter-${entry.id}`}
              aria-pressed={filter === entry.id}
              className="rounded px-2 py-0.5 text-[11px] font-semibold"
              style={{
                border: "1px solid var(--taomni-divider)",
                background: filter === entry.id ? "var(--taomni-selected)" : "transparent",
                color: filter === entry.id ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
              }}
              onClick={() => setFilter(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1.5" data-testid="workspace-session-picker-list">
          {visible.length === 0 && (
            <div className="px-2 py-3 text-[12px]" style={{ color: "var(--taomni-text-muted)" }}>{t("platform.globalSearchEmpty")}</div>
          )}
          {visible.map((session) => (
            <button
              key={session.id}
              type="button"
              data-testid="workspace-session-picker-row"
              data-session-id={session.id}
              data-session-type={session.session_type}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--taomni-hover)]"
              onClick={() => pick(session)}
            >
              <span className="shrink-0 rounded px-1 text-[9px] uppercase" style={{ border: "1px solid var(--taomni-divider)", color: "var(--taomni-text-muted)" }}>
                {session.session_type.slice(0, 4)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px]">{session.name || session.host}</span>
                <span className="block truncate text-[10.5px]" style={{ color: "var(--taomni-text-muted)" }}>
                  {session.username ? `${session.username}@` : ""}{session.host}:{session.port}
                </span>
              </span>
              <span className="shrink-0 text-[10px]" style={{ color: "var(--taomni-text-muted)" }}>
                {session.group_path ?? ""}
              </span>
            </button>
          ))}
        </div>
        <label className="flex shrink-0 items-center gap-2 border-t px-3 py-2 text-[11.5px]" style={{ borderColor: "var(--taomni-divider)" }}>
          <input
            type="checkbox"
            data-testid="workspace-session-picker-pin"
            checked={pin}
            onChange={(event) => setPin(event.target.checked)}
          />
          {t("platform.pinToWorkspace")}
        </label>
      </div>
    </div>
  );
}
