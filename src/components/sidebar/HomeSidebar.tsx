import { showAgentsComingSoon } from "../agents/comingSoon";
import { Boxes, Bot, MonitorSmartphone, Play, Plus, Server, Wrench } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import type { SessionConfig } from "../../lib/ipc";
import type { PrimaryNavMode } from "../../stores/appStore";

export interface HomeSidebarProps {
  onStartLocalTerminal: () => void;
  onNewSession: () => void;
  onConnectSession?: (session: SessionConfig) => void;
  onImportOpenSsh?: () => void;
}

/**
 * Home mode left panel (AC-02): platform overview and fast paths. The full
 * WelcomePanel (restore banner, launch cards, history) stays in the main
 * canvas, so Home never competes with the Sessions tab strip.
 */
export function HomeSidebar({
  onStartLocalTerminal,
  onNewSession,
  onConnectSession,
}: HomeSidebarProps) {
  const t = useT();
  const setActiveSideTab = useAppStore((s) => s.setActiveSideTab);
  const sessions = useSessionStore((s) => s.sessions);
  const recent = [...sessions]
    .sort((a, b) => (b.last_connected_at ?? 0) - (a.last_connected_at ?? 0))
    .slice(0, 6);

  const navButton = (mode: PrimaryNavMode, label: string, icon: React.ReactNode, testId: string) => (
    <button
      key={mode}
      type="button"
      data-testid={testId}
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)]"
      style={{ fontSize: "var(--taomni-ui-font-size)" }}
      onClick={() => mode === "agents" ? showAgentsComingSoon() : setActiveSideTab(mode)}
    >
      <span className="text-[var(--taomni-text-muted)]">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );

  return (
    <div data-testid="home-sidebar-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="px-2.5 py-2 border-b shrink-0" style={{ borderColor: "var(--taomni-divider)" }}>
        <div className="font-semibold text-[var(--taomni-text)]" style={{ fontSize: "var(--taomni-ui-font-size)" }}>
          {t("platform.homeTitle")}
        </div>
        <div className="mt-0.5 text-[11px] text-[var(--taomni-text-muted)]">{t("platform.homeHint")}</div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-1 p-2">
        <button
          type="button"
          data-testid="home-start-local-terminal"
          className="taomni-btn h-7 px-2 inline-flex items-center gap-1"
          onClick={onStartLocalTerminal}
        >
          <Play className="w-3.5 h-3.5" />
          {t("welcome.startLocalTerminal")}
        </button>
        <button
          type="button"
          data-testid="home-new-session"
          className="taomni-btn h-7 px-2 inline-flex items-center gap-1"
          onClick={onNewSession}
        >
          <Plus className="w-3.5 h-3.5" />
          {t("welcome.newSession")}
        </button>
      </div>
      <div className="px-1.5 pb-1">
        {navButton("workspaces", t("platform.workspaces"), <Boxes className="w-4 h-4" />, "home-nav-workspaces")}
        {navButton("sessions", t("platform.sessions"), <MonitorSmartphone className="w-4 h-4" />, "home-nav-sessions")}
        {navButton("agents", t("platform.agents"), <Bot className="w-4 h-4" />, "home-nav-agents")}
        {navButton("tools", t("platform.tools"), <Wrench className="w-4 h-4" />, "home-nav-tools")}
      </div>
      <div className="mt-1 flex min-h-0 flex-1 flex-col border-t" style={{ borderColor: "var(--taomni-divider)" }}>
        <div className="px-2.5 py-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--taomni-text-muted)]">
          {t("welcome.recentSessions")}
        </div>
        <div className="flex-1 overflow-y-auto px-1.5 pb-2" data-testid="home-recent-sessions">
          {recent.length === 0 && (
            <div className="px-1 py-1 text-[11px] text-[var(--taomni-text-muted)]">{t("sidebar.noRecent")}</div>
          )}
          {recent.map((session) => (
            <button
              key={session.id}
              type="button"
              data-testid="home-recent-session"
              data-session-id={session.id}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-[var(--taomni-hover)]"
              onClick={() => onConnectSession?.(session)}
            >
              <Server className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[var(--taomni-text)]" style={{ fontSize: "var(--taomni-ui-font-size)" }}>
                  {session.name}
                </span>
                <span className="block truncate text-[10.5px] text-[var(--taomni-text-muted)]">
                  {session.username ? `${session.username}@` : ""}{session.host}
                </span>
              </span>
              <span className="rounded px-1 text-[9px] uppercase text-[var(--taomni-text-muted)]" style={{ border: "1px solid var(--taomni-divider)" }}>
                {session.session_type}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
