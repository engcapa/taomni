import { create } from "zustand";
import type { GitWorkspaceRootInfo } from "../types";

export interface WorkspaceGitContext {
  roots: GitWorkspaceRootInfo[];
  activeRepoRoot: string | null;
}

interface State {
  byWorkspace: Record<string, WorkspaceGitContext>;
  publish: (workspaceId: string, context: WorkspaceGitContext) => void;
  clear: (workspaceId: string) => void;
}

/** Discovered Git roots belong to the mounted editor, never to persisted tabs. */
export const useWorkspaceGitContextStore = create<State>((set) => ({
  byWorkspace: {},
  publish: (workspaceId, context) => set((state) => {
    if (JSON.stringify(state.byWorkspace[workspaceId]) === JSON.stringify(context)) return state;
    return { byWorkspace: { ...state.byWorkspace, [workspaceId]: context } };
  }),
  clear: (workspaceId) => set((state) => {
    const byWorkspace = { ...state.byWorkspace };
    delete byWorkspace[workspaceId];
    return { byWorkspace };
  }),
}));
