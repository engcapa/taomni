import { FolderOpen, Folder, History } from "lucide-react";
import { type TranslateFn } from "../../lib/i18n";
import { type WelcomeHistoryTab } from "./types";


export function WelcomeHistoryPanel({
  translate: t,
  activeTab,
  directoryCount,
  workspaceCount,
  sessionCount,
  directoriesPanel,
  workspacesPanel,
  sessionsPanel,
  onActiveTabChange,
}: {
  translate: TranslateFn;
  activeTab: WelcomeHistoryTab;
  directoryCount: number;
  workspaceCount: number;
  sessionCount: number;
  directoriesPanel: React.ReactNode;
  workspacesPanel: React.ReactNode;
  sessionsPanel: React.ReactNode;
  onActiveTabChange: (tab: WelcomeHistoryTab) => void;
}) {
  const tabs: Array<{
    id: WelcomeHistoryTab;
    label: string;
    count: number;
    icon: React.ReactNode;
  }> = [
      {
        id: "sessions",
        label: t("welcome.recentSessionsHeading"),
        count: sessionCount,
        icon: <History className="w-3.5 h-3.5" />,
      },
      {
        id: "workspaces",
        label: t("welcome.recentWorkspacesHeading"),
        count: workspaceCount,
        icon: <Folder className="w-3.5 h-3.5" />,
      },
      {
        id: "directories",
        label: t("welcome.localDirectoriesHeading"),
        count: directoryCount,
        icon: <FolderOpen className="w-3.5 h-3.5" />,
      },
    ];

  return (
    <section
      data-testid="welcome-history-panel"
      className="mt-6 overflow-hidden rounded-md border"
      style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-card-bg)" }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b p-2" style={{ borderColor: "var(--taomni-divider)" }}>
        <div
          className="flex min-w-0 flex-1 flex-wrap items-center gap-1"
          role="tablist"
          aria-label={t("welcome.historyTabsLabel")}
        >
          {tabs.map((tab) => {
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                id={`welcome-history-tab-${tab.id}`}
                data-testid={`welcome-history-tab-${tab.id}`}
                className="h-8 min-w-0 rounded px-3 inline-flex items-center gap-1.5 text-[12px] font-medium"
                style={{
                  background: selected ? "var(--taomni-selected)" : "transparent",
                  color: selected ? "var(--taomni-text)" : "var(--taomni-text-muted)",
                  border: `1px solid ${selected ? "var(--taomni-selected-border)" : "transparent"}`,
                }}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`welcome-history-tabpanel-${tab.id}`}
                onClick={() => onActiveTabChange(tab.id)}
              >
                <span className="shrink-0 text-[var(--taomni-accent)]">{tab.icon}</span>
                <span className="truncate">{tab.label}</span>
                <span className="shrink-0 text-[11px] taomni-mono text-[var(--taomni-text-muted)]">
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div
        id={`welcome-history-tabpanel-${activeTab}`}
        className="p-4"
        role="tabpanel"
        aria-labelledby={`welcome-history-tab-${activeTab}`}
      >
        {activeTab === "directories" ? directoriesPanel : null}
        {activeTab === "workspaces" ? workspacesPanel : null}
        {activeTab === "sessions" ? sessionsPanel : null}
      </div>
    </section>
  );
}
