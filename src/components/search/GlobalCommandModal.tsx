import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, GitBranch, Home, PanelsTopLeft, Search } from "lucide-react";
import { useT } from "../../lib/i18n";
import type { SessionConfig } from "../../lib/ipc";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";

interface CommandEntry {
  id: string;
  testId: string;
  icon: React.ReactNode;
  label: string;
  hint?: string;
  run: () => void;
}

/**
 * Global Ctrl+K command palette (v6.1 TASK-09): fuzzy search across modes,
 * workspaces, global sessions (open isolated in the workspace or in Sessions
 * mode) and quick actions. Enter runs the first match, Esc closes.
 */
export function GlobalCommandModal({
  open,
  onClose,
  onOpenWorkspaceSession,
  onOpenGlobalSession,
}: {
  open: boolean;
  onClose: () => void;
  /** Open a session as an isolated workspace tab. */
  onOpenWorkspaceSession?: (session: SessionConfig) => void;
  /** Open a session with the regular Sessions-mode flow. */
  onOpenGlobalSession?: (session: SessionConfig) => void;
}) {
  const t = useT();
  const setActiveSideTab = useAppStore((s) => s.setActiveSideTab);
  const workspaces = useWorkspacePlatformStore((s) => s.workspaces);
  const setActiveWorkspace = useWorkspacePlatformStore((s) => s.setActiveWorkspace);
  const openGitPanel = useWorkspacePlatformStore((s) => s.openGitPanel);
  const sessions = useSessionStore((s) => s.sessions);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
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

  const entries = useMemo<CommandEntry[]>(() => {
    const result: CommandEntry[] = [
      {
        id: "go-home",
        testId: "global-search-go-home",
        icon: <Home className="h-4 w-4" />,
        label: t("globalSearch.goHome"),
        hint: "Rail #1",
        run: () => setActiveSideTab("home"),
      },
      {
        id: "go-sessions",
        testId: "global-search-go-sessions",
        icon: <PanelsTopLeft className="h-4 w-4" />,
        label: t("globalSearch.goSessions"),
        hint: "Rail #3",
        run: () => setActiveSideTab("sessions"),
      },
      {
        id: "go-agents",
        testId: "global-search-go-agents",
        icon: <Bot className="h-4 w-4" />,
        label: t("globalSearch.goAgents"),
        hint: "Rail #4",
        run: () => setActiveSideTab("agents"),
      },
      {
        id: "open-git",
        testId: "global-search-open-git",
        icon: <GitBranch className="h-4 w-4" />,
        label: t("globalSearch.openGitPanel"),
        hint: "Ctrl+Shift+G",
        run: () => {
          setActiveSideTab("workspaces");
          openGitPanel(useWorkspacePlatformStore.getState().activeWorkspaceId);
        },
      },
    ];
    for (const workspace of workspaces) {
      result.push({
        id: `workspace-${workspace.id}`,
        testId: `global-search-workspace-${workspace.id}`,
        icon: <span className="text-[12px]">🟣</span>,
        label: workspace.name,
        hint: `${workspace.rootFolders.length} 📁`,
        run: () => {
          setActiveWorkspace(workspace.id);
          setActiveSideTab("workspaces");
        },
      });
    }
    for (const session of sessions.slice(0, 40)) {
      const label = session.name || session.host || session.id;
      result.push({
        id: `session-ws-${session.id}`,
        testId: `global-search-session-ws-${session.id}`,
        icon: <span className="rounded px-1 text-[9px] font-semibold uppercase" style={{ background: "var(--taomni-hover)" }}>{session.session_type}</span>,
        label: `${label} — ${t("globalSearch.openInWorkspace")}`,
        hint: session.host ?? "",
        run: () => onOpenWorkspaceSession?.(session),
      });
      result.push({
        id: `session-global-${session.id}`,
        testId: `global-search-session-global-${session.id}`,
        icon: <span className="rounded px-1 text-[9px] font-semibold uppercase" style={{ background: "var(--taomni-hover)" }}>{session.session_type}</span>,
        label: `${label} — ${t("globalSearch.openInSessions")}`,
        hint: session.host ?? "",
        run: () => onOpenGlobalSession?.(session),
      });
    }
    return result;
  }, [t, workspaces, sessions, setActiveSideTab, setActiveWorkspace, openGitPanel, onOpenWorkspaceSession, onOpenGlobalSession]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return entries.slice(0, 12);
    return entries
      .filter((entry) => entry.label.toLowerCase().includes(needle) || (entry.hint ?? "").toLowerCase().includes(needle))
      .slice(0, 12);
  }, [entries, query]);

  if (!open || typeof document === "undefined") return null;

  const runFirst = () => {
    if (filtered.length === 0) return;
    filtered[0].run();
    onClose();
  };

  return createPortal(
    <div
      data-testid="global-search-modal"
      className="fixed inset-0 z-[980] flex items-start justify-center pt-24"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("globalSearch.title")}
        className="w-[600px] max-w-[92vw] rounded-lg border shadow-2xl"
        style={{ background: "var(--taomni-bg)", borderColor: "var(--taomni-card-border)", color: "var(--taomni-text)" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: "var(--taomni-divider)" }}>
          <Search className="h-4 w-4 shrink-0" style={{ color: "var(--taomni-text-muted)" }} />
          <input
            ref={inputRef}
            type="search"
            data-testid="global-search-input"
            aria-label={t("globalSearch.placeholder")}
            className="taomni-input min-w-0 flex-1"
            placeholder={t("globalSearch.placeholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                runFirst();
              }
            }}
          />
          <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px]" style={{ background: "var(--taomni-hover)", color: "var(--taomni-text-muted)" }}>Esc</span>
        </div>
        <div className="max-h-[46vh] overflow-y-auto py-1" data-testid="global-search-results">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px]" style={{ color: "var(--taomni-text-muted)" }}>{t("globalSearch.empty")}</div>
          ) : (
            filtered.map((entry, index) => (
              <button
                key={entry.id}
                type="button"
                data-testid={entry.testId}
                data-first={index === 0 || undefined}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] hover:bg-[var(--taomni-hover)]"
                onClick={() => {
                  entry.run();
                  onClose();
                }}
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center" style={{ color: "var(--taomni-text-muted)" }}>{entry.icon}</span>
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                {entry.hint && <span className="shrink-0 text-[10px]" style={{ color: "var(--taomni-text-muted)" }}>{entry.hint}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
