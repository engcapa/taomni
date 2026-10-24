import { create } from "zustand";

/**
 * Workspace-first platform redesign (v6.1): the main navigation rail renders
 * the workspace tool window buttons (Project / Sessions / Git / Structure / …)
 * statically, even before a workspace editor instance exists. A live editor
 * registers itself here so the rail buttons control the real tool windows
 * (toggle the project tree, open bottom dock tools) instead of falling back
 * to the workspace sidebar lens.
 */
export interface WorkspaceToolBridgeController {
  /** The editor's left tool area (project tree pane) is open. */
  leftToolAreaOpen: boolean;
  toggleProjectTree: () => void;
  /** Open/focus a bottom dock tool (terminal | problems | run | …). */
  openBottomTool: (tool: string) => void;
  bottomDockOpen: boolean;
  /** Re-dock the primary left tool window (project tree) to another anchor. */
  moveProjectWindow: (anchor: string) => void;
  /** Open a workspace file (absolute path) in the editor. */
  openFile?: (path: string, rootFolderId?: string) => Promise<void> | void;
  /** Re-read the expanded project tree nodes from disk. */
  refreshProjectTree?: () => void;
}

interface WorkspaceToolBridgeState {
  controller: WorkspaceToolBridgeController | null;
  register: (controller: WorkspaceToolBridgeController | null) => void;
  /** Clear only when `controller` is still the registered one. */
  unregister: (controller: WorkspaceToolBridgeController | null) => void;
}

export const useWorkspaceToolBridgeStore = create<WorkspaceToolBridgeState>((set) => ({
  controller: null,
  register: (controller) => set((state) => (state.controller === controller ? state : { controller })),
  unregister: (controller) => set((state) => (state.controller === controller ? { controller: null } : state)),
}));
