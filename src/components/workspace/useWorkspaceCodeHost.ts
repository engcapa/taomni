import { useCallback, useEffect, useMemo, useRef } from "react";
import { fileKey } from "../editor/workspace/codeWorkspaceModel";
import type { WorkspaceFileMenu, WorkspaceHostIntegration, WorkspaceHostSnapshot } from "../editor/workspace/workspaceHostIntegration";
import { useWorkspaceEditorHostStore } from "../../stores/workspaceEditorHostStore";
import { languageFromPath, useWorkspaceEditorStore } from "../../stores/workspaceEditorStore";
import { useWorkspacePlatformStore, type PlatformWorkspace } from "../../stores/workspacePlatformStore";
import type { CodeWorkspaceFileRef } from "../../types";
import { useAppStore } from "../../stores/appStore";
import { useT } from "../../lib/i18n";
import { GitBranch, MonitorSmartphone } from "lucide-react";
import { createElement } from "react";
import { useWorkspaceUiStore } from "../../stores/workspaceUiStore";

export { workspaceEditorRuntimeId } from "../../lib/workspaceRuntimeIdentity";

export function usesSharedWorkspaceEditor(workspace: PlatformWorkspace): boolean {
  return workspace.rootFolders.length > 0 || workspace.openTabs.some((tab) => tab.kind === "file");
}

