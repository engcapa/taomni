import { useAppStore } from "../../stores/appStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { documentPathKey } from "./pathIdentity";
import { workspaceEditorRuntimeId } from "../workspaceRuntimeIdentity";
import type { CodeWorkspaceFileContext } from "../../stores/app/types";
import { workspaceFileTabRef } from "../workspaceFileTarget";

/** The full IDE remains the single editable owner of explicitly opened source
 * buffers. Lightweight viewers yield instead of making a second dirty draft. */
export function activateCodeDocument(path: string): string | undefined {
  const key = documentPathKey(path);
  const app = useAppStore.getState();
  const platform = useWorkspacePlatformStore.getState();
  for (const workspace of platform.workspaces) {
    const match = workspace.openTabs.find((tab) => {
      if (tab.kind !== "file") return false;
      const ref = workspaceFileTabRef(tab);
      const root = ref?.kind === "root" ? workspace.rootFolders.find((folder) => folder.id === ref.rootId) : undefined;
      const full = ref?.kind === "loose" ? ref.path : root && ref ? `${root.path.replace(/[\\/]$/, "")}/${ref.path}` : undefined;
      return full && documentPathKey(full) === key;
    });
    const context = app.codeWorkspaceByTab[workspaceEditorRuntimeId(workspace)];
    const matchesContext = (ref: CodeWorkspaceFileContext) => documentPathKey(ref.kind === "loose" ? ref.path
      : `${ref.rootPath ?? context?.roots?.find((root) => root.id === ref.rootId)?.path ?? ""}/${ref.path}`) === key;
    const contextFile = context?.openFiles?.find(matchesContext);
    if (!match && !contextFile) continue;
    platform.setActiveWorkspace(workspace.id);
    let tabId = match?.id;
    if (match) platform.setActiveWorkspaceTab(workspace.id, match.id);
    else if (contextFile?.kind === "root") {
      tabId = platform.openFileInWorkspace(workspace.id, { rootId: contextFile.rootId, path: contextFile.path }).id;
    } else if (contextFile?.kind === "loose") {
      const files = workspace.openTabs.flatMap((tab) => { const ref = workspaceFileTabRef(tab); return ref ? [{ ref, title: tab.title }] : []; });
      const ref = { kind: "loose" as const, id: contextFile.id, path: contextFile.path };
      files.push({ ref, title: contextFile.name ?? path.split(/[\\/]/).pop() ?? path });
      platform.syncWorkspaceFiles(workspace.id, files, ref);
      tabId = platform.getWorkspace(workspace.id)?.activeTabId;
    }
    app.setActiveSideTab("workspaces");
    return tabId ?? workspace.id;
  }
  return undefined;
}

export function removeCleanViewerTabs(path: string): void {
  const key = documentPathKey(path);
  const app = useAppStore.getState();
  const ids = app.tabs.filter((tab) => tab.fileViewer && documentPathKey(tab.fileViewer.path) === key).map((tab) => tab.id);
  if (ids.length) app.removeTabs(ids);
  const platform = useWorkspacePlatformStore.getState();
  for (const workspace of platform.workspaces) for (const tab of workspace.openTabs) {
    if (tab.fileViewer && documentPathKey(tab.fileViewer.path) === key) platform.closeWorkspaceTab(workspace.id, tab.id);
  }
}
