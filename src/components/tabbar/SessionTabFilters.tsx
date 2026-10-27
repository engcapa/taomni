import { useT } from "../../lib/i18n";
import { filterVisibleTabs, sessionTabCategory, type SessionTabCategory, type TabFilter } from "../../lib/tabFilter";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";

const CATEGORIES: SessionTabCategory[] = ["all", "ssh", "database", "sftp", "remote", "local", "other"];

/** Protocol filters share the searchable overflow menu, leaving the strip for tabs. */
export function SessionTabFilters() {
  const t = useT();
  const tabs = useAppStore((state) => state.tabs);
  const filter = useAppStore((state) => state.tabFilter);
  const sessions = useSessionStore((state) => state.sessions);
  const category = filter?.protocol ?? "all";
  const select = (protocol: SessionTabCategory) => {
    const { setTabFilter, setActiveTab, activeTabId } = useAppStore.getState();
    const base = filter?.kind === "protocol" ? null : filter;
    const next: TabFilter | null = protocol === "all"
      ? base ? { ...base, protocol: undefined } : null
      : { ...(base ?? { kind: "protocol" }), protocol };
    setTabFilter(next);
    const matching = filterVisibleTabs(tabs.filter((tab) => tab.type !== "welcome"), sessions, next);
    if (matching.length && !matching.some((tab) => tab.id === activeTabId)) setActiveTab(matching[0].id);
  };
  return <div role="group" data-testid="session-tab-categories" data-category={category}
    aria-label={t("tabs.categoryFilter")} className="flex flex-wrap gap-1 px-2 pb-2">
    {CATEGORIES.map((protocol) => <button key={protocol} type="button" data-testid={`session-tab-filter-${protocol}`}
      aria-pressed={category === protocol} onClick={() => select(protocol)}
      className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[10px] hover:bg-[var(--taomni-hover)]"
      style={{ color: category === protocol ? "var(--taomni-accent)" : "var(--taomni-text-muted)", background: category === protocol ? "var(--taomni-selected)" : undefined }}>
      <span>{t(`tabs.category.${protocol}`)}</span>
      <span className="opacity-70">{tabs.filter((tab) => tab.type !== "welcome" && (protocol === "all" || sessionTabCategory(tab, sessions) === protocol)).length}</span>
    </button>)}
  </div>;
}
