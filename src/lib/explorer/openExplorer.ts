import { useAppStore } from "../../stores/appStore";
import { useExplorerStore } from "../../stores/explorerStore";
import { useSftpStore } from "../../stores/sftpStore";
import { explorerCanonicalPath } from "../explorer";
import { basename, sftpLocalHome } from "../sftp";

export interface OpenExplorerOptions {
  /** Retained for call-site compatibility; every new Explorer opens in the dedicated surface. */
  workspaceId?: string;
  forceNew?: boolean;
  title?: string;
  sessionId?: string;
}

const opening = new Map<string, Promise<unknown>>();

/** Lexical Windows spelling is only a fallback; native canonicalization decides
 * aliases and actual macOS volume case behavior without lowercasing Unix paths. */
export { documentPathKey as explorerPathKey } from "../openFile/pathIdentity";
import { documentPathKey as explorerPathKey } from "../openFile/pathIdentity";

async function canonicalKey(path: string): Promise<string> {
  try {
    return explorerPathKey(await explorerCanonicalPath(path));
  } catch {
    return explorerPathKey(path);
  }
}

function activateExplorer(id: string): void {
  const app = useAppStore.getState();
  app.clearTabFilter();
  app.setActiveSideTab("explorer");
  app.setSidebarCollapsed(false);
  useExplorerStore.getState().setActiveTab(id);
}

function migrateLegacyTabs(): void {
  const app = useAppStore.getState();
  const legacy = app.tabs.filter((tab) => tab.type === "file-browser" && tab.fileBrowser);
  if (!legacy.length) return;
  const explorer = useExplorerStore.getState();
  const ids = new Set(explorer.tabs.map((tab) => tab.id));
  useExplorerStore.setState({
    tabs: [...explorer.tabs, ...legacy.filter((tab) => !ids.has(tab.id))],
    activeTabId: explorer.activeTabId ?? legacy[0].id,
  });
  useAppStore.setState({ tabs: app.tabs.filter((tab) => tab.type !== "file-browser") });
}

export function openExplorer(path?: string, options: OpenExplorerOptions = {}): Promise<string> {
  const previous = opening.get("explorer") ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(async () => {
    migrateLegacyTabs();
    const target = path?.trim() || await sftpLocalHome();
    const key = await canonicalKey(target);
    const currentPath = (id: string, initial: string) => useSftpStore.getState().sessions[id]?.local.path || initial;
    if (!options.forceNew) {
      for (const tab of useExplorerStore.getState().tabs) {
        if (tab.type !== "file-browser" || !tab.fileBrowser) continue;
        const candidate = currentPath(tab.id, tab.fileBrowser.initialPath);
        if (await canonicalKey(candidate) !== key) continue;
        const live = useExplorerStore.getState().tabs.find((item) => item.id === tab.id);
        if (!live?.fileBrowser || currentPath(live.id, live.fileBrowser.initialPath) !== candidate) continue;
        activateExplorer(tab.id);
        return tab.id;
      }
    }
    const id = `explorer-${crypto.randomUUID()}`;
    useExplorerStore.getState().openTab({
      id,
      type: "file-browser",
      title: options.title || basename(target) || target,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      closable: true,
      fileBrowser: { initialPath: target, explorer: true },
    });
    activateExplorer(id);
    return id;
  });
  opening.set("explorer", result);
  void result.finally(() => { if (opening.get("explorer") === result) opening.delete("explorer"); }).catch(() => undefined);
  return result;
}
