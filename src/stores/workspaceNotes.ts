import type { StoreApi } from "zustand";
import type { PlatformWorkspace, WorkspacePlatformState } from "./workspacePlatformStore";

export const NOTES_WORKSPACE_ID = "notes-workspace";

export function createNotesWorkspace(): PlatformWorkspace {
  return {
    id: NOTES_WORKSPACE_ID, name: "Notes", description: "Tao Notes", isDefault: false,
    rootFolders: [], pinnedSessionIds: [], activeLeftToolWindow: "project",
    bottomDock: { open: false, activeTool: "terminal", heightPx: 220 },
    openTabs: [], activeTabId: "",
  };
}

export function createWorkspaceNotesActions(
  set: StoreApi<WorkspacePlatformState>["setState"],
  get: StoreApi<WorkspacePlatformState>["getState"],
  persist: (state: WorkspacePlatformState) => void,
): Pick<WorkspacePlatformState, "openNoteInWorkspace"> {
  return {
    openNoteInWorkspace: (noteId, title) => {
      const id = `ws:${NOTES_WORKSPACE_ID}:note:${noteId}`;
      set((state) => {
        const notes = state.workspaces.find((workspace) => workspace.id === NOTES_WORKSPACE_ID) ?? createNotesWorkspace();
        const openTabs = notes.openTabs.some((tab) => tab.id === id) ? notes.openTabs : [...notes.openTabs, {
          id, workspaceId: NOTES_WORKSPACE_ID, kind: "note" as const, noteId,
          title: `${title.trim() || "Untitled"}.md`, closable: true, createdAt: Date.now(),
        }];
        const nextNotes = { ...notes, openTabs, activeTabId: id };
        const workspaces = state.workspaces.some((workspace) => workspace.id === NOTES_WORKSPACE_ID)
          ? state.workspaces.map((workspace) => workspace.id === NOTES_WORKSPACE_ID ? nextNotes : workspace)
          : [...state.workspaces, nextNotes];
        const next = { workspaces, activeWorkspaceId: NOTES_WORKSPACE_ID };
        persist({ ...state, ...next });
        return next;
      });
      return get().getWorkspace(NOTES_WORKSPACE_ID)!.openTabs.find((tab) => tab.id === id)!;
    },
  };
}
