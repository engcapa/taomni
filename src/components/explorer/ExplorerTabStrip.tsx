import { ChevronLeft, ChevronRight, FilePlus2 as NpFilePlus, FileText, Pin as NpPin, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { openExplorer } from "../../lib/explorer/openExplorer";
import { openUntitledNotepadDocument } from "../../lib/openFile";
import { documentPathKey } from "../../lib/openFile/pathIdentity";
import { filterExplorerTabs, hasExplorerTabFilter } from "../../lib/explorerTabFilter";
import { maxScrollLeft } from "../tabbar/tabs/scroll";
import { IconBtn } from "../tabbar/tabs/TabItem";
import { useTabStripScroll } from "../tabbar/tabs/useTabStripScroll";
import { useDocumentStore } from "../../stores/documentStore";
import { useExplorerStore } from "../../stores/explorerStore";
import { useExplorerUiStore } from "../../stores/explorerUiStore";
import { useAppStore } from "../../stores/appStore";
import type { Tab } from "../../types";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { ViewerDirtyIndicator } from "../viewer/ViewerDirtyIndicator";
import { ExplorerTabIcon } from "./ExplorerTabIcon";
import { useExplorerLabels } from "./explorerLabels";

export function ExplorerTabStrip() {
  const tabs = useExplorerStore((state) => state.tabs);
  const activeTabId = useExplorerStore((state) => state.activeTabId);
  const setActiveTab = useExplorerStore((state) => state.setActiveTab);
  const closeTab = useExplorerStore((state) => state.closeTab);
  const closeTabs = useExplorerStore((state) => state.closeTabs);
  const moveTab = useExplorerStore((state) => state.moveTab);
  const togglePinTab = useExplorerStore((state) => state.togglePinTab);
  const closeTabsLeft = useExplorerStore((state) => state.closeTabsLeft);
  const closeTabsRight = useExplorerStore((state) => state.closeTabsRight);
  const closeUnmodifiedTabs = useExplorerStore((state) => state.closeUnmodifiedTabs);
  const closeUnpinnedTabs = useExplorerStore((state) => state.closeUnpinnedTabs);
  const filter = useExplorerUiStore((state) => state.tabFilter);
  const label = useExplorerLabels();
  const [menu, setMenu] = useState<{ tab: Tab; x: number; y: number } | null>(null);
  const [keyboardNavigation, setKeyboardNavigation] = useState(false);
  const visibleTabs = useMemo(() => filterExplorerTabs(tabs, filter), [tabs, filter]);
  const scroll = useTabStripScroll("explorer", visibleTabs, activeTabId);
  const previousActive = useRef(activeTabId);
  useEffect(() => {
    const previous = previousActive.current;
    previousActive.current = activeTabId;
    // A new or externally activated tab must not stay hidden behind a stale filter.
    if (previous !== activeTabId && hasExplorerTabFilter(filter)
      && !visibleTabs.some((tab) => tab.id === activeTabId)) {
      useExplorerUiStore.getState().clearTabFilter();
    }
  }, [activeTabId, filter, visibleTabs]);
  const activate = (id: string) => {
    setActiveTab(id);
    useAppStore.getState().setActiveSideTab("explorer");
  };
  const menuItems = (tab: Tab): MenuItem[] => {
    const index = tabs.findIndex((item) => item.id === tab.id);
    const docs = useDocumentStore.getState().documents;
    return [
      { label: tab.pinned ? label("取消固定标签", "Unpin tab") : label("固定标签", "Pin tab"), testId: "explorer-tab-context-pin", icon: <NpPin />, onClick: () => togglePinTab(tab.id) },
      { label: "", separator: true },
      { label: label("关闭", "Close"), testId: "explorer-tab-context-close", icon: <X />, onClick: () => closeTab(tab.id) },
      { label: label("关闭其他标签", "Close others"), testId: "explorer-tab-context-close-others", onClick: () => closeTabs(tabs.filter((item) => item.id !== tab.id && !item.pinned).map((item) => item.id)) },
      { label: label("关闭左侧标签", "Close tabs to the left"), testId: "explorer-tab-context-close-left", disabled: index <= 0, onClick: () => closeTabsLeft(tab.id) },
      { label: label("关闭右侧标签", "Close tabs to the right"), testId: "explorer-tab-context-close-right", disabled: index >= tabs.length - 1, onClick: () => closeTabsRight(tab.id) },
      { label: label("关闭未修改标签", "Close unmodified tabs"), testId: "explorer-tab-context-close-unmodified", onClick: () => closeUnmodifiedTabs((t) => Boolean(t.fileViewer && docs[documentPathKey(t.fileViewer.path)]?.dirty)) },
      { label: label("关闭未固定标签", "Close unpinned tabs"), testId: "explorer-tab-context-close-unpinned", onClick: () => closeUnpinnedTabs() },
      { label: label("全部关闭", "Close all"), testId: "explorer-tab-context-close-all", onClick: () => closeTabs(tabs.filter((item) => !item.pinned).map((item) => item.id)) },
      { label: "", separator: true },
      { label: label("向左移动", "Move left"), testId: "explorer-tab-context-move-left", icon: <ChevronLeft />, disabled: index <= 0, onClick: () => moveTab(tab.id, index - 1) },
      { label: label("向右移动", "Move right"), testId: "explorer-tab-context-move-right", icon: <ChevronRight />, disabled: index === tabs.length - 1, onClick: () => moveTab(tab.id, index + 1) },
    ];
  };
  const filterChipText = filter.query.trim() || (filter.category === "folders"
    ? label("文件夹", "Folders")
    : filter.category === "files" ? label("文件", "Files") : label("全部", "All"));
  return <div data-testid="explorer-tab-strip" className="relative flex h-full min-w-0 flex-1 items-end gap-0.5 overflow-hidden">
    {scroll.scrollState.overflow && <IconBtn
      testId="explorer-tab-scroll-left"
      title={label("向左滚动标签", "Scroll tabs left")}
      icon={<ChevronLeft className="h-3.5 w-3.5" />}
      onClick={() => scroll.scrollBy("left")}
      disabled={scroll.scrollState.atStart}
    />}
    <div
      ref={scroll.scrollRef}
      role="tablist"
      aria-label={label("文件浏览器标签", "File Explorer tabs")}
      data-testid="explorer-tab-scroll-area"
      data-keyboard-navigation={keyboardNavigation ? "true" : undefined}
      className="taomni-explorer-tab-scroll flex min-w-0 items-end gap-0.5 overflow-x-auto overflow-y-hidden"
      onPointerDownCapture={() => { setKeyboardNavigation(false); scroll.markUserScroll(); }}
      onWheel={(event) => {
        const element = event.currentTarget;
        if (event.deltaX || event.deltaY) scroll.markUserScroll();
        if (maxScrollLeft(element) > 0 && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
          element.scrollLeft += event.deltaY;
        }
      }}
      onScroll={scroll.updateScrollState}
    >
      {visibleTabs.map((tab) => <div
        key={tab.id}
        ref={(element) => scroll.setTabElement(tab.id, element)}
        role="tab"
        tabIndex={activeTabId === tab.id ? 0 : -1}
        aria-selected={activeTabId === tab.id}
        data-testid="explorer-workspace-tab"
        data-tab-id={tab.id}
        data-tab-type={tab.type}
        data-tab-title={tab.title}
        data-active={activeTabId === tab.id}
        title={tab.fileBrowser?.initialPath ?? tab.fileViewer?.path ?? tab.title}
        className="taomni-workspace-tab group flex max-w-[190px] shrink-0 items-center gap-1 px-2 text-[12px]"
        onClick={() => activate(tab.id)}
        onAuxClick={(event) => { if (event.button === 1) closeTab(tab.id); }}
        onContextMenu={(event) => { event.preventDefault(); setMenu({ tab, x: event.clientX, y: event.clientY }); }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
          const index = visibleTabs.findIndex((item) => item.id === tab.id);
          const target = event.key === "ArrowLeft" ? visibleTabs[index - 1] : event.key === "ArrowRight" ? visibleTabs[index + 1] : event.key === "Home" ? visibleTabs[0] : event.key === "End" ? visibleTabs.at(-1) : undefined;
          if (target) {
            event.preventDefault();
            setKeyboardNavigation(true);
            activate(target.id);
            scroll.tabElements.current.get(target.id)?.focus({ preventScroll: true });
          }
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(tab.id); }
        }}
      >
        {tab.pinned && <NpPin className="h-3 w-3 shrink-0 text-[var(--taomni-accent)]" data-testid="explorer-tab-pin-badge" />}
        {tab.type === "file-browser" ? <ExplorerTabIcon /> : <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-accent)]" />}
        <span className="truncate">{tab.title}</span>
        {tab.fileViewer && <ViewerDirtyIndicator path={tab.fileViewer.path} />}
        <button type="button" data-testid="tab-close" aria-label={label("关闭标签", "Close tab")} className="ml-0.5 shrink-0 rounded px-0.5 opacity-50 hover:opacity-100" onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}><X className="h-3 w-3" /></button>
      </div>)}
      {!visibleTabs.length && tabs.length > 0 && <span data-testid="explorer-tab-filter-empty" className="truncate px-2 text-[11px] text-[var(--taomni-text-muted)]">{label("没有匹配的标签", "No matching tabs")}</span>}
    </div>
    {scroll.scrollState.overflow && <IconBtn
      testId="explorer-tab-scroll-right"
      title={label("向右滚动标签", "Scroll tabs right")}
      icon={<ChevronRight className="h-3.5 w-3.5" />}
      onClick={() => scroll.scrollBy("right")}
      disabled={scroll.scrollState.atEnd}
    />}
    {hasExplorerTabFilter(filter) && <button type="button" data-testid="explorer-tab-filter-chip"
      className="taomni-toolbar-pill shrink-0 max-w-32" title={label("清除过滤", "Clear filter")}
      onClick={() => useExplorerUiStore.getState().clearTabFilter()}>
      <span className="truncate">{filterChipText}</span><span aria-hidden="true"> ×</span>
    </button>}
    <button type="button" data-testid="explorer-tab-new-home" title={label("新建主目录标签", "New home tab")} className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-[var(--taomni-hover)]" onClick={() => {
      void openExplorer(undefined, { forceNew: true }).catch((error) => useAppStore.getState().setStatusMessage(String(error)));
    }}><Plus className="h-3.5 w-3.5" /></button>
    <button type="button" data-testid="explorer-tab-new-notepad" title={label("新建文本文档", "New Notepad document")} className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-[var(--taomni-hover)]" onClick={() => {
      openUntitledNotepadDocument({ host: "explorer" });
    }}><NpFilePlus className="h-3.5 w-3.5" /></button>
    <div className="h-full min-w-[24px] flex-1" data-window-drag />
    {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menuItems(menu.tab)} />}
  </div>;
}
