/**
 * Workspaces mode rail hosting (v6.1 AC-03).
 *
 * While Workspaces mode is active the legacy Code Workspace editor surface must
 * not render a second vertical stripe: its tool window rail is force-merged
 * into the window's primary navigation rail even when the sidebar is expanded.
 */
import { create } from "zustand";

export interface WorkspaceRailState {
  /** Force the active workspace's tool window rail into the main rail. */
  forceMerge: boolean;
  setForceMerge: (value: boolean) => void;
}

export const useWorkspaceRailStore = create<WorkspaceRailState>((set) => ({
  forceMerge: false,
  setForceMerge: (forceMerge) => set({ forceMerge }),
}));
