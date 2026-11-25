import { IconButton } from "../ui/IconButton";
import { ChevronLeft, ChevronRight, FilePlus2 as NpFilePlus, Pin as NpPin, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { writeText } from "../../lib/clipboard";
import { openExplorer } from "../../lib/explorer/openExplorer";
import { openUntitledNotepadDocument } from "../../lib/openFile";
import { documentPathKey } from "../../lib/openFile/pathIdentity";
import { filterExplorerTabs, hasExplorerTabFilter } from "../../lib/explorerTabFilter";
import { maxScrollLeft } from "../tabbar/tabs/scroll";
import { IconBtn, TabIcon } from "../tabbar/tabs/TabItem";
import { buildTabContextMenu } from "../tabbar/tabs/tabContextMenu";
import { useTabStripScroll } from "../tabbar/tabs/useTabStripScroll";
import { useDocumentStore } from "../../stores/documentStore";
import { useExplorerStore } from "../../stores/explorerStore";
import { useExplorerUiStore } from "../../stores/explorerUiStore";
import { useSftpStore } from "../../stores/sftpStore";
import { useAppStore } from "../../stores/appStore";
import type { Tab } from "../../types";
import { ContextMenu } from "../ContextMenu";
import { ViewerDirtyIndicator } from "../viewer/ViewerDirtyIndicator";
import { useExplorerLabels } from "./explorerLabels";

export function ExplorerTabStrip() {
  const tabs = useExplorerStore((state) => state.tabs);
  const activeTabId = useExplorerStore((state) => state.activeTabId);
  const setActiveTab = useExplorerStore((state) => state.setActiveTab);
  const closeTab = useExplorerStore((state) => state.closeTab);
  const closeTabs = useExplorerStore((state) => state.closeTabs);
  const moveTab = useExplorerStore((state) => state.moveTab);
  const renameTab = useExplorerStore((state) => state.renameTab);
  const togglePinTab = useExplorerStore((state) => state.togglePinTab);
  const closeTabsLeft = useExplorerStore((state) => state.closeTabsLeft);
  const closeTabsRight = useExplorerStore((state) => state.closeTabsRight);
  const closeUnmodifiedTabs = useExplorerStore((state) => state.closeUnmodifiedTabs);
  const closeUnpinnedTabs = useExplorerStore((state) => state.closeUnpinnedTabs);
  const filter = useExplorerUiStore((state) => state.tabFilter);
  const label = useExplorerLabels();
  const [menu, setMenu] = useState<{ tab: Tab; x: number; y: number } | null>(null);
  const [keyboardNavigation, setKeyboardNavigation] = useState(false);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
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
  useEffect(() => {
    // A tab closed (or closed by a bulk action) mid-rename must not leave the
    // strip stuck in edit mode.
    if (editingTabId && !tabs.some((tab) => tab.id === editingTabId)) {
      setEditingTabId(null);
      setDraftTitle("");
    }
  }, [tabs, editingTabId]);
  const activate = (id: string) => {
    setActiveTab(id);
    useAppStore.getState().setActiveSideTab("explorer");
  };
  const startRename = (tab: Tab) => {
    setActiveTab(tab.id);
    setEditingTabId(tab.id);
    setDraftTitle(tab.title);
  };
  const commitRename = () => {
    if (!editingTabId) return;
    const next = draftTitle.trim();
    const target = tabs.find((tab) => tab.id === editingTabId);
    if (next && target && next !== target.title) renameTab(editingTabId, next);
    setEditingTabId(null);
    setDraftTitle("");
  };
  const cancelRename = () => {
    setEditingTabId(null);
    setDraftTitle("");
  };
  // A file browser duplicates the directory it currently shows; a viewer tab
  // cannot be duplicated (it has no independent Explorer lane).
  const currentPathOfTab = (tab: Tab) =>
    useSftpStore.getState().sessions[tab.id]?.local.path || tab.fileBrowser?.initialPath || tab.title;
  const copyTabPath = (tab: Tab) => {
    const path = tab.fileViewer?.path ?? tab.fileBrowser?.initialPath ?? tab.title;
    void writeText(path)
      .then(() => useAppStore.getState().setStatusMessage(label("已复制路径", "Path copied")))
      .catch((error) => useAppStore.getState().setStatusMessage(String(error)));
  };
  const menuItems = (tab: Tab) => {
    const index = tabs.findIndex((item) => item.id === tab.id);
    const docs = useDocumentStore.getState().documents;
    const first = index <= 0;
    const last = index >= tabs.length - 1;
    return buildTabContextMenu({
      labels: {
        close: label("关闭", "Close"),
        closeOthers: label("关闭其他标签", "Close others"),
        closeAll: label("全部关闭", "Close all"),
        rename: label("重命名", "Rename"),
        duplicate: label("复制标签", "Duplicate tab"),
        copyPath: label("复制路径", "Copy path"),
        moveToFirst: label("移动到最前", "Move to first"),
        moveLeft: label("向左移动", "Move left"),
        moveRight: label("向右移动", "Move right"),
        moveToLast: label("移动到最后", "Move to last"),
        pin: label("固定标签", "Pin tab"),
        unpin: label("取消固定标签", "Unpin tab"),
        closeLeft: label("关闭左侧标签", "Close tabs to the left"),
        closeRight: label("关闭右侧标签", "Close tabs to the right"),
        closeUnmodified: label("关闭未修改标签", "Close unmodified tabs"),
        closeUnpinned: label("关闭未固定标签", "Close unpinned tabs"),
      },
      state: {
        closable: true,
        canRename: true,
        canDuplicate: tab.type === "file-browser",
        pinned: Boolean(tab.pinned),
        first,
        last,
      },
      testIdFor: (key) => `explorer-tab-context-${key}`,
      pinAndBulkClose: true,
      actions: {
        close: () => closeTab(tab.id),
        closeOthers: () => closeTabs(tabs.filter((item) => item.id !== tab.id && !item.pinned).map((item) => item.id)),
        closeAll: () => closeTabs(tabs.filter((item) => !item.pinned).map((item) => item.id)),
        rename: () => startRename(tab),
        duplicate: () => {
          void openExplorer(currentPathOfTab(tab), { forceNew: true })
            .catch((error) => useAppStore.getState().setStatusMessage(String(error)));
        },
        copyPath: () => copyTabPath(tab),
        moveToFirst: () => moveTab(tab.id, 0),
        moveLeft: () => moveTab(tab.id, index - 1),
        moveRight: () => moveTab(tab.id, index + 1),
        moveToLast: () => moveTab(tab.id, tabs.length - 1),
        togglePin: () => togglePinTab(tab.id),
        closeLeft: () => closeTabsLeft(tab.id),
        closeRight: () => closeTabsRight(tab.id),
        closeUnmodified: () => closeUnmodifiedTabs((item) => Boolean(item.fileViewer && docs[documentPathKey(item.fileViewer.path)]?.dirty)),
        closeUnpinned: () => closeUnpinnedTabs(),
      },
    });
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
        data-tab-style="session"
        data-active={activeTabId === tab.id}
        title={tab.fileBrowser?.initialPath ?? tab.fileViewer?.path ?? tab.title}
        className="taomni-tab group flex max-w-[190px] shrink-0 items-center gap-1 px-2 text-ui-body"
        onClick={() => { if (editingTabId !== tab.id) activate(tab.id); }}
        onAuxClick={(event) => { if (event.button === 1) closeTab(tab.id); }}
        onContextMenu={(event) => { event.preventDefault(); setMenu({ tab, x: event.clientX, y: event.clientY }); }}
        onKeyDown={(event) => {
          if (editingTabId === tab.id || event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
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
        <TabIcon tab={tab} />
        <span
          data-testid="explorer-tab-title"
          className="truncate"
          onDoubleClick={(event) => { event.stopPropagation(); startRename(tab); }}
        >
          {editingTabId === tab.id ? (
            <input
              data-testid="explorer-tab-rename-input"
              autoFocus
              type="text"
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitRename();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  cancelRename();
                }
                event.stopPropagation();
              }}
              onFocus={(event) => event.currentTarget.select()}
              onBlur={commitRename}
              className="bg-transparent border-b border-[var(--taomni-accent)] outline-none text-ui-body leading-none w-[160px] px-0"
              style={{ color: "inherit", font: "inherit" }}
            />
          ) : tab.title}
        </span>
        {tab.fileViewer && <ViewerDirtyIndicator path={tab.fileViewer.path} />}
        <X
          data-testid="tab-close"
          aria-label={label("关闭标签", "Close tab")}
          className="w-3 h-3 ml-1 opacity-60 hover:opacity-100"
          onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}
          onPointerDown={(event) => event.stopPropagation()}
        />
      </div>)}
      {!visibleTabs.length && tabs.length > 0 && <span data-testid="explorer-tab-filter-empty" className="truncate px-2 text-ui-small text-[var(--taomni-text-muted)]">{label("没有匹配的标签", "No matching tabs")}</span>}
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
    <IconButton type="button" data-testid="explorer-tab-new-home" label={label("新建主目录标签", "New home tab")} className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-[var(--taomni-hover)]" onClick={() => {
      void openExplorer(undefined, { forceNew: true }).catch((error) => useAppStore.getState().setStatusMessage(String(error)));
    }}><Plus className="h-3.5 w-3.5" /></IconButton>
    <IconButton type="button" data-testid="explorer-tab-new-notepad" label={label("新建文本文档", "New Notepad document")} className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-[var(--taomni-hover)]" onClick={() => {
      openUntitledNotepadDocument({ host: "explorer" });
    }}><NpFilePlus className="h-3.5 w-3.5" /></IconButton>
    <div className="h-full min-w-[24px] flex-1" data-window-drag />
    {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menuItems(menu.tab)} />}
  </div>;
}
