import { useAppStore } from "../../stores/appStore";
import { useExplorerStore } from "../../stores/explorerStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { useDocumentStore } from "../../stores/documentStore";
import { useNotepadPreferences } from "../../stores/notepadPreferences";
import { nextUntitledName, useNotepadStore } from "../../stores/notepadStore";
import { useRecentFilesStore } from "../../stores/app/recentFiles";
import { explorerCanonicalPath } from "../explorer";
import { basename, sftpOpenPath } from "../sftp";
import { openPlatformCodeWorkspace } from "../openPlatformCodeWorkspace";
import { classifyFile, fileExtension, supportsFileViewer } from "./classifyFile";
import { getFileHandler, UnavailableFileHandlerError } from "./handlers";
import { useFileOpenPreferences } from "./preferences";
import { documentPathKey, UNTITLED_KEY_PREFIX } from "./pathIdentity";
import type { FileViewerTabInfo } from "../../types";
import { activateCodeDocument, removeCleanViewerTabs } from "./codeDocumentOwner";
import { readViewerDrafts } from "../../stores/viewerDrafts";

export { classifyFile, fileExtension, supportsFileViewer } from "./classifyFile";
export type { FileKind } from "./classifyFile";
export {
  getFileHandler,
  isHandlerAvailable,
  isOfficeExtension,
  listFileHandlers,
  OFFICE_EXTENSIONS,
  registerFileHandler,
  UnavailableFileHandlerError,
} from "./handlers";
export interface OpenFileTarget {
  path: string;
  source?: "local" | "remote-temp" | "mail-attachment";
  readOnlyReason?: string;
}
export type OpenFileMode = "taomni" | "notepad" | "workspace" | "system" | "source" | "taoffice";
export interface OpenFileOptions {
  context: string;
  workspaceId?: string;
  mode?: OpenFileMode;
  line?: number;
  alternate?: boolean;
  host?: "explorer";
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

function collectOpenNotepadTitles(): string[] {
  const titles: string[] = [];
  for (const tab of useExplorerStore.getState().tabs) {
    if (tab.type === "file-viewer") titles.push(tab.title);
  }
  for (const tab of useAppStore.getState().tabs) {
    if (tab.type === "file-viewer") titles.push(tab.title);
  }
  for (const doc of Object.values(useNotepadStore.getState().docs)) {
    if (doc.titleHint) titles.push(doc.titleHint);
  }
  return titles;
}

/** Create a brand-new untitled Notepad document tab in the active or requested host. */
export function openUntitledNotepadDocument(options: {
  host?: "explorer" | "main";
  workspaceId?: string;
  docId?: string;
  title?: string;
  content?: string;
  encoding?: string;
  bom?: boolean;
  eol?: "LF" | "CRLF" | "CR";
  dirty?: boolean;
} = {}): string {
  const docId = options.docId ?? `${UNTITLED_KEY_PREFIX}${crypto.randomUUID()}`;
  const prefs = useNotepadPreferences.getState();
  const title = options.title ?? nextUntitledName(prefs.untitledPattern, collectOpenNotepadTitles());
  useDocumentStore.getState().createUntitled(docId, {
    content: options.content ?? "",
    encoding: options.encoding ?? prefs.defaultEncoding,
    bom: options.bom ?? prefs.defaultEncoding.toUpperCase().includes("BOM"),
    eol: options.eol ?? prefs.defaultEol,
    dirty: options.dirty,
  });
  useNotepadStore.getState().ensureDoc(docId, title);
  const viewer: FileViewerTabInfo = {
    path: docId,
    kind: "text",
    mode: "notepad",
    source: "local",
    untitled: true,
    title,
  };
  const useExplorer = options.host === "explorer" || (!options.workspaceId && useAppStore.getState().activeSideTab === "explorer");
  if (useExplorer) {
    const id = `explorer-viewer-${crypto.randomUUID()}`;
    useExplorerStore.getState().openTab({ id, type: "file-viewer", title, closable: true, fileViewer: viewer }, true);
    useAppStore.getState().setActiveSideTab("explorer");
    return docId;
  }
  if (options.workspaceId) {
    const store = useWorkspacePlatformStore.getState();
    store.setActiveWorkspace(options.workspaceId);
    store.openViewerTab(options.workspaceId, viewer);
    useAppStore.getState().setActiveSideTab("workspaces");
    return docId;
  }
  const app = useAppStore.getState();
  const activeIndex = app.tabs.findIndex((tab) => tab.id === app.activeTabId);
  const id = `viewer-${crypto.randomUUID()}`;
  app.addTab({ id, type: "file-viewer", title, closable: true, fileViewer: viewer });
  if (activeIndex >= 0) app.moveTabToIndex(id, activeIndex + 1);
  activateMain(id);
  return docId;
}

export function openFile(target: OpenFileTarget | string, options: OpenFileOptions = { context: "global" }): Promise<string | void> {
  const input: OpenFileTarget = typeof target === "string" ? { path: target } : target;
  if (!input.path.trim()) return Promise.reject(new Error("not_found: File path is empty"));
  const scope = options.workspaceId ?? "main";
  const queueKey = scope;
  const previous = opening.get(queueKey) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(async () => {
    let path = input.path;
    try { path = await explorerCanonicalPath(path); } catch { /* Missing paths still have a recoverable viewer error state. */ }
    const kind = classifyFile(input.path);
    const preferences = useFileOpenPreferences.getState();
    let mode: OpenFileMode = options.mode ?? preferences.associations[fileExtension(input.path)] ?? preferences.defaultHandler;
    if (options.alternate) mode = mode === "system" ? "taomni" : "system";

    const descriptor = mode === "source" ? getFileHandler("notepad") : getFileHandler(mode);
    if (descriptor && !descriptor.available()) {
      throw new UnavailableFileHandlerError(descriptor.id, descriptor.labelEn, path);
    }

    const explicitNotepad = mode === "notepad" || mode === "source";
    if (mode === "system" || (!explicitNotepad && !supportsFileViewer(kind) && kind !== "source")) {
      return sftpOpenPath(path);
    }

    const key = documentPathKey(path);
    const readOnlyReason = input.readOnlyReason ?? (input.source && input.source !== "local" ? "只读副本 / Read-only copy" : undefined);
    const resolvedViewerMode: FileViewerTabInfo["mode"] = mode === "source" ? "source" : mode === "notepad" ? "notepad" : "taomni";
    const explorerHost = options.host === "explorer" || (!options.workspaceId && useAppStore.getState().activeSideTab === "explorer");
    if (explorerHost && (mode !== "workspace" || !options.mode)) {
      const explorer = useExplorerStore.getState();
      const existing = explorer.tabs.find((tab) => tab.type === "file-viewer" && tab.fileViewer && documentPathKey(tab.fileViewer.path) === key);
      if (existing) {
        if (options.mode === "source" || options.mode === "taomni" || options.mode === "notepad") {
          explorer.updateViewerMode(existing.id, options.mode === "source" ? "source" : options.mode === "notepad" ? "notepad" : "taomni");
        }
        explorer.setActiveTab(existing.id);
        useAppStore.getState().setActiveSideTab("explorer");
        if (!readOnlyReason) useRecentFilesStore.getState().recordRecent(path);
        return existing.id;
      }
      const id = `explorer-viewer-${crypto.randomUUID()}`;
      const viewer: FileViewerTabInfo = {
        path,
        kind: (readOnlyReason && kind === "source") || mode === "notepad" ? "text" : kind,
        mode: resolvedViewerMode,
        readOnlyReason,
        source: input.source ?? "local",
      };
      explorer.openTab({ id, type: "file-viewer", title: basename(path), closable: true, fileViewer: viewer }, true);
      useAppStore.getState().setActiveSideTab("explorer");
      if (!readOnlyReason) useRecentFilesStore.getState().recordRecent(path);
      return id;
    }
    if (options.context === "terminal-link") {
      const linked = existingViewer(key, options.workspaceId) ?? existingViewer(key);
      if (linked) return linked;
    }
    if (!readOnlyReason && (mode === "workspace" || (kind === "source" && !explicitNotepad))) {
      if (!useDocumentStore.getState().documents[key] && readViewerDrafts()[key]) {
        await useDocumentStore.getState().open(path);
      }
      const dirty = useDocumentStore.getState().documents[key];
      if (dirty?.dirty) {
        const activated = existingViewer(key, options.workspaceId) ?? existingViewer(key);
        if (activated) return activated;
        mode = "taomni";
      } else {
        removeCleanViewerTabs(path);
        return activateCodeDocument(path) ?? openCode(path, options.workspaceId);
      }
    }
    if (!readOnlyReason && !useDocumentStore.getState().documents[key]?.dirty && !explicitNotepad) {
      const code = activateCodeDocument(path);
      if (code) return code;
    }
    const existing = existingViewer(key, options.workspaceId);
    if (existing) {
      if (options.mode === "source" || options.mode === "taomni" || options.mode === "notepad") {
        const nextMode: FileViewerTabInfo["mode"] = options.mode === "source" ? "source" : options.mode === "notepad" ? "notepad" : "taomni";
        if (options.workspaceId) useWorkspacePlatformStore.setState((state) => ({ workspaces: state.workspaces.map((workspace) => workspace.id === options.workspaceId
          ? { ...workspace, openTabs: workspace.openTabs.map((tab) => tab.id === existing && tab.fileViewer ? { ...tab, fileViewer: { ...tab.fileViewer, mode: nextMode } } : tab) } : workspace) }));
        else useAppStore.setState((state) => ({ tabs: state.tabs.map((tab) => tab.id === existing && tab.fileViewer ? { ...tab, fileViewer: { ...tab.fileViewer, mode: nextMode } } : tab) }));
      }
      if (!readOnlyReason) useRecentFilesStore.getState().recordRecent(path);
      return existing;
    }
    const viewer: FileViewerTabInfo = {
      path,
      kind: (readOnlyReason && kind === "source") || mode === "notepad" ? "text" : kind,
      mode: mode === "source" ? "source" : mode === "notepad" ? "notepad" : "taomni",
      readOnlyReason,
      source: input.source ?? "local",
    };
    if (options.workspaceId) {
      const store = useWorkspacePlatformStore.getState();
      store.setActiveWorkspace(options.workspaceId);
      const tab = store.openViewerTab(options.workspaceId, viewer);
      useAppStore.getState().setActiveSideTab("workspaces");
      if (!readOnlyReason) useRecentFilesStore.getState().recordRecent(path);
      return tab.id;
    }
    const app = useAppStore.getState();
    const activeIndex = app.tabs.findIndex((tab) => tab.id === app.activeTabId);
    const id = `viewer-${crypto.randomUUID()}`;
    app.addTab({ id, type: "file-viewer", title: basename(path), closable: true, fileViewer: viewer });
    if (activeIndex >= 0) useAppStore.getState().moveTabToIndex(id, activeIndex + 1);
    if (!readOnlyReason) useRecentFilesStore.getState().recordRecent(path);
    return activateMain(id);
  });
  opening.set(queueKey, result);
  void result.finally(() => { if (opening.get(queueKey) === result) opening.delete(queueKey); }).catch(() => {});
  return result;
}
