import { FolderOpen, Home, Plus } from "lucide-react";
import { openExplorer } from "../../lib/explorer/openExplorer";
import { useExplorerStore } from "../../stores/explorerStore";
import { useAppStore } from "../../stores/appStore";
import { useExplorerLabels } from "./explorerLabels";
import { useExplorerPreferences } from "./explorerPreferences";

export function ExplorerSidebarPanel() {
  const label = useExplorerLabels();
  const tabs = useExplorerStore((state) => state.tabs);
  const activeTabId = useExplorerStore((state) => state.activeTabId);
  const setActiveTab = useExplorerStore((state) => state.setActiveTab);
  const preferences = useExplorerPreferences();
  const open = (path?: string) => {
    void openExplorer(path).catch((error) => useAppStore.getState().setStatusMessage(String(error)));
  };
  return <div data-testid="explorer-sidebar-panel" className="flex min-h-0 flex-1 flex-col">
    <div className="flex h-7 shrink-0 items-center gap-1.5 border-b px-2 font-semibold text-[var(--taomni-text)]" style={{ borderColor: "var(--taomni-divider)", fontSize: "var(--taomni-ui-font-size)" }}>
      <FolderOpen className="h-3.5 w-3.5" />{label("文件浏览器", "File Explorer")}
    </div>
    <div className="flex shrink-0 gap-1 p-2">
      <button type="button" data-testid="sidebar-explorer-home" className="taomni-btn inline-flex h-7 items-center gap-1 px-2" onClick={() => open()}><Home className="h-3.5 w-3.5" />{label("主目录", "Home")}</button>
      <button type="button" data-testid="sidebar-explorer-new-tab" className="taomni-btn inline-flex h-7 w-7 items-center justify-center" title={label("新建主目录标签", "New home tab")} onClick={() => {
        void openExplorer(undefined, { forceNew: true }).catch((error) => useAppStore.getState().setStatusMessage(String(error)));
      }}><Plus className="h-3.5 w-3.5" /></button>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
      {preferences.pinnedPaths.length > 0 && <div className="px-1 py-1 text-[10px] font-semibold uppercase text-[var(--taomni-text-muted)]">{label("快速访问", "Quick access")}</div>}
      {preferences.pinnedPaths.map((path) => <button key={path} type="button" data-testid="sidebar-explorer-pinned" data-path={path} className="w-full truncate rounded px-2 py-1.5 text-left text-[12px] text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)]" title={path} onClick={() => open(path)}>{path}</button>)}
      <div className="px-1 py-1 text-[10px] font-semibold uppercase text-[var(--taomni-text-muted)]">{label("打开的文件夹", "Open folders")}</div>
      {tabs.filter((tab) => tab.type === "file-browser" && tab.fileBrowser).map((tab) => <button
        key={tab.id}
        type="button"
        data-testid="sidebar-explorer-tab"
        data-tab-id={tab.id}
        data-active={activeTabId === tab.id || undefined}
        className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[12px] text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)] data-[active=true]:bg-[var(--taomni-selected)]"
        title={tab.fileBrowser!.initialPath}
        onClick={() => setActiveTab(tab.id)}
      ><FolderOpen className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-warning,#d97706)]" /><span className="truncate">{tab.title}</span></button>)}
    </div>
  </div>;
}