/** Adapt the platform's file tabs to the editor's existing buffer owner. */
export function useWorkspaceCodeHost(workspace: PlatformWorkspace, visible: boolean, enabled: boolean): WorkspaceHostIntegration | undefined {
  const t = useT();
  const leftToolAreaHost = useWorkspaceEditorHostStore((state) => state.hosts[workspace.id] ?? null);
  const workspaceMode = useAppStore((state) => state.activeSideTab === "workspaces");
  const selectedWorkspace = useWorkspacePlatformStore((state) => state.activeWorkspaceId === workspace.id);
  const active = workspaceMode && selectedWorkspace;
  const previousRootCount = useRef(workspace.rootFolders.length);
  useEffect(() => {
    const firstFolderAdded = previousRootCount.current === 0 && workspace.rootFolders.length > 0;
    previousRootCount.current = workspace.rootFolders.length;
    if (firstFolderAdded && active) {
      useWorkspacePlatformStore.getState().setActiveLeftToolWindow(workspace.id, "project");
      useAppStore.getState().setSidebarCollapsed(false);
    }
  }, [workspace.id, workspace.rootFolders.length, active]);
  const sidebarExpanded = useAppStore((state) => !state.sidebarCollapsed);
  const leftToolAreaVisible = active && sidebarExpanded && workspace.activeLeftToolWindow !== "sessions";
  const canvasLayout = useWorkspaceUiStore((state) => state.canvasLayouts[workspace.id] ?? "single");
  const latest = useRef({ workspace, visible });
  latest.current = { workspace, visible };
  const files = useMemo<CodeWorkspaceFileRef[]>(() => workspace.openTabs
    .filter((tab) => tab.kind === "file" && !!tab.rootFolderId && !!tab.filePath)
    .map((tab) => ({ kind: "root", rootId: tab.rootFolderId!, path: tab.filePath! })), [workspace.openTabs]);
  const activeTab = workspace.openTabs.find((tab) => tab.id === workspace.activeTabId);
  const activeFile = useMemo<CodeWorkspaceFileRef | null>(() => activeTab?.kind === "file" && activeTab.rootFolderId && activeTab.filePath
    ? { kind: "root", rootId: activeTab.rootFolderId, path: activeTab.filePath } : null,
  [activeTab?.kind, activeTab?.rootFolderId, activeTab?.filePath]);
  const showEditorTabs = workspace.openTabs.some((tab) => tab.kind === "code");
  const paneFiles = useMemo<CodeWorkspaceFileRef[]>(() => {
    const ordered = activeTab ? [activeTab, ...workspace.openTabs.filter((tab) => tab.id !== activeTab.id)] : workspace.openTabs;
    return ordered.slice(0, canvasLayout === "single" ? 1 : canvasLayout === "split" ? 2 : 4)
      .filter((tab) => tab.kind === "file" && tab.rootFolderId && tab.filePath)
      .map((tab) => ({ kind: "root", rootId: tab.rootFolderId!, path: tab.filePath! }));
  }, [activeTab, workspace.openTabs, canvasLayout]);
  const previousActive = useRef(activeFile ? fileKey(activeFile) : null);
  const registerFileMenu = useCallback((groupId: string, menu: WorkspaceFileMenu | null) => {
    useWorkspaceEditorHostStore.getState().setFileMenu(workspace.id, groupId, menu);
  }, [workspace.id]);
  const mirrored = useRef(new Set<string>());
  const onActivateFile = useCallback((ref: CodeWorkspaceFileRef) => {
    const current = latest.current.workspace;
    if (ref.kind === "root") {
      useWorkspacePlatformStore.getState().openFileInWorkspace(current.id, { rootId: ref.rootId, path: ref.path });
    } else {
      useWorkspacePlatformStore.getState().openCodeWorkspaceTab(current.id);
    }
  }, []);
  const onOpenGitDiff = useCallback((path: string) => {
    useWorkspacePlatformStore.getState().openGitTab(latest.current.workspace.id, path || undefined);
  }, []);
  const onActivateToolWindow = useCallback((_toolId: string, side: "left" | "right" | "bottom") => {
    const current = latest.current.workspace;
    const store = useWorkspacePlatformStore.getState();
    if (side === "left") {
      store.setActiveLeftToolWindow(current.id, "project");
      useAppStore.getState().setSidebarCollapsed(false);
    } else if (!latest.current.visible) {
      const file = current.openTabs.find((tab) => tab.kind === "file");
      if (file) store.setActiveWorkspaceTab(current.id, file.id);
      else store.openCodeWorkspaceTab(current.id);
    }
  }, []);
  const onLeftToolAreaChange = useCallback((open: boolean) => {
    const state = useAppStore.getState();
    const store = useWorkspacePlatformStore.getState();
    if (state.activeSideTab !== "workspaces" || store.activeWorkspaceId !== latest.current.workspace.id) return;
    const current = store.getWorkspace();
    if (current?.activeLeftToolWindow === "sessions") return;
    state.setSidebarCollapsed(!open);
  }, []);
  const navigationItems = useMemo(() => [{
    id: "sessions", label: t("platform.sessions"), icon: createElement(MonitorSmartphone),
    testId: "code-workspace-tool-rail-sessions", shortcut: "Alt+2",
    active: sidebarExpanded && workspace.activeLeftToolWindow === "sessions",
    onSelect: () => {
      const app = useAppStore.getState();
      const store = useWorkspacePlatformStore.getState();
      const current = store.getWorkspace(workspace.id);
      app.setSidebarCollapsed(!app.sidebarCollapsed && current?.activeLeftToolWindow === "sessions");
      store.setActiveLeftToolWindow(workspace.id, "sessions");
    },
  }, {
    id: "workspace-git", label: t("platform.gitRepo"), icon: createElement(GitBranch),
    testId: "code-workspace-tool-rail-git", shortcut: "Alt+9",
    active: activeTab?.kind === "git",
    onSelect: () => { useWorkspacePlatformStore.getState().openGitTab(workspace.id); },
  }], [t, sidebarExpanded, workspace.id, workspace.activeLeftToolWindow, activeTab?.kind]);
  const recoverDraft = useCallback((ref: CodeWorkspaceFileRef) => {
    if (ref.kind !== "root") return null;
    const id = `ws:${latest.current.workspace.id}:file:${ref.rootId}:${ref.path}`;
    const draft = useWorkspaceEditorStore.getState().documents[id];
    return draft?.dirty ? { text: draft.text, savedText: draft.savedText, hash: draft.savedHash } : null;
  }, []);
  const onSnapshot = useCallback(({ files: buffers, activeFile: active }: WorkspaceHostSnapshot) => {
    const { workspace: current, visible: currentVisible } = latest.current;
    const rootFiles = buffers.filter((buffer) => buffer.ref.kind === "root");
    const nextMirrored = new Set<string>();
    const entries = rootFiles.map((buffer) => {
      const ref = buffer.ref as Extract<CodeWorkspaceFileRef, { kind: "root" }>;
      const tabId = `ws:${current.id}:file:${ref.rootId}:${ref.path}`;
      nextMirrored.add(tabId);
      const state = useWorkspaceEditorStore.getState();
      const patch = { path: ref.path, language: languageFromPath(buffer.languagePath), text: buffer.text,
        savedText: buffer.savedText, savedHash: buffer.hash, dirty: buffer.dirty, loading: buffer.loading, error: buffer.error };
      const previous = state.documents[tabId];
      if (!previous || Object.entries(patch).some(([key, value]) => previous[key as keyof typeof patch] !== value)) {
        state.setDocument(tabId, patch);
      }
      return { rootId: ref.rootId, path: ref.path };
    });
    for (const id of mirrored.current) {
      if (!nextMirrored.has(id)) useWorkspaceEditorStore.getState().removeDocument(id);
    }
    mirrored.current = nextMirrored;
    const key = active ? fileKey(active) : null;
    const reveal = currentVisible && active?.kind === "root" && key !== previousActive.current
      ? { rootId: active.rootId, path: active.path } : null;
    previousActive.current = key;
    useWorkspacePlatformStore.getState().syncWorkspaceFiles(current.id, entries, reveal);
  }, []);
  return useMemo(() => enabled ? { active, editorVisible: visible, leftToolAreaVisible, showEditorTabs, navigationItems, files, activeFile, canvasLayout, paneFiles, leftToolAreaHost, recoverDraft, onSnapshot,
    onActivateFile, onOpenGitDiff, onActivateToolWindow, onLeftToolAreaChange, registerFileMenu } : undefined,
    [enabled, active, visible, leftToolAreaVisible, showEditorTabs, navigationItems, files, activeFile, canvasLayout, paneFiles, leftToolAreaHost, recoverDraft, onSnapshot,
      onActivateFile, onOpenGitDiff, onActivateToolWindow, onLeftToolAreaChange, registerFileMenu]);
}
