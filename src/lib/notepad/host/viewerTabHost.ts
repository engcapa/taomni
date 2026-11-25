import { consumeDirtyCloseBypass, guardViewerClose } from "../../openFile/closeGuard";
import { documentPathKey, isUntitledKey } from "../../openFile/pathIdentity";
import { openFile, openUntitledNotepadDocument } from "../../openFile";
import { useAppStore } from "../../../stores/appStore";
import { useDocumentStore } from "../../../stores/documentStore";
import { useExplorerStore } from "../../../stores/explorerStore";
import { useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";
import { useNotepadStore } from "../../../stores/notepadStore";
import type { HostedDocRef, NotepadHostAdapter, NotepadHostContext } from "./types";

function titleFromPath(path: string): string {
  if (isUntitledKey(path)) {
    return useNotepadStore.getState().docs[documentPathKey(path)]?.titleHint ?? "Untitled";
  }
  return path.split(/[\\/]/).pop() || path;
}

export const viewerTabHost: NotepadHostAdapter = {
  async openFile(path, ctx) {
    await openFile(
      { path },
      {
        context: "global",
        host: ctx.host === "explorer" ? "explorer" : undefined,
        workspaceId: ctx.host === "workspace" ? ctx.workspaceId : undefined,
      },
    );
  },

  openUntitled(ctx, initialContent, options) {
    return openUntitledNotepadDocument({
      host: ctx.host === "explorer" ? "explorer" : "main",
      workspaceId: ctx.workspaceId,
      content: initialContent,
      title: options?.title,
      encoding: options?.encoding,
      bom: options?.bom,
      eol: options?.eol,
      dirty: options?.dirty,
    });
  },

  activateDoc(docKey, ctx) {
    const key = documentPathKey(docKey);
    if (!ctx || ctx.host === "explorer") {
      const ex = useExplorerStore.getState();
      const tab = ex.tabs.find((t) => t.fileViewer && documentPathKey(t.fileViewer.path) === key);
      if (tab) {
        ex.setActiveTab(tab.id);
        return true;
      }
    }
    if (!ctx || ctx.host === "main") {
      const app = useAppStore.getState();
      const tab = app.tabs.find((t) => t.type === "file-viewer" && t.fileViewer && documentPathKey(t.fileViewer.path) === key);
      if (tab) {
        app.setActiveTab(tab.id);
        return true;
      }
    }
    if (!ctx || ctx.host === "workspace") {
      const ws = useWorkspacePlatformStore.getState();
      const targetWsId = ctx?.workspaceId ?? ws.activeWorkspaceId;
      const space = ws.getWorkspace(targetWsId);
      const tab = space?.openTabs.find((t) => t.kind === "viewer" && t.fileViewer && documentPathKey(t.fileViewer.path) === key);
      if (tab && space) {
        ws.setActiveWorkspaceTab(space.id, tab.id);
        return true;
      }
    }
    return false;
  },

  closeDoc(docKey, ctx) {
    const key = documentPathKey(docKey);
    if (!ctx || ctx.host === "explorer") {
      const ex = useExplorerStore.getState();
      const tab = ex.tabs.find((t) => t.fileViewer && documentPathKey(t.fileViewer.path) === key);
      if (tab) {
        ex.closeTab(tab.id);
        return true;
      }
    }
    if (!ctx || ctx.host === "main") {
      const app = useAppStore.getState();
      const tab = app.tabs.find((t) => t.type === "file-viewer" && t.fileViewer && documentPathKey(t.fileViewer.path) === key);
      if (tab) {
        app.removeTab(tab.id);
        return true;
      }
    }
    if (!ctx || ctx.host === "workspace") {
      const ws = useWorkspacePlatformStore.getState();
      const targetWsId = ctx?.workspaceId ?? ws.activeWorkspaceId;
      const space = ws.getWorkspace(targetWsId);
      const tab = space?.openTabs.find((t) => t.kind === "viewer" && t.fileViewer && documentPathKey(t.fileViewer.path) === key);
      if (tab && space) {
        ws.closeWorkspaceTab(space.id, tab.id);
        return true;
      }
    }
    return false;
  },

  closeMany(docKeys, options) {
    const keySet = new Set(docKeys.map((k) => documentPathKey(k)));
    const keepPinned = options?.keepPinned !== false;
    if (!options?.host || options.host === "explorer") {
      const ex = useExplorerStore.getState();
      const ids = ex.tabs
        .filter((t) => t.fileViewer && keySet.has(documentPathKey(t.fileViewer.path)) && !(keepPinned && t.pinned))
        .map((t) => t.id);
      if (ids.length > 0) ex.closeTabs(ids);
    }
    if (!options?.host || options.host === "main") {
      const app = useAppStore.getState();
      const ids = app.tabs
        .filter((t) => t.type === "file-viewer" && t.fileViewer && keySet.has(documentPathKey(t.fileViewer.path)) && !(keepPinned && t.pinned))
        .map((t) => t.id);
      if (ids.length > 0) app.removeTabs(ids);
    }
    if (!options?.host || options.host === "workspace") {
      const ws = useWorkspacePlatformStore.getState();
      const targetWsId = options?.workspaceId ?? ws.activeWorkspaceId;
      const space = ws.getWorkspace(targetWsId);
      if (space) {
        const matched = space.openTabs.filter(
          (t) => t.kind === "viewer" && t.fileViewer && keySet.has(documentPathKey(t.fileViewer.path)),
        );
        const docs = useDocumentStore.getState().documents;
        const dirtyPaths = matched
          .map((t) => t.fileViewer!.path)
          .filter((p) => docs[documentPathKey(p)]?.dirty && !consumeDirtyCloseBypass(p));
        if (dirtyPaths.length > 0) {
          guardViewerClose(dirtyPaths, () => this.closeMany(docKeys, options));
          return;
        }
        for (const tab of matched) ws.closeWorkspaceTab(space.id, tab.id);
      }
    }
  },

  listOpenDocs(ctx) {
    const docs = useDocumentStore.getState().documents;
    const refs: HostedDocRef[] = [];
    const seen = new Set<string>();

    const pushRef = (ref: Omit<HostedDocRef, "dirty" | "untitled">) => {
      if (seen.has(ref.docKey)) return;
      seen.add(ref.docKey);
      refs.push({
        ...ref,
        untitled: isUntitledKey(ref.docKey),
        dirty: Boolean(docs[ref.docKey]?.dirty),
      });
    };

    if (!ctx?.host || ctx.host === "explorer") {
      for (const tab of useExplorerStore.getState().tabs) {
        if (tab.fileViewer) {
          const docKey = documentPathKey(tab.fileViewer.path);
          pushRef({
            tabId: tab.id,
            host: "explorer",
            docKey,
            path: tab.fileViewer.path,
            title: tab.fileViewer.title ?? tab.title ?? titleFromPath(tab.fileViewer.path),
            pinned: Boolean(tab.pinned),
          });
        }
      }
    }
    if (!ctx?.host || ctx.host === "main") {
      for (const tab of useAppStore.getState().tabs) {
        if (tab.type === "file-viewer" && tab.fileViewer) {
          const docKey = documentPathKey(tab.fileViewer.path);
          pushRef({
            tabId: tab.id,
            host: "main",
            docKey,
            path: tab.fileViewer.path,
            title: tab.fileViewer.title ?? tab.title ?? titleFromPath(tab.fileViewer.path),
            pinned: Boolean(tab.pinned),
          });
        }
      }
    }
    if (!ctx?.host || ctx.host === "workspace") {
      const ws = useWorkspacePlatformStore.getState();
      const space = ws.getWorkspace(ctx?.workspaceId ?? ws.activeWorkspaceId);
      for (const tab of space?.openTabs ?? []) {
        if (tab.kind === "viewer" && tab.fileViewer) {
          const docKey = documentPathKey(tab.fileViewer.path);
          pushRef({
            tabId: tab.id,
            host: "workspace",
            workspaceId: space?.id,
            docKey,
            path: tab.fileViewer.path,
            title: tab.fileViewer.title ?? tab.title ?? titleFromPath(tab.fileViewer.path),
            pinned: false,
          });
        }
      }
    }
    return refs;
  },

  getActiveDoc(ctx) {
    const all = this.listOpenDocs(ctx);
    const activeIds = new Set<string | null>([
      useExplorerStore.getState().activeTabId,
      useAppStore.getState().activeTabId,
    ]);
    const ws = useWorkspacePlatformStore.getState();
    const space = ws.getWorkspace(ctx?.workspaceId ?? ws.activeWorkspaceId);
    if (space?.activeTabId) activeIds.add(space.activeTabId);
    return all.find((r) => activeIds.has(r.tabId)) ?? null;
  },

  rekeyDoc(oldKey, newPath, newTitle) {
    const oldNorm = documentPathKey(oldKey);
    const newNorm = documentPathKey(newPath);
    const title = newTitle || newPath.split(/[\\/]/).pop() || newPath;

    useNotepadStore.getState().rekeyDoc(oldNorm, newNorm, title);

    useExplorerStore.setState((state) => ({
      tabs: state.tabs.map((t) =>
        t.fileViewer && documentPathKey(t.fileViewer.path) === oldNorm
          ? {
              ...t,
              title,
              fileViewer: { ...t.fileViewer, path: newPath, untitled: false, title },
            }
          : t,
      ),
    }));

    useAppStore.setState((state) => ({
      tabs: state.tabs.map((t) =>
        t.type === "file-viewer" && t.fileViewer && documentPathKey(t.fileViewer.path) === oldNorm
          ? {
              ...t,
              title,
              fileViewer: { ...t.fileViewer, path: newPath, untitled: false, title },
            }
          : t,
      ),
    }));

    useWorkspacePlatformStore.setState((state) => ({
      workspaces: state.workspaces.map((ws) => ({
        ...ws,
        openTabs: ws.openTabs.map((t) =>
          t.kind === "viewer" && t.fileViewer && documentPathKey(t.fileViewer.path) === oldNorm
            ? {
                ...t,
                title,
                fileViewer: { ...t.fileViewer, path: newPath, untitled: false, title },
              }
            : t,
        ),
      })),
    }));
  },

  pinDoc(docKey, pinned) {
    const key = documentPathKey(docKey);
    useExplorerStore.setState((state) => {
      const updated = state.tabs.map((t) => {
        if (!t.fileViewer || documentPathKey(t.fileViewer.path) !== key) return t;
        const nextPinned = pinned ?? !t.pinned;
        return { ...t, pinned: nextPinned };
      });
      const pinnedTabs = updated.filter((t) => t.pinned);
      const unpinnedTabs = updated.filter((t) => !t.pinned);
      return { tabs: [...pinnedTabs, ...unpinnedTabs] };
    });

    useAppStore.setState((state) => {
      const updated = state.tabs.map((t) => {
        if (t.type !== "file-viewer" || !t.fileViewer || documentPathKey(t.fileViewer.path) !== key) return t;
        const nextPinned = pinned ?? !t.pinned;
        return { ...t, pinned: nextPinned };
      });
      return { tabs: updated };
    });
  },
};

export function createHostContext(host?: "explorer", workspaceId?: string): NotepadHostContext {
  if (host === "explorer") return { host: "explorer" };
  if (workspaceId) return { host: "workspace", workspaceId };
  return { host: "main" };
}
