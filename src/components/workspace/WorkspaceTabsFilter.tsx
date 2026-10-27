import { Filter, Search, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { EMPTY_WORKSPACE_TAB_FILTER, filterWorkspaceTabs, hasWorkspaceTabFilter,
  WORKSPACE_TAB_CATEGORIES, workspaceTabCategory, type WorkspaceTabFilter } from "../../lib/workspaceTabFilter";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { useWorkspaceUiStore } from "../../stores/workspaceUiStore";
import { useToolbarPopover } from "../tabbar/useToolbarPopover";

/** A workspace owns its navigation filter; its tabs and runtimes stay open. */
export function WorkspaceTabsFilter() {
  const t = useT();
  const workspace = useWorkspacePlatformStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId));
  const filters = useWorkspaceUiStore((s) => s.tabFilters);
  const filter = filters[workspace?.id ?? ""] ?? EMPTY_WORKSPACE_TAB_FILTER;
  const [open, setOpen] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const position = useToolbarPopover(open, close, anchorRef, menuRef);
  const matches = useMemo(() => filterWorkspaceTabs(workspace?.openTabs ?? [], filter), [workspace?.openTabs, filter]);
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const tab of workspace?.openTabs ?? []) {
      const category = workspaceTabCategory(tab);
      result.set(category, (result.get(category) ?? 0) + 1);
    }
    return result;
  }, [workspace?.openTabs]);

  useEffect(() => { close(); setHighlightedId(null); }, [workspace?.id, close]);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const apply = (next: WorkspaceTabFilter) => {
    if (!workspace) return;
    useWorkspaceUiStore.getState().setTabFilter(workspace.id, next);
    setHighlightedId(null);
    const visible = filterWorkspaceTabs(workspace.openTabs, next);
    if (visible.length && !visible.some((tab) => tab.id === workspace.activeTabId)) {
      useWorkspacePlatformStore.getState().setActiveWorkspaceTab(workspace.id, visible[0].id);
    }
  };
  const pick = (id: string) => {
    if (workspace) useWorkspacePlatformStore.getState().setActiveWorkspaceTab(workspace.id, id);
    close();
    anchorRef.current?.querySelector("button")?.focus({ preventScroll: true });
  };
  if (!workspace) return null;

  return <div ref={anchorRef} className="relative shrink-0">
    <button type="button" data-testid="workspace-tabs-filter-trigger" className="taomni-platform-toolbar-button"
      aria-label={t("platform.filterWorkspaceTabs")} title={t("platform.filterWorkspaceTabs")}
      aria-haspopup="dialog" aria-expanded={open} data-active={hasWorkspaceTabFilter(filter) || undefined}
      onClick={() => setOpen((value) => !value)}><Filter /></button>
    {open && createPortal(<div ref={menuRef} data-testid="workspace-tabs-filter-menu" role="dialog"
      aria-label={t("platform.filterWorkspaceTabs")} className="taomni-tab-filter-menu fixed z-[9999] flex w-80 max-w-[calc(100vw-16px)] max-h-[70vh] flex-col rounded-lg border shadow-xl"
      style={{ ...position, background: "var(--taomni-panel-bg)", borderColor: "var(--taomni-divider)", color: "var(--taomni-text)" }}>
      <div className="flex items-center gap-2 px-3 py-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
        <input ref={inputRef} type="search" role="combobox" aria-expanded="true" aria-controls="workspace-filter-tab-list"
          aria-activedescendant={highlightedId ? `workspace-filter-row-${highlightedId}` : undefined}
          data-testid="workspace-tabs-filter-search" aria-label={t("tabs.filterPlaceholder")} placeholder={t("tabs.filterPlaceholder")}
          value={filter.query} className="min-w-0 flex-1 bg-transparent outline-none"
          onChange={(event) => apply({ ...filter, query: event.target.value })}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const index = matches.findIndex((tab) => tab.id === highlightedId);
              const next = index < 0 ? (event.key === "ArrowDown" ? 0 : matches.length - 1)
                : (index + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
              const target = matches[next];
              setHighlightedId(target?.id ?? null);
              if (target) document.getElementById(`workspace-filter-row-${target.id}`)?.scrollIntoView?.({ block: "nearest" });
            } else if (event.key === "Enter") {
              const target = matches.find((tab) => tab.id === highlightedId) ?? matches[0];
              if (target) { event.preventDefault(); pick(target.id); }
            }
          }} />
        {hasWorkspaceTabFilter(filter) && <button type="button" data-testid="workspace-tabs-filter-clear"
          aria-label={t("tabs.filterClear")} title={t("tabs.filterClear")}
          className="rounded p-1 hover:bg-[var(--taomni-hover)]" onClick={() => apply(EMPTY_WORKSPACE_TAB_FILTER)}><X className="h-3 w-3" /></button>}
      </div>
      <div data-testid="workspace-tab-categories" role="group" aria-label={t("tabs.categoryFilter")}
        className="flex flex-wrap gap-1 px-2 pb-2">
        {WORKSPACE_TAB_CATEGORIES.map((category) => <button key={category} type="button"
          data-testid={`workspace-tab-filter-${category}`} aria-pressed={filter.category === category}
          className="taomni-toolbar-pill" onClick={() => apply({ ...filter, category })}>
          {t(`tabs.category.${category}`)}<span className="ml-1 opacity-60">{category === "all" ? workspace.openTabs.length : counts.get(category) ?? 0}</span>
        </button>)}
      </div>
      <div className="border-t px-3 py-1 text-[10px] text-[var(--taomni-text-muted)]" style={{ borderColor: "var(--taomni-divider)" }}>
        {t("tabs.detailsVisibleCount", { visible: matches.length, total: workspace.openTabs.length })}
      </div>
      <div id="workspace-filter-tab-list" role="listbox" aria-label={t("tabs.openTabs")} className="min-h-0 overflow-y-auto p-1">
        {!matches.length && <div data-testid="workspace-tabs-filter-empty" className="px-3 py-4 text-[var(--taomni-text-muted)]">{t("tabs.filterNoMatch")}</div>}
        {matches.map((tab) => <button type="button" role="option" key={tab.id} id={`workspace-filter-row-${tab.id}`}
          data-testid="workspace-tabs-filter-row" data-tab-id={tab.id} data-tab-kind={tab.kind}
          aria-selected={tab.id === workspace.activeTabId} data-highlighted={highlightedId === tab.id || undefined}
          title={tab.filePath ?? tab.host ?? tab.title} onClick={() => pick(tab.id)}
          className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--taomni-hover)] aria-selected:text-[var(--taomni-accent)] data-[highlighted=true]:bg-[var(--taomni-selected)]">
          <span className="w-12 shrink-0 text-[10px] text-[var(--taomni-text-muted)]">{t(`tabs.category.${workspaceTabCategory(tab)}`)}</span>
          <span className="min-w-0 truncate">{tab.title}</span>
        </button>)}
      </div>
    </div>, document.body)}
  </div>;
}
