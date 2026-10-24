import { Clock, Plus, Terminal } from "lucide-react";
import { useT } from "../../lib/i18n";
import type { SessionConfig } from "../../lib/ipc";

/**
 * Home-mode sidebar (v6.1 TASK-08): quick navigation entries and the most
 * recent sessions. The Home content canvas itself is the WelcomePanel.
 */
export function HomeSidebar({
  onNewSession,
  onConnectSession,
  sessions,
}: {
  onNewSession?: (groupPath?: string | null) => void;
  onConnectSession?: (session: SessionConfig) => void;
  sessions: SessionConfig[];
}) {
  const t = useT();
  const recent = sessions
    .filter((session) => session.last_connected_at)
    .slice()
    .sort((a, b) => (b.last_connected_at ?? 0) - (a.last_connected_at ?? 0))
    .slice(0, 8);
  return (
    <div data-testid="home-sidebar" className="flex min-h-0 flex-1 flex-col" style={{ background: "var(--taomni-sidebar-bg)" }}>
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b px-2 text-[12px] font-semibold" style={{ borderColor: "var(--taomni-divider)", color: "var(--taomni-text)" }}>
        <Terminal className="h-3.5 w-3.5" />
        {t("sidebar.sideTabHome")}
      </div>
      <div className="p-1.5">
        <button
          type="button"
          data-testid="home-sidebar-new-session"
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-[var(--taomni-hover)]"
          style={{ color: "var(--taomni-text)" }}
          onClick={() => onNewSession?.()}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("sidebar.newSessionTitle")}
        </button>
      </div>
      <div className="px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: "var(--taomni-text-muted)" }}>
        {t("sidebar.recentConnections")}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
        {recent.length === 0 ? (
          <div className="px-2 py-1 text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>{t("sidebar.noRecent")}</div>
        ) : (
          recent.map((session) => (
            <button
              key={session.id}
              type="button"
              data-testid={`home-sidebar-recent-${session.id}`}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] hover:bg-[var(--taomni-hover)]"
              style={{ color: "var(--taomni-text)" }}
              onClick={() => onConnectSession?.(session)}
            >
              <Clock className="h-3 w-3 shrink-0" style={{ color: "var(--taomni-text-muted)" }} />
              <span className="min-w-0 flex-1 truncate">{session.name || session.host}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
