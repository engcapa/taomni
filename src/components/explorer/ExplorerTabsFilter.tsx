import { Filter, Search, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EMPTY_EXPLORER_TAB_FILTER,
  EXPLORER_TAB_CATEGORIES,
  explorerTabCategory,
  explorerTabPath,
  filterExplorerTabs,
  hasExplorerTabFilter,
  type ExplorerTabCategory,
  type ExplorerTabFilter,
} from "../../lib/explorerTabFilter";
import { useExplorerStore } from "../../stores/explorerStore";
import { useExplorerUiStore } from "../../stores/explorerUiStore";
import { useExplorerLabels } from "./explorerLabels";
import { useToolbarPopover } from "../tabbar/useToolbarPopover";

const CATEGORY_LABEL: Record<ExplorerTabCategory, [string, string]> = {
  all: ["全部", "All"],
  folders: ["文件夹", "Folders"],
  files: ["文件", "Files"],
};

/** Toolbar entry to search and filter the open Explorer tabs without closing any. */
export function ExplorerTabsFilter() {
  const label = useExplorerLabels();
  const tabs = useExplorerStore((s) => s.tabs);
  const activeTabId = useExplorerStore((s) => s.activeTabId);
  const filter = useExplorerUiStore((s) => s.tabFilter);
  const [open, setOpen] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const position = useToolbarPopover(open, close, anchorRef, menuRef);
  const matches = useMemo(() => filterExplorerTabs(tabs, filter), [tabs, filter]);
  const counts = useMemo(() => {
    const result = new Map<ExplorerTabCategory, number>();
    for (const tab of tabs) {
      const category = explorerTabCategory(tab);
      result.set(category, (result.get(category) ?? 0) + 1);
    }
    return result;
  }, [tabs]);

  useEffect(() => { if (!tabs.length) close(); }, [tabs.length, close]);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const apply = (next: ExplorerTabFilter) => {
    useExplorerUiStore.getState().setTabFilter(next);
    setHighlightedId(null);
    const visible = filterExplorerTabs(tabs, next);
    if (visible.length && !visible.some((tab) => tab.id === activeTabId)) {
      useExplorerStore.getState().setActiveTab(visible[0].id);
    }
  };
  const pick = (id: string) => {
    useExplorerStore.getState().setActiveTab(id);
    close();
    anchorRef.current?.querySelector("button")?.focus({ preventScroll: true });
  };
  const categoryLabel = (category: ExplorerTabCategory) => label(...CATEGORY_LABEL[category]);

  if (!tabs.length) return null;

  return <div ref={anchorRef} className="relative shrink-0">
    <button type="button" data-testid="explorer-tabs-filter-trigger" className="taomni-platform-toolbar-button"
      aria-label={label("筛选文件浏览器标签", "Filter File Explorer tabs")}
      title={label("筛选文件浏览器标签", "Filter File Explorer tabs")}
      aria-haspopup="dialog" aria-expanded={open} data-active={hasExplorerTabFilter(filter) || undefined}
      onClick={() => setOpen((value) => !value)}><Filter /></button>
    {open && createPortal(<div ref={menuRef} data-testid="explorer-tabs-filter-menu" role="dialog"
      aria-label={label("筛选文件浏览器标签", "Filter File Explorer tabs")}
      className="taomni-tab-filter-menu fixed z-[9999] flex w-80 max-w-[calc(100vw-16px)] max-h-[70vh] flex-col rounded-lg border shadow-xl"
      style={{ ...position, background: "var(--taomni-panel-bg)", borderColor: "var(--taomni-divider)", color: "var(--taomni-text)" }}>
      <div className="flex items-center gap-2 px-3 py-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
        <input ref={inputRef} type="search" role="combobox" aria-expanded="true" aria-controls="explorer-filter-tab-list"
          aria-activedescendant={highlightedId ? `explorer-filter-row-${highlightedId}` : undefined}
          data-testid="explorer-tabs-filter-search" aria-label={label("搜索打开的标签", "Search open tabs")}
          placeholder={label("搜索打开的标签…", "Search open tabs…")}
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
              if (target) document.getElementById(`explorer-filter-row-${target.id}`)?.scrollIntoView?.({ block: "nearest" });
            } else if (event.key === "Enter") {
              const target = matches.find((tab) => tab.id === highlightedId) ?? matches[0];
              if (target) { event.preventDefault(); pick(target.id); }
            }
          }} />
        {hasExplorerTabFilter(filter) && <button type="button" data-testid="explorer-tabs-filter-clear"
          aria-label={label("清除过滤", "Clear filter")} title={label("清除过滤", "Clear filter")}
          className="rounded p-1 hover:bg-[var(--taomni-hover)]" onClick={() => apply(EMPTY_EXPLORER_TAB_FILTER)}><X className="h-3 w-3" /></button>}
      </div>
      <div data-testid="explorer-tab-categories" data-category={filter.category} role="group"
        aria-label={label("按类型筛选已打开的标签", "Filter open tabs by type")} className="flex flex-wrap gap-1 px-2 pb-2">
        {EXPLORER_TAB_CATEGORIES.map((category) => <button key={category} type="button"
          data-testid={`explorer-tab-filter-${category}`} aria-pressed={filter.category === category}
          className="taomni-toolbar-pill" onClick={() => apply({ ...filter, category })}>
          {categoryLabel(category)}<span className="ml-1 opacity-60">{category === "all" ? tabs.length : counts.get(category) ?? 0}</span>
        </button>)}
      </div>
      <div className="border-t px-3 py-1 text-ui-caption text-[var(--taomni-text-muted)]" style={{ borderColor: "var(--taomni-divider)" }}>
        {label(`当前可见 ${matches.length} / 全部 ${tabs.length}`, `${matches.length} visible / ${tabs.length} total`)}
      </div>
      <div id="explorer-filter-tab-list" role="listbox" aria-label={label("已打开的标签", "Open tabs")} className="min-h-0 overflow-y-auto p-1">
        {!matches.length && <div data-testid="explorer-tabs-filter-empty" className="px-3 py-4 text-[var(--taomni-text-muted)]">{label("没有符合当前过滤条件的标签", "No tabs match the current filter")}</div>}
        {matches.map((tab) => <button type="button" role="option" key={tab.id} id={`explorer-filter-row-${tab.id}`}
          data-testid="explorer-tabs-filter-row" data-tab-id={tab.id} data-tab-type={tab.type}
          aria-selected={tab.id === activeTabId} data-highlighted={highlightedId === tab.id || undefined}
          title={explorerTabPath(tab) || tab.title} onClick={() => pick(tab.id)}
          className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--taomni-hover)] aria-selected:text-[var(--taomni-accent)] data-[highlighted=true]:bg-[var(--taomni-selected)]">
          <span className="w-12 shrink-0 text-ui-caption text-[var(--taomni-text-muted)]">{categoryLabel(explorerTabCategory(tab))}</span>
          <span className="min-w-0 truncate">{tab.title}</span>
        </button>)}
      </div>
    </div>, document.body)}
  </div>;
}
