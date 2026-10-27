/**
 * Transient Workspaces-mode UI requests (v6.1 TASK-05/07/09).
 *
 * Modals and overlays are owned by the main window so the rail, the workspace
 * tab strip and the sidebar can open the same dialog without prop drilling.
 */
import { create } from "zustand";
import type { WorkspaceTabFilter } from "../lib/workspaceTabFilter";

export type WorkspaceCanvasLayout = "single" | "split" | "grid";

export type WorkspaceFsModalKind = "file" | "folder" | "root";

export interface WorkspaceFsModalRequest {
  kind: WorkspaceFsModalKind;
  /** Root folder the node is created in; the first root when omitted. */
  rootFolderId?: string;
  /** Directory relative to the root folder (empty for the root itself). */
  directory: string;
}

export interface WorkspaceUiState {
  tabFilters: Record<string, WorkspaceTabFilter>;
  setTabFilter: (workspaceId: string, filter: WorkspaceTabFilter) => void;
  canvasLayouts: Record<string, WorkspaceCanvasLayout>;
  setCanvasLayout: (workspaceId: string, layout: WorkspaceCanvasLayout) => void;
  sessionPickerOpen: boolean;
  /** Workspace id the picker targets (defaults to the active workspace). */
  sessionPickerWorkspaceId: string | null;
  fsModal: WorkspaceFsModalRequest | null;
  globalSearchOpen: boolean;
  agentDispatchOpen: boolean;
  openSessionPicker: (workspaceId?: string) => void;
  closeSessionPicker: () => void;
  openFsModal: (request: WorkspaceFsModalRequest) => void;
  closeFsModal: () => void;
  openGlobalSearch: () => void;
  closeGlobalSearch: () => void;
  openAgentDispatch: () => void;
  closeAgentDispatch: () => void;
}

export const useWorkspaceUiStore = create<WorkspaceUiState>((set) => ({
  tabFilters: {},
  setTabFilter: (workspaceId, filter) => set((state) => ({ tabFilters: { ...state.tabFilters, [workspaceId]: filter } })),
  canvasLayouts: {},
  setCanvasLayout: (workspaceId, layout) => set((state) => ({ canvasLayouts: { ...state.canvasLayouts, [workspaceId]: layout } })),
  sessionPickerOpen: false,
  sessionPickerWorkspaceId: null,
  fsModal: null,
  globalSearchOpen: false,
  agentDispatchOpen: false,

  openSessionPicker: (workspaceId) => set({
    sessionPickerOpen: true,
    sessionPickerWorkspaceId: workspaceId ?? null,
  }),
  closeSessionPicker: () => set({ sessionPickerOpen: false }),
  openFsModal: (request) => set({ fsModal: request }),
  closeFsModal: () => set({ fsModal: null }),
  openGlobalSearch: () => set({ globalSearchOpen: true }),
  closeGlobalSearch: () => set({ globalSearchOpen: false }),
  openAgentDispatch: () => set({ agentDispatchOpen: true }),
  closeAgentDispatch: () => set({ agentDispatchOpen: false }),
}));
