import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { openExplorer } from "../../lib/explorer/openExplorer";
import { useExplorerStore } from "../../stores/explorerStore";
import { ViewerShell } from "../viewer/ViewerShell";
import { ViewerCloseDialog } from "../viewer/ViewerDialogs";
import { ExplorerTabPane } from "./ExplorerTabPane";
import { useExplorerLabels } from "./explorerLabels";

export function ExplorerPlatformView({ visible, onOpenTerminal }: {
  visible: boolean;
  onOpenTerminal: (path: string) => void;
}) {
  const tabs = useExplorerStore((state) => state.tabs);
  const activeTabId = useExplorerStore((state) => state.activeTabId);
  const [started, setStarted] = useState(visible);
  const label = useExplorerLabels();
  useEffect(() => { if (visible) setStarted(true); }, [visible]);
  if (!started && !visible) return null;
  return <div data-testid="explorer-platform-view" className="relative min-h-0 min-w-0 flex-1" style={{ display: visible ? "block" : "none" }}>
    <ViewerCloseDialog />
    {tabs.map((tab) => <div key={tab.id} className="absolute inset-0" style={{ display: activeTabId === tab.id ? "block" : "none" }}>
      {tab.type === "file-browser" && tab.fileBrowser && <ExplorerTabPane
        tabId={tab.id}
        initialPath={tab.fileBrowser.initialPath}
        active={visible && activeTabId === tab.id}
        onOpenTerminal={onOpenTerminal}
      />}
      {tab.type === "file-viewer" && tab.fileViewer && <ViewerShell
        viewer={tab.fileViewer}
        active={visible && activeTabId === tab.id}
        host="explorer"
      />}
    </div>)}
    {!tabs.length && <div data-testid="explorer-empty-state" className="flex h-full flex-col items-center justify-center gap-3 text-[var(--taomni-text-muted)]">
      <FolderOpen className="h-8 w-8" />
      <span>{label("在独立工作区中浏览和编辑本地文件。", "Browse and edit local files in the dedicated workspace.")}</span>
      <button type="button" className="taomni-btn" data-testid="explorer-open-home" onClick={() => { void openExplorer(); }}>
        {label("打开主目录", "Open home directory")}
      </button>
    </div>}
  </div>;
}
