import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useT } from "../../lib/i18n";
import type { SessionConfig } from "../../lib/ipc";
import { useSessionStore } from "../../stores/sessionStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";

const PROTOCOL_FILTERS = ["all", "ssh", "db", "sftp", "desktop"] as const;
type ProtocolFilter = (typeof PROTOCOL_FILTERS)[number];

function protocolGroup(session: SessionConfig): Exclude<ProtocolFilter, "all"> | null {
  switch (session.session_type) {
    case "SSH": return "ssh";
    case "SFTP": return "sftp";
    case "Database":
    case "MySQL":
    case "PostgreSQL":
    case "PanWeiDB":
    case "Oracle":
    case "SQLServer":
    case "StarRocks":
    case "ClickHouse":
    case "Presto":
    case "Redis":
    case "HBase":
    case "HBaseShell":
      return "db";
    case "Rdp":
    case "VNC":
      return "desktop";
    default:
      return null;
  }
}

/**
 * "Open any session" picker (v6.1 TASK-07, Ctrl+Alt+O): searches every global
 * session (not only pinned ones) and opens the chosen one as an isolated tab
 * of the active workspace, optionally pinning it to the workspace favorites.
 */
export function WorkspaceSessionPickerModal({
  open,
  onClose,
  onOpenSession,
}: {
  open: boolean;
  onClose: () => void;
  onOpenSession: (session: SessionConfig, pin: boolean) => void;
}) {
  const t = useT();
  const sessions = useSessionStore((s) => s.sessions);
  const activeWorkspaceId = useWorkspacePlatformStore((s) => s.activeWorkspaceId);
  const pinned = useWorkspacePlatformStore((s) => s.workspaces.find((ws) => ws.id === s.activeWorkspaceId)?.pinnedSessionIds ?? []);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProtocolFilter>("all");
  const [pin, setPin] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setFilter("all");
    setPin(false);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions.filter((session) => {
      const group = protocolGroup(session);
      if (filter === "ssh" && group !== "ssh") return false;
      if (filter === "db" && group !== "db") return false;
      if (filter === "sftp" && group !== "sftp") return false;
      if (filter === "desktop" && group !== "desktop") return false;
      if (!needle) return true;
      return (session.name || "").toLowerCase().includes(needle)
        || (session.host || "").toLowerCase().includes(needle)
        || session.session_type.toLowerCase().includes(needle);
    });
  }, [sessions, query, filter]);

  if (!open) return null;

  return (
    <div
      data-testid="workspace-session-picker-backdrop"
      className="fixed inset-0 z-[960] flex items-start justify-center pt-24"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("workspace.pickerTitle")}
        data-testid="workspace-session-picker-modal"
        className="w-[560px] max-w-[92vw] rounded-lg border shadow-2xl"
        style={{ background: "var(--taomni-bg)", borderColor: "var(--taomni-card-border)" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: "var(--taomni-divider)" }}>
          <Search className="h-4 w-4 shrink-0" style={{ color: "var(--taomni-text-muted)" }} />
          <input
            ref={inputRef}
            type="search"
            data-testid="workspace-session-picker-search"
            aria-label={t("workspace.pickerSearch")}
            className="taomni-input min-w-0 flex-1"
            placeholder={t("workspace.pickerSearch")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && filtered.length > 0) {
                event.preventDefault();
                onOpenSession(filtered[0], pin);
                onClose();
              }
            }}
          />
        </div>
        <div className="flex items-center gap-1 border-b px-3 py-1.5" style={{ borderColor: "var(--taomni-divider)" }}>
          {PROTOCOL_FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              data-testid={`workspace-session-picker-filter-${value}`}
              aria-pressed={filter === value}
              className="rounded-full border px-2 py-0.5 text-[11px]"
              style={{
                borderColor: filter === value ? "var(--taomni-accent)" : "var(--taomni-divider)",
                color: filter === value ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
              }}
              onClick={() => setFilter(value)}
            >
              {t(`workspace.pickerFilter${value.charAt(0).toUpperCase()}${value.slice(1)}` as never)}
            </button>
          ))}
        </div>
        <div className="max-h-[46vh] min-h-[120px] overflow-y-auto py-1" data-testid="workspace-session-picker-list">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px]" style={{ color: "var(--taomni-text-muted)" }}>
              {t("workspace.pickerEmpty")}
            </div>
          ) : (
            filtered.map((session) => {
              const isPinned = pinned.includes(session.id);
              return (
                <button
                  key={session.id}
                  type="button"
                  data-testid={`workspace-session-picker-row-${session.id}`}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-[var(--taomni-hover)]"
                  style={{ color: "var(--taomni-text)" }}
                  onClick={() => {
                    onOpenSession(session, pin);
                    onClose();
                  }}
                >
                  <span className="w-4 shrink-0 text-center" style={{ color: "var(--taomni-accent)" }}>{isPinned ? "★" : ""}</span>
                  <span
                    className="shrink-0 rounded px-1 text-[9px] font-semibold uppercase"
                    style={{ background: "var(--taomni-hover)", color: "var(--taomni-text-muted)" }}
                  >
                    {session.session_type}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{session.name || session.host}</span>
                  <span className="shrink-0 text-[10px]" style={{ color: "var(--taomni-text-muted)" }}>
                    {session.host}{session.host && session.port ? `:${session.port}` : ""}
                  </span>
                </button>
              );
            })
          )}
        </div>
        <label
          className="flex cursor-pointer items-center gap-2 border-t px-3 py-2 text-[12px]"
          style={{ borderColor: "var(--taomni-divider)", color: "var(--taomni-text)" }}
          data-testid="workspace-session-picker-pin-label"
        >
          <input
            type="checkbox"
            data-testid="workspace-session-picker-pin"
            checked={pin}
            onChange={(event) => setPin(event.target.checked)}
          />
          {t("workspace.pickerPin")}
        </label>
        <div className="border-t px-3 py-1.5 text-[10px]" style={{ borderColor: "var(--taomni-divider)", color: "var(--taomni-text-muted)" }} data-testid="workspace-session-picker-workspace">
          {t("workspace.openInWorkspace")} · {activeWorkspaceId}
        </div>
      </div>
    </div>
  );
}
