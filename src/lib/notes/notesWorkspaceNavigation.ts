import { createNote, getNote, type NoteItem } from "../notes";
import { detectDetachedRoute } from "../detachedSession";
import { isTauriRuntime } from "../runtime";
import { useAppStore } from "../../stores/appStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { useNotesWorkspaceViewStore } from "../../stores/notesWorkspaceViewStore";
import { useNotesStore } from "../../stores/notesStore";
import { useChatStore } from "../../stores/chatStore";
import { useTaoHubStore } from "../../stores/taoHubStore";
import { NOTES_WORKSPACE_ID } from "../../stores/workspaceNotes";

export const OPEN_NOTES_WORKSPACE_EVENT = "taomni://notes-open-workspace";
export type NoteWorkspaceMode = "edit" | "split" | "preview";
export const noteWorkspaceModes = new Map<string, NoteWorkspaceMode>();
export interface NotesWorkspaceRequest { noteId?: string; mode?: NoteWorkspaceMode }

async function navigateWorkspace(request: NotesWorkspaceRequest, note?: NoteItem): Promise<void> {
  if (isTauriRuntime() && detectDetachedRoute()?.kind === "notes") {
    const { emitTo } = await import("@tauri-apps/api/event");
    const { Window } = await import("@tauri-apps/api/window");
    await emitTo("main", OPEN_NOTES_WORKSPACE_EVENT, request);
    const main = await Window.getByLabel("main");
    if (main) { await main.show(); await main.unminimize(); await main.setFocus(); }
    return;
  }
  const platform = useWorkspacePlatformStore.getState();
  if (note) {
    noteWorkspaceModes.set(note.id, request.mode ?? "edit");
    platform.openNoteInWorkspace(note.id, note.title);
  } else platform.setActiveWorkspace(NOTES_WORKSPACE_ID);
  const app = useAppStore.getState();
  app.setActiveSideTab("workspaces");
  app.setSidebarCollapsed(false);
  useChatStore.getState().setDrawerOpen(false);
  window.dispatchEvent(new CustomEvent(OPEN_NOTES_WORKSPACE_EVENT, { detail: request }));
}

export function openNotesWorkspace(): Promise<void> {
  return navigateWorkspace({});
}

/** The stable note ID is the document identity, independent of its title. */
export async function openNoteWorkspace(note: NoteItem, mode: NoteWorkspaceMode = "edit"): Promise<void> {
  await navigateWorkspace({ noteId: note.id, mode }, note);
}

export async function createAndOpenWorkspaceNote(): Promise<void> {
  try {
    useNotesWorkspaceViewStore.getState().resetForCreate();
    await openNoteWorkspace(await createNote());
  }
  catch (error) { useAppStore.getState().setStatusMessage(String(error)); }
}

export async function openNoteInTao(noteId: string): Promise<void> {
  const note = await getNote(noteId);
  if (!note) return;
  const store = useNotesStore.getState();
  store.setStatusFilters(note.archived_at === null ? ["all"] : ["archived"]);
  // Resolve this selected note independently of the previous list filter.
  useNotesStore.setState((state) => ({ notes: [note, ...state.notes.filter((item) => item.id !== note.id)], activeNoteId: note.id }));
  useTaoHubStore.getState().setHubTab("notes");
  useNotesStore.getState().setPanelMode("hub");
  useChatStore.getState().setDrawerOpen(true);
}
