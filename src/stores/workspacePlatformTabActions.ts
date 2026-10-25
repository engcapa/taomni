import type { StoreApi } from "zustand";
import type { WorkspacePlatformState, WorkspaceIsolatedTab } from "./workspacePlatformStore";
import { computeDuplicateTitle } from "./app/tabTitles";

type TabActions = Pick<WorkspacePlatformState,
  "closeWorkspaceTab" | "renameWorkspaceTab" | "moveWorkspaceTab" | "duplicateWorkspaceTab" | "setActiveWorkspaceTab">;

export function createWorkspaceTabActions(
  set: StoreApi<WorkspacePlatformState>["setState"],
  get: StoreApi<WorkspacePlatformState>["getState"],
  persist: (state: WorkspacePlatformState) => void,
): TabActions {
  const updateWorkspace = (workspaces: WorkspacePlatformState["workspaces"], id: string,
    update: (workspace: WorkspacePlatformState["workspaces"][number]) => WorkspacePlatformState["workspaces"][number]) =>
    workspaces.map((workspace) => workspace.id === id ? update(workspace) : workspace);
  const fallbackActiveTabId = (tabs: WorkspaceIsolatedTab[]) => tabs[0]?.id ?? "";
  const newRuntimeId = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;
  return {
  closeWorkspaceTab: (workspaceId, tabId) => {
    set((state) => {
      const workspaces = updateWorkspace(state.workspaces, workspaceId, (workspace) => {
        if (!workspace.openTabs.some((tab) => tab.id === tabId)) return workspace;
        const index = workspace.openTabs.findIndex((tab) => tab.id === tabId);
        const openTabs = workspace.openTabs.filter((tab) => tab.id !== tabId);
        const activeTabId = workspace.activeTabId === tabId
          ? (openTabs[Math.min(index, openTabs.length - 1)]?.id ?? fallbackActiveTabId(openTabs))
          : workspace.activeTabId;
        return { ...workspace, openTabs, activeTabId };
      });
      const next = { workspaces };
      persist({ ...state, ...next });
      return next;
    });
  },

  renameWorkspaceTab: (workspaceId, tabId, title) => {
    if (!title.trim()) return;
    set((state) => {
      const workspaces = updateWorkspace(state.workspaces, workspaceId, (workspace) => ({
        ...workspace,
        openTabs: workspace.openTabs.map((tab) => tab.id === tabId ? { ...tab, title: title.trim() } : tab),
      }));
      persist({ ...state, workspaces });
      return { workspaces };
    });
  },

  moveWorkspaceTab: (workspaceId, tabId, index) => {
    if (!Number.isFinite(index)) return;
    set((state) => {
      const workspaces = updateWorkspace(state.workspaces, workspaceId, (workspace) => {
        const current = workspace.openTabs.findIndex((tab) => tab.id === tabId);
        if (current < 0) return workspace;
        const openTabs = [...workspace.openTabs];
        const [tab] = openTabs.splice(current, 1);
        openTabs.splice(Math.max(0, Math.min(Math.trunc(index), openTabs.length)), 0, tab);
        return { ...workspace, openTabs };
      });
      persist({ ...state, workspaces });
      return { workspaces };
    });
  },

  duplicateWorkspaceTab: (workspaceId, tabId, cwd) => {
    const workspace = get().getWorkspace(workspaceId);
    const source = workspace?.openTabs.find((tab) => tab.id === tabId);
    if (!source || !workspace || source.kind !== "terminal") return null;
    const tab: WorkspaceIsolatedTab = {
      ...source,
      id: newRuntimeId(`ws:${workspaceId}:duplicate`),
      title: computeDuplicateTitle(source.title, workspace.openTabs.map((item) => item.title)),
      terminalInitialCwd: cwd,
      createdAt: Date.now(),
    };
    set((state) => {
      const workspaces = updateWorkspace(state.workspaces, workspaceId, (current) => {
        const openTabs = [...current.openTabs];
        openTabs.splice(openTabs.findIndex((item) => item.id === tabId) + 1, 0, tab);
        return { ...current, openTabs, activeTabId: tab.id };
      });
      persist({ ...state, workspaces });
      return { workspaces };
    });
    return tab;
  },

  setActiveWorkspaceTab: (workspaceId, tabId) => {
    set((state) => {
      const workspaces = updateWorkspace(state.workspaces, workspaceId, (workspace) => (
        workspace.openTabs.some((tab) => tab.id === tabId) ? { ...workspace, activeTabId: tabId } : workspace
      ));
      const next = { workspaces };
      persist({ ...state, ...next });
      return next;
    });
  },

  };
}
