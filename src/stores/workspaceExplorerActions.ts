import type { StoreApi } from "zustand";
import { basename } from "../lib/sftp";
import type { WorkspaceIsolatedTab, WorkspacePlatformState } from "./workspacePlatformStore";

type ExplorerActions = Pick<WorkspacePlatformState, "addExplorerTab" | "updateExplorerPath">;

export function createWorkspaceExplorerActions(
  set: StoreApi<WorkspacePlatformState>["setState"],
  persist: (state: WorkspacePlatformState) => void,
): ExplorerActions {
  return {
    addExplorerTab: (workspaceId, path) => {
      const tab: WorkspaceIsolatedTab = {
        id: `ws:${workspaceId}:explorer:${crypto.randomUUID()}`, workspaceId,
        kind: "explorer", explorerPath: path, title: basename(path) || path,
        closable: true, createdAt: Date.now(),
      };
      set((state) => {
        const workspaces = state.workspaces.map((workspace) => workspace.id === workspaceId
          ? { ...workspace, openTabs: [...workspace.openTabs, tab], activeTabId: tab.id } : workspace);
        persist({ ...state, workspaces, activeWorkspaceId: workspaceId });
        return { workspaces, activeWorkspaceId: workspaceId };
      });
      return tab;
    },
    updateExplorerPath: (workspaceId, tabId, path) => {
      set((state) => {
        const workspace = state.workspaces.find((item) => item.id === workspaceId);
        const tab = workspace?.openTabs.find((item) => item.id === tabId);
        if (!tab || tab.explorerPath === path) return state;
        const workspaces = state.workspaces.map((item) => item.id === workspaceId ? {
          ...item, openTabs: item.openTabs.map((current) => current.id === tabId
            ? { ...current, explorerPath: path, ...(current.kind === "explorer" ? { title: basename(path) || path } : {}) } : current),
        } : item);
        persist({ ...state, workspaces });
        return { workspaces };
      });
    },
  };
}
