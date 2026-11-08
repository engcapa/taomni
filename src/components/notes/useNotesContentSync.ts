import { useEffect } from "react";
import { subscribeNotesChanges } from "../../lib/notes/notesChanges";
import { useNotesContentStore } from "../../stores/notesContentStore";
import { useNotesStore } from "../../stores/notesStore";

let owners = 0;
let release: (() => void) | undefined;

/** One application/window subscription, released when the last notes surface leaves. */
export function useNotesContentSync(): void {
  useEffect(() => {
    owners += 1;
    if (owners === 1) {
      const refresh = (id: string) => {
        const contents = useNotesContentStore.getState();
        void contents.refresh(id);
        void contents.loadCatalog();
        void useNotesStore.getState().loadNotes();
      };
      release = subscribeNotesChanges(refresh);
      // Reconcile drafts that survived a closed pane or an application restart.
      for (const id of Object.keys(useNotesContentStore.getState().documents)) {
        void useNotesContentStore.getState().refresh(id);
      }
    }
    return () => {
      owners -= 1;
      if (owners === 0) { release?.(); release = undefined; }
    };
  }, []);
}
