import type { CodeWorkspaceFileRef, CodeWorkspaceTabInfo } from "../types";
import type { WorkspaceIsolatedTab } from "../stores/workspacePlatformStore";

/** A file tab references the editor's document identity, including provider URIs. */
export interface WorkspaceFileTarget {
  ref: CodeWorkspaceFileRef;
  title?: string;
  /** Provider buffers can only be reopened by their live language-server owner. */
  transient?: boolean;
}

export function workspaceFileTabId(workspaceId: string, ref: CodeWorkspaceFileRef): string {
  return ref.kind === "root" ? `ws:${workspaceId}:file:${ref.rootId}:${ref.path}`
    : `ws:${workspaceId}:loose:${ref.id}`;
}

export function workspaceFileTabRef(tab: WorkspaceIsolatedTab | undefined): CodeWorkspaceFileRef | null {
  if (tab?.kind !== "file") return null;
  return tab.editorFile ?? (tab.rootFolderId && tab.filePath
    ? { kind: "root", rootId: tab.rootFolderId, path: tab.filePath } : null);
}

/** Provider refs have no durable loose-file registration, even after tab close. */
export function workspaceDurableCodeDefinition(info: CodeWorkspaceTabInfo | undefined): CodeWorkspaceTabInfo | undefined {
  const ref = info?.initialFile;
  return ref?.kind === "loose" && !info?.looseFiles?.some((file) => file.id === ref.id && file.path === ref.path)
    ? { ...info!, initialFile: null } : info;
}
