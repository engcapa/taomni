import { useAppStore } from "../../stores/appStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { useDocumentStore } from "../../stores/documentStore";
import { explorerCanonicalPath } from "../explorer";
import { basename, sftpOpenPath } from "../sftp";
import { openPlatformCodeWorkspace } from "../openPlatformCodeWorkspace";
import { classifyFile, fileExtension, supportsFileViewer } from "./classifyFile";
import { useFileOpenPreferences } from "./preferences";
import { documentPathKey } from "./pathIdentity";
import type { FileViewerTabInfo } from "../../types";
import { activateCodeDocument, removeCleanViewerTabs } from "./codeDocumentOwner";
import { readViewerDrafts } from "../../stores/viewerDrafts";

export { classifyFile, fileExtension, supportsFileViewer } from "./classifyFile";
export type { FileKind } from "./classifyFile";
export interface OpenFileTarget {
  path: string;
  source?: "local" | "remote-temp" | "mail-attachment";
  readOnlyReason?: string;
}
export interface OpenFileOptions {
  context: string;
  workspaceId?: string;
  mode?: "taomni" | "workspace" | "system" | "source";
  line?: number;
  alternate?: boolean;
}
const opening = new Map<string, Promise<string | void>>();

function activateMain(id: string): string {
  const app = useAppStore.getState();
  app.clearTabFilter();
  app.setActiveSideTab("sessions");
  app.setActiveTab(id);
  return id;
}
function existingViewer(key: string, workspaceId?: string): string | undefined {
  if (workspaceId) {
    const store = useWorkspacePlatformStore.getState();
    const tab = store.getWorkspace(workspaceId)?.openTabs.find((item) => item.kind === "viewer" && item.fileViewer && documentPathKey(item.fileViewer.path) === key);
    if (!tab) return;
    store.setActiveWorkspace(workspaceId);
    store.setActiveWorkspaceTab(workspaceId, tab.id);
    useAppStore.getState().setActiveSideTab("workspaces");
    return tab.id;
  }
  const tab = useAppStore.getState().tabs.find((item) => item.type === "file-viewer" && item.fileViewer && documentPathKey(item.fileViewer.path) === key);
  if (tab) return activateMain(tab.id);
}

function codeOwner(path: string): { workspaceId: string; rootId: string; relative: string } | undefined {
  const key = documentPathKey(path);
  for (const workspace of useWorkspacePlatformStore.getState().workspaces) {
    for (const root of workspace.rootFolders) {
      const rootKey = documentPathKey(root.path);
      if (key.startsWith(`${rootKey}/`)) return { workspaceId: workspace.id, rootId: root.id, relative: path.replace(/\\/g, "/").slice(root.path.replace(/\\/g, "/").replace(/\/+$/, "").length + 1) };
    }
  }
}
function openCode(path: string, workspaceId?: string): string {
  const owner = codeOwner(path);
  if (owner && (!workspaceId || owner.workspaceId === workspaceId)) {
    const store = useWorkspacePlatformStore.getState();
    store.setActiveWorkspace(owner.workspaceId);
    const tab = store.openFileInWorkspace(owner.workspaceId, { rootId: owner.rootId, path: owner.relative });
    useAppStore.getState().setActiveSideTab("workspaces");
    return tab.id;
  }
  const id = `loose-${documentPathKey(path)}`;
  return openPlatformCodeWorkspace({ repoRoot: "", name: basename(path), looseFiles: [{ id, name: basename(path), path }],
    initialFile: { kind: "loose", id, path } });
}

export function openFile(target: OpenFileTarget | string, options: OpenFileOptions = { context: "global" }): Promise<string | void> {
  const input: OpenFileTarget = typeof target === "string" ? { path: target } : target;
  if (!input.path.trim()) return Promise.reject(new Error("not_found: File path is empty"));
  const scope = options.workspaceId ?? "main";
  // Scope serialization also deduplicates concurrent symlink/case aliases after
  // asynchronous canonicalization has resolved them to the same identity.
  const queueKey = scope;
  const previous = opening.get(queueKey) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(async () => {
    let path = input.path;
    try { path = await explorerCanonicalPath(path); } catch { /* Missing paths still have a recoverable viewer error state. */ }
    const kind = classifyFile(input.path);
    const preferences = useFileOpenPreferences.getState();
    let mode = options.mode ?? preferences.associations[fileExtension(input.path)] ?? preferences.defaultHandler;
    if (options.alternate) mode = mode === "system" ? "taomni" : "system";
    if (mode === "system" || (!supportsFileViewer(kind) && kind !== "source")) return sftpOpenPath(path);
    const key = documentPathKey(path);
    const readOnlyReason = input.readOnlyReason ?? (input.source && input.source !== "local" ? "只读副本 / Read-only copy" : undefined);
    // A remote copy must never enter the independent source editor as writable.
    if (!readOnlyReason && (mode === "workspace" || kind === "source")) {
      if (!useDocumentStore.getState().documents[key] && readViewerDrafts()[key]) {
        await useDocumentStore.getState().open(path);
      }
      const dirty = useDocumentStore.getState().documents[key];
      if (dirty?.dirty) {
        const activated = existingViewer(key, options.workspaceId) ?? existingViewer(key);
        if (activated) return activated;
        // A recovered draft can exist before any viewer host mounts. Show its
        // recoverable shared document rather than silently choosing disk text.
        mode = "taomni";
      } else {
        removeCleanViewerTabs(path);
        return activateCodeDocument(path) ?? openCode(path, options.workspaceId);
      }
    }
    if (!readOnlyReason && !useDocumentStore.getState().documents[key]?.dirty) {
      const code = activateCodeDocument(path);
      if (code) return code;
    }
    const existing = existingViewer(key, options.workspaceId);
    if (existing) {
      if (options.mode === "source" || options.mode === "taomni") {
        const nextMode = options.mode;
        if (options.workspaceId) useWorkspacePlatformStore.setState((state) => ({ workspaces: state.workspaces.map((workspace) => workspace.id === options.workspaceId
          ? { ...workspace, openTabs: workspace.openTabs.map((tab) => tab.id === existing && tab.fileViewer ? { ...tab, fileViewer: { ...tab.fileViewer, mode: nextMode } } : tab) } : workspace) }));
        else useAppStore.setState((state) => ({ tabs: state.tabs.map((tab) => tab.id === existing && tab.fileViewer ? { ...tab, fileViewer: { ...tab.fileViewer, mode: nextMode } } : tab) }));
      }
      return existing;
    }
    const viewer: FileViewerTabInfo = { path, kind: readOnlyReason && kind === "source" ? "text" : kind,
      mode: mode === "source" ? "source" : "taomni", readOnlyReason, source: input.source ?? "local" };
    if (options.workspaceId) {
      const store = useWorkspacePlatformStore.getState();
      store.setActiveWorkspace(options.workspaceId);
      const tab = store.openViewerTab(options.workspaceId, viewer);
      useAppStore.getState().setActiveSideTab("workspaces");
      return tab.id;
    }
    const id = `viewer-${crypto.randomUUID()}`;
    useAppStore.getState().addTab({ id, type: "file-viewer", title: basename(path), closable: true, fileViewer: viewer });
    return activateMain(id);
  });
  opening.set(queueKey, result);
  void result.finally(() => { if (opening.get(queueKey) === result) opening.delete(queueKey); }).catch(() => {});
  return result;
}
