import { ChevronLeft, ChevronRight, FileText, Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import { openExplorer } from "../../lib/explorer/openExplorer";
import { useExplorerStore } from "../../stores/explorerStore";
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
  const label = useExplorerLabels();
  const scroll = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ tab: Tab; x: number; y: number } | null>(null);
  const activate = (id: string) => {
    setActiveTab(id);
    useAppStore.getState().setActiveSideTab("explorer");
  };
  const menuItems = (tab: Tab): MenuItem[] => {
    const index = tabs.findIndex((item) => item.id === tab.id);
    return [
      { label: label("关闭", "Close"), testId: "explorer-tab-context-close", icon: <X />, onClick: () => closeTab(tab.id) },
      { label: label("关闭其他标签", "Close others"), testId: "explorer-tab-context-close-others", onClick: () => closeTabs(tabs.filter((item) => item.id !== tab.id).map((item) => item.id)) },
      { label: label("全部关闭", "Close all"), testId: "explorer-tab-context-close-all", onClick: () => closeTabs(tabs.map((item) => item.id)) },
      { label: "", separator: true },
      { label: label("向左移动", "Move left"), testId: "explorer-tab-context-move-left", icon: <ChevronLeft />, disabled: index <= 0, onClick: () => moveTab(tab.id, index - 1) },
      { label: label("向右移动", "Move right"), testId: "explorer-tab-context-move-right", icon: <ChevronRight />, disabled: index === tabs.length - 1, onClick: () => moveTab(tab.id, index + 1) },
    ];
  };
  return <div data-testid="explorer-tab-strip" className="flex h-full min-w-0 flex-1 items-end gap-0.5 overflow-hidden">
    <div ref={scroll} role="tablist" aria-label={label("文件浏览器标签", "File Explorer tabs")} data-testid="explorer-tab-scroll-area" className="flex min-w-0 items-end gap-0.5 overflow-x-auto overflow-y-hidden">
      {tabs.map((tab) => <div
        key={tab.id}
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
          const index = tabs.findIndex((item) => item.id === tab.id);
          const target = event.key === "ArrowLeft" ? tabs[index - 1] : event.key === "ArrowRight" ? tabs[index + 1] : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1) : undefined;
          if (target) { event.preventDefault(); activate(target.id); scroll.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(target.id)}"]`)?.focus(); }
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(tab.id); }
        }}
      >
        {tab.type === "file-browser" ? <ExplorerTabIcon /> : <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-accent)]" />}
        <span className="truncate">{tab.title}</span>
        {tab.fileViewer && <ViewerDirtyIndicator path={tab.fileViewer.path} />}
        <button type="button" data-testid="tab-close" aria-label={label("关闭标签", "Close tab")} className="ml-0.5 shrink-0 rounded px-0.5 opacity-50 hover:opacity-100" onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}><X className="h-3 w-3" /></button>
      </div>)}
    </div>
    <button type="button" data-testid="explorer-tab-new-home" title={label("新建主目录标签", "New home tab")} className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-[var(--taomni-hover)]" onClick={() => {
      void openExplorer(undefined, { forceNew: true }).catch((error) => useAppStore.getState().setStatusMessage(String(error)));
    }}><Plus className="h-3.5 w-3.5" /></button>
    <div className="h-full min-w-[24px] flex-1" data-window-drag />
    {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menuItems(menu.tab)} />}
  </div>;
}
