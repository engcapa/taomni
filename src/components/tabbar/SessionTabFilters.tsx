import { ChevronDown, ListFilter } from "lucide-react";
import { useState } from "react";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { useT } from "../../lib/i18n";
import { filterVisibleTabs, sessionTabCategory, type SessionTabCategory, type TabFilter } from "../../lib/tabFilter";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";

const CATEGORIES: SessionTabCategory[] = ["all", "ssh", "database", "sftp", "remote", "local", "other"];

/** One compact protocol selector leaves room for long tab strips. */
export function SessionTabFilters() {
  const t = useT();
  const tabs = useAppStore((state) => state.tabs);
  const filter = useAppStore((state) => state.tabFilter);
  const sessions = useSessionStore((state) => state.sessions);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
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
  const items: MenuItem[] = CATEGORIES.map((protocol) => ({
    label: `${t(`tabs.category.${protocol}`)}  ${tabs.filter((tab) => tab.type !== "welcome" && (protocol === "all" || sessionTabCategory(tab, sessions) === protocol)).length}`,
    testId: `session-tab-filter-${protocol}`,
    checked: category === protocol,
    onClick: () => select(protocol),
  }));
  return <>
    <button type="button" data-testid="session-tab-filter" data-category={category}
      aria-label={t("tabs.categoryFilter")} aria-haspopup="menu" aria-expanded={menu !== null}
      title={t("tabs.categoryFilter")} className="mb-0.5 mr-1 inline-flex h-6 max-w-[90px] shrink-0 items-center gap-1 rounded px-1.5 text-[10px]"
      style={{ color: category === "all" ? "var(--taomni-text-muted)" : "var(--taomni-accent)", background: category === "all" ? undefined : "var(--taomni-selected)" }}
      onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu(menu ? null : { x: rect.left, y: rect.bottom + 4 }); }}>
      <ListFilter className="h-3 w-3 shrink-0" /><span className="truncate">{t(`tabs.category.${category}`)}</span><ChevronDown className="h-2.5 w-2.5 shrink-0" />
    </button>
    {menu && <ContextMenu testId="session-tab-filter-menu" {...menu} items={items} onClose={() => setMenu(null)} />}
  </>;
}
