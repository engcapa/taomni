import { useEffect, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { type CodeWorkspaceGitManagerPayload } from "../../components/editor/CodeWorkspaceTab";
import { decideWorkspaceGitSync } from "../../lib/workspaceGitManagerSync";
import type { Tab, CodeWorkspaceRootInfo, CodeWorkspaceTabInfo, RecentWorkspace } from "../../types";
import { recentWorkspaceIdFromParts } from "../../stores/appStore";
import { selectFolderPath } from "../../lib/ipc";
import { useAppStore } from "../../stores/appStore";
import { openPlatformCodeWorkspace } from "../../lib/openPlatformCodeWorkspace";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { gitInitRepo, gitProbePath, gitRepoName } from "../../lib/git";
import { alertAppDialog, confirmAppDialog } from "../../lib/appDialogs";
import { normalizeGitWorkspaceRoots, gitWorkspaceRootsKey } from "./sessionPolicy";


export interface UseWorkspaceTabsContext {
  tabsRef: import("react").RefObject<Tab[]>;
  setActiveTab: (id: string) => void;
  addTab: (tab: Tab) => void;
  updateGitTabInfo: (id: string, git: import("../../types").GitTabInfo, title?: string) => void;
  removeTab: (id: string) => void;
  tabs: Tab[];
  setStatusMessage: (message: string) => void;
}

export function useWorkspaceTabs(context: UseWorkspaceTabsContext) {
  const { tabsRef, setActiveTab, addTab, updateGitTabInfo, removeTab, tabs, setStatusMessage } = context;
  const activeTabId = useAppStore((state) => state.activeTabId);
  const activeMode = useAppStore((state) => state.activeSideTab);
  // Only editor owner identities affect linked Git cleanup. File selection,
  // drafts and folder metadata must not refresh the entire main window.
  const platformWorkspaceInstanceIds = useWorkspacePlatformStore(useShallow((state) => state.workspaces
    .filter((workspace) => workspace.openTabs.some((tab) => tab.kind === "code"))
    .map((workspace) => workspace.codeWorkspace?.workspaceInstanceId ?? `platform:${workspace.id}`)));

  const openGitTab = useCallback((repoRoot: string) => {
    const normalized = repoRoot.trim();
    if (!normalized) return;
    const existing = tabsRef.current.find(
      (tab) => tab.type === "git" && tab.git?.repoRoot === normalized && !tab.git?.workspaceRoots?.length,
    );
    if (existing) {
      setActiveTab(existing.id);
      return;
    }
    addTab({
      id: `git-${Date.now()}`,
      type: "git",
      title: `Git · ${gitRepoName(normalized)}`,
      closable: true,
      git: { repoRoot: normalized },
    });
  }, [addTab, setActiveTab]);

  const openWorkspaceGitManager = useCallback((payload: CodeWorkspaceGitManagerPayload) => {
    const workspaceRoots = normalizeGitWorkspaceRoots(payload.roots);
    if (workspaceRoots.length === 0) return;
    const activeRepoRoot = payload.activeRepoRoot && workspaceRoots.some((root) => root.repoRoot === payload.activeRepoRoot)
      ? payload.activeRepoRoot
      : workspaceRoots[0].repoRoot;
    const name = payload.workspaceName.trim() || "Code Workspace";
    const existing = tabsRef.current.find((tab) => {
      if (tab.type !== "git" || !tab.git?.workspaceRoots?.length) return false;
      if (payload.workspaceInstanceId) {
        return tab.git.sourceWorkspaceInstanceId === payload.workspaceInstanceId;
      }
      return gitWorkspaceRootsKey(tab.git.workspaceRoots) === gitWorkspaceRootsKey(workspaceRoots);
    });
    if (existing) {
      updateGitTabInfo(existing.id, {
        ...existing.git!,
        repoRoot: activeRepoRoot,
        workspaceName: name,
        workspaceRoots,
        activeRepoRoot,
        sourceWorkspaceInstanceId: payload.workspaceInstanceId ?? existing.git?.sourceWorkspaceInstanceId,
        sourceWorkspaceId: payload.workspaceId ?? existing.git?.sourceWorkspaceId,
        sourceWorkspaceName: name,
      }, `Git · ${name}`);
      setActiveTab(existing.id);
      return;
    }
    addTab({
      id: `git-workspace-${Date.now()}`,
      type: "git",
      title: `Git · ${name}`,
      closable: true,
      git: {
        repoRoot: activeRepoRoot,
        workspaceName: name,
        workspaceRoots,
        activeRepoRoot,
        sourceWorkspaceInstanceId: payload.workspaceInstanceId,
        sourceWorkspaceId: payload.workspaceId,
        sourceWorkspaceName: name,
      },
    });
  }, [addTab, setActiveTab, updateGitTabInfo]);

  const syncWorkspaceGitManager = useCallback((payload: CodeWorkspaceGitManagerPayload) => {
    const sourceWorkspaceInstanceId = payload.workspaceInstanceId;
    if (!sourceWorkspaceInstanceId) return;
    const workspaceRoots = normalizeGitWorkspaceRoots(payload.roots);
    const existing = tabsRef.current.find((tab) => (
      tab.type === "git"
      && tab.git?.sourceWorkspaceInstanceId === sourceWorkspaceInstanceId
    ));
    const decision = decideWorkspaceGitSync({
      hasLinkedTab: !!existing?.git,
      workspaceRoots,
      existingActiveRepoRoot: existing?.git?.activeRepoRoot ?? existing?.git?.repoRoot,
      payloadActiveRepoRoot: payload.activeRepoRoot,
    });
    if (decision.kind === "noop" || !existing?.git) return;
    // Empty / removed roots: close the linked Git tab so we never keep
    // snapshotting deleted paths after the workspace drops them (issue #324 B1).
    if (decision.kind === "close") {
      removeTab(existing.id);
      return;
    }
    const name = payload.workspaceName.trim() || "Code Workspace";
    updateGitTabInfo(existing.id, {
      ...existing.git,
      repoRoot: decision.activeRepoRoot,
      workspaceName: name,
      workspaceRoots: decision.workspaceRoots,
      activeRepoRoot: decision.activeRepoRoot,
      sourceWorkspaceInstanceId,
      sourceWorkspaceId: payload.workspaceId ?? existing.git.sourceWorkspaceId,
      sourceWorkspaceName: name,
    }, `Git · ${name}`);
  }, [removeTab, updateGitTabInfo]);

  // Close workspace Git manager tabs whose source Code Workspace tab is gone so
  // they cannot keep snapshotting stale repo paths after the workspace is closed.
  useEffect(() => {
    const openWorkspaceInstanceIds = new Set(
      tabs
        .filter((tab) => tab.type === "code-workspace" && tab.codeWorkspace)
        .map((tab) => {
          const ws = tab.codeWorkspace!;
          return ws.workspaceInstanceId ?? ws.workspaceId ?? ws.repoRoot?.trim() ?? tab.id;
        }),
    );
    for (const instanceId of platformWorkspaceInstanceIds) openWorkspaceInstanceIds.add(instanceId);
    for (const tab of tabs) {
      if (tab.type !== "git" || !tab.git?.sourceWorkspaceInstanceId) continue;
      if (!tab.git.workspaceRoots?.length) continue;
      if (openWorkspaceInstanceIds.has(tab.git.sourceWorkspaceInstanceId)) continue;
      removeTab(tab.id);
    }
  }, [removeTab, tabs, platformWorkspaceInstanceIds]);

  const openCodeWorkspaceInfo = useCallback((workspace: CodeWorkspaceTabInfo) => {
    openPlatformCodeWorkspace(workspace);
  }, []);

  // Old persisted Sessions editor tabs are redirected without losing their
  // recovery identity. Other Sessions tabs keep their independent instances.
  useEffect(() => {
    const active = tabsRef.current.find((tab) => tab.id === useAppStore.getState().activeTabId);
    if (activeMode !== "sessions" || active?.type !== "code-workspace" || !active.codeWorkspace) return;
    openPlatformCodeWorkspace(active.codeWorkspace);
    removeTab(active.id);
  }, [tabs, removeTab, activeTabId, activeMode]);

  const openCodeWorkspaceTab = useCallback((repoRoot: string, initialPath?: string | null) => {
    const normalized = repoRoot.trim();
    if (!normalized) return;
    const root: CodeWorkspaceRootInfo = {
      id: `root-${Date.now()}`,
      name: gitRepoName(normalized),
      path: normalized,
      kind: "git",
    };
    openCodeWorkspaceInfo({
      repoRoot: normalized,
      initialPath: initialPath ?? null,
      workspaceId: recentWorkspaceIdFromParts([root], []),
      name: root.name,
      roots: [root],
      looseFiles: [],
      initialFile: initialPath ? { kind: "root", rootId: root.id, path: initialPath } : null,
    });
  }, [openCodeWorkspaceInfo]);

  const openRecentCodeWorkspace = useCallback((workspace: RecentWorkspace) => {
    openCodeWorkspaceInfo({
      repoRoot: workspace.roots[0]?.path ?? "",
      workspaceId: workspace.id,
      name: workspace.name,
      roots: workspace.roots,
      looseFiles: workspace.looseFiles,
      initialFile: workspace.lastActiveFile ?? null,
    });
  }, [openCodeWorkspaceInfo]);

  const openEmptyCodeWorkspaceTab = useCallback(() => {
    openCodeWorkspaceInfo({ repoRoot: "", roots: [], looseFiles: [], initialFile: null });
  }, [openCodeWorkspaceInfo]);

  const openNewCodeWorkspaceFromWelcome = useCallback(async () => {
    const path = await selectFolderPath();
    if (path) openCodeWorkspaceTab(path);
  }, [openCodeWorkspaceTab]);

  const openGitRepository = useCallback(async (path?: string | null) => {
    const target = path ?? await selectFolderPath();
    if (!target) return;
    try {
      const probe = await gitProbePath(target);
      if (!probe.gitAvailable) {
        await alertAppDialog({
          title: "Git Repository",
          message: probe.error ?? "Git executable was not found.",
        });
        return;
      }
      if (probe.isRepo && probe.repoRoot) {
        openGitTab(probe.repoRoot);
        return;
      }
      const shouldInit = await confirmAppDialog({
        title: "Initialize Git repository",
        message: `"${target}" is not inside a Git repository. Initialize a new repository here?`,
        confirmLabel: "Initialize",
      });
      if (!shouldInit) return;
      const initialized = await gitInitRepo(target);
      openGitTab(initialized.repoRoot ?? target);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatusMessage(message);
      await alertAppDialog({ title: "Git Repository", message });
    }
  }, [openGitTab, setStatusMessage]);
  return { openGitRepository, openEmptyCodeWorkspaceTab, openRecentCodeWorkspace, openNewCodeWorkspaceFromWelcome, openCodeWorkspaceTab, openWorkspaceGitManager, syncWorkspaceGitManager };
}
