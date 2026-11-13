import { useAppStore } from "../../stores/appStore";
import { useSftpStore } from "../../stores/sftpStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { explorerCanonicalPath } from "../explorer";
import { basename, sftpLocalHome } from "../sftp";

export interface OpenExplorerOptions {
  workspaceId?: string;
  forceNew?: boolean;
}

// Scope-local serialization also covers opens made before a newly created pane
// finishes attaching. Two simultaneous menu activations cannot create duplicates.
const opening = new Map<string, Promise<unknown>>();

/** Lexical Windows spelling is only a fallback; native canonicalization decides
 * aliases and actual macOS volume case behavior without lowercasing Unix paths. */
export function explorerPathKey(path: string): string {
  if (/^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(path)) {
    return path.replace(/^\\\\\?\\UNC\\/i, "//").replace(/^\\\\\?\\/, "")
      .replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }
  return path.replace(/\/+$/, "") || "/";
}

async function canonicalKey(path: string): Promise<string> {
  try {
    return explorerPathKey(await explorerCanonicalPath(path));
  } catch {
    // Nonexistent/unreadable paths still open an error/recovery pane. A failed
    // canonical lookup must not prevent users from seeing its concrete error.
    return explorerPathKey(path);
  }
}

function activateMainExplorer(id: string): void {
  const app = useAppStore.getState();
  app.clearTabFilter();
  // Tools keeps its selected rail/list. All other non-main canvases (including
  // the Notes workspace) must yield to the main Sessions canvas before focus.
  if (app.activeSideTab !== "tools" && app.activeSideTab !== "sessions") app.setActiveSideTab("sessions");
  app.setActiveTab(id);
}

export function openExplorer(path?: string, options: OpenExplorerOptions = {}): Promise<string> {
  const scope = options.workspaceId ?? "main";
  const previous = opening.get(scope) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(async () => {
    const target = path?.trim() || await sftpLocalHome();
    const key = await canonicalKey(target);
    const currentPath = (id: string, initial: string) => useSftpStore.getState().sessions[id]?.local.path || initial;
    if (options.workspaceId) {
      const workspaceId = options.workspaceId;
      const store = useWorkspacePlatformStore.getState();
      const workspace = store.getWorkspace(workspaceId);
      if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
      if (!options.forceNew) {
        for (const tab of workspace.openTabs) {
          if (tab.kind !== "explorer") continue;
          const candidate = currentPath(tab.id, tab.explorerPath ?? "");
          if (await canonicalKey(candidate) !== key) continue;
          const live = useWorkspacePlatformStore.getState().getWorkspace(workspaceId)?.openTabs.find((item) => item.id === tab.id);
          if (!live || currentPath(live.id, live.explorerPath ?? "") !== candidate) continue;
          useWorkspacePlatformStore.getState().setActiveWorkspace(workspaceId);
          useWorkspacePlatformStore.getState().setActiveWorkspaceTab(workspaceId, tab.id);
          useAppStore.getState().setActiveSideTab("workspaces");
          return tab.id;
        }
      }
      const tab = useWorkspacePlatformStore.getState().addExplorerTab(workspaceId, target);
      useAppStore.getState().setActiveSideTab("workspaces");
      return tab.id;
    }
    if (!options.forceNew) {
      for (const tab of useAppStore.getState().tabs) {
        if (tab.type !== "file-browser" || !tab.fileBrowser) continue;
        const candidate = currentPath(tab.id, tab.fileBrowser.initialPath);
        if (await canonicalKey(candidate) !== key) continue;
        const live = useAppStore.getState().tabs.find((item) => item.id === tab.id);
        if (!live?.fileBrowser || currentPath(live.id, live.fileBrowser.initialPath) !== candidate) continue;
        activateMainExplorer(tab.id);
        return tab.id;
      }
    }
    const id = `explorer-${crypto.randomUUID()}`;
    useAppStore.getState().addTab({ id, type: "file-browser", title: basename(target) || target,
      closable: true, fileBrowser: { initialPath: target, explorer: true } });
    activateMainExplorer(id);
    return id;
  });
  opening.set(scope, result);
  void result.finally(() => { if (opening.get(scope) === result) opening.delete(scope); }).catch(() => undefined);
  return result;
}
