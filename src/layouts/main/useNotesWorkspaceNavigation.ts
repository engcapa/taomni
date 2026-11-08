import { useEffect } from "react";
import { isTauriRuntime } from "../../lib/runtime";
import { getNote } from "../../lib/notes";
import { OPEN_NOTES_WORKSPACE_EVENT, openNoteWorkspace, openNotesWorkspace, type NotesWorkspaceRequest } from "../../lib/notes/notesWorkspaceNavigation";
import { useAppStore } from "../../stores/appStore";

export function useNotesWorkspaceNavigation(): void {
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let generation = 0;
    let stop: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) => listen<NotesWorkspaceRequest>(
      OPEN_NOTES_WORKSPACE_EVENT,
      (event) => {
        const request = ++generation;
        void (async () => {
          if (!event.payload.noteId) return openNotesWorkspace();
          const note = await getNote(event.payload.noteId);
          if (note && !disposed && request === generation) return openNoteWorkspace(note, event.payload.mode);
        })().catch((error) => useAppStore.getState().setStatusMessage(String(error)));
      },
    )).then((unlisten) => { if (disposed) unlisten(); else stop = unlisten; }).catch(console.warn);
    return () => { disposed = true; stop?.(); };
  }, []);
}
