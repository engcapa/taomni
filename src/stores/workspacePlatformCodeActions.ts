import type { StoreApi } from "zustand";
import type { CodeWorkspaceTabInfo } from "../types";
import type { WorkspacePlatformState, WorkspaceRootFolder } from "./workspacePlatformStore";

function updateRootFolders(folders: WorkspaceRootFolder[], info: CodeWorkspaceTabInfo): WorkspaceRootFolder[] {
  const roots = info.roots ?? [];
  if (folders.length === roots.length && roots.every((root, index) => {
    const previous = folders[index];
    return root.id === previous.id && root.name === previous.name && root.path === previous.path;
  })) return folders;
  return roots.map((root) => ({
    ...root,
    addedAt: folders.find((folder) => folder.id === root.id)?.addedAt ?? Date.now(),
  }));
}

/** Persist editor definitions without rebuilding an unchanged explorer model. */
export function createWorkspaceCodeActions(
  set: StoreApi<WorkspacePlatformState>["setState"],
  persist: (state: WorkspacePlatformState) => void,
): Pick<WorkspacePlatformState, "updateCodeWorkspace"> {
  return {
    updateCodeWorkspace: (workspaceId, info) => {
      set((state) => {
        const current = state.workspaces.find((workspace) => workspace.id === workspaceId);
        if (!current || JSON.stringify(current.codeWorkspace) === JSON.stringify(info)) return state;
        const workspaces = state.workspaces.map((workspace) => workspace.id === workspaceId ? {
          ...workspace,
          codeWorkspace: info,
          rootFolders: updateRootFolders(workspace.rootFolders, info),
        } : workspace);
        persist({ ...state, workspaces });
        return { workspaces };
      });
    },
  };
}
