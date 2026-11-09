import { create } from "zustand";
import { getNote, listNotes, saveNoteContent, type NoteItem } from "../lib/notes";
import {
  persistNoteDrafts, readNoteDrafts, sameNoteContent,
  type NoteContent, type NoteDocument,
} from "./notesContentRecovery";

interface NotesContentState {
  documents: Record<string, NoteDocument>;
  catalog: NoteItem[];
  catalogLoading: boolean;
  catalogError: string | null;
  recoveryError: string | null;
  adopt: (note: NoteItem) => void;
  edit: (note: Pick<NoteItem, "id" | "title" | "body">, patch: Partial<NoteContent>) => void;
  refresh: (id: string) => Promise<void>;
  loadCatalog: () => Promise<void>;
  save: (id: string) => Promise<boolean>;
  reload: (id: string) => Promise<boolean>;
}

const pendingSaves = new Map<string, Promise<boolean>>();
const refreshGeneration = new Map<string, number>();
let catalogGeneration = 0;

function cleanDocument(note: NoteContent): NoteDocument {
  const content = { title: note.title, body: note.body };
  return { ...content, saved: content, dirty: false, saving: false, error: null, errorDetail: null };
}

function saveError(error: unknown): Pick<NoteDocument, "error" | "errorDetail"> {
  const failure = error as { kind?: string; message?: string } | null;
  return {
    error: failure?.kind === "conflict" || failure?.kind === "missing" ? failure.kind : "storage",
    errorDetail: failure?.message ?? String(error),
  };
}

/** Draft ownership outlives either editor. Both entry points edit this same buffer. */
export const useNotesContentStore = create<NotesContentState>((set, get) => {
  const setDocument = (id: string, document: NoteDocument) => set((state) => {
    const documents = { ...state.documents, [id]: document };
    return { documents, recoveryError: persistNoteDrafts(documents) };
  });
  return {
    documents: readNoteDrafts(),
    catalog: [],
    catalogLoading: false,
    catalogError: null,
    recoveryError: null,

    adopt: (note) => {
      const current = get().documents[note.id];
      // Lists can finish after a save. Only authoritative refreshes update an
      // existing buffer; adopting a late list item must not roll it back.
      if (current) return;
      setDocument(note.id, cleanDocument(note));
    },

    edit: (note, patch) => {
      const current = get().documents[note.id] ?? cleanDocument(note);
      const next = { ...current, ...patch };
      next.dirty = !sameNoteContent(next, current.saved);
      setDocument(note.id, next);
    },

    refresh: async (id) => {
      const generation = (refreshGeneration.get(id) ?? 0) + 1;
      refreshGeneration.set(id, generation);
      try {
        const note = await getNote(id);
        if (generation !== refreshGeneration.get(id)) return;
        const current = get().documents[id];
        if (!current) {
          setDocument(id, note ? cleanDocument(note) : { ...cleanDocument({ title: "", body: "" }), error: "missing" });
          return;
        }
        if (current.saving) return;
        if (!note) {
          setDocument(id, { ...current, error: "missing", errorDetail: null });
        } else if (!current.dirty) {
          setDocument(id, cleanDocument(note));
        } else if (!sameNoteContent(note, current.saved)) {
          setDocument(id, { ...current, error: "conflict", errorDetail: null });
        }
      } catch (error) {
        const current = get().documents[id];
        if (generation === refreshGeneration.get(id)) {
          setDocument(id, { ...(current ?? cleanDocument({ title: "", body: "" })), ...saveError(error) });
        }
      }
    },

    loadCatalog: async () => {
      const generation = ++catalogGeneration;
      set({ catalogLoading: true, catalogError: null });
      try {
        const catalog = await listNotes({ filters: ["all", "archived"] });
        if (generation === catalogGeneration) set({ catalog, catalogLoading: false });
      } catch (error) {
        if (generation === catalogGeneration) set({ catalogLoading: false, catalogError: String(error) });
      }
    },

    save: async (id) => {
      const pending = pendingSaves.get(id);
      if (pending) {
        if (!await pending) return false;
        return get().documents[id]?.dirty ? get().save(id) : true;
      }
      const current = get().documents[id];
      if (!current) return false;
      if (!current.dirty) return !current.error;
      if (current.error === "missing" || current.error === "conflict") return false;
      const submitted = { title: current.title, body: current.body };
      refreshGeneration.set(id, (refreshGeneration.get(id) ?? 0) + 1);
      setDocument(id, { ...current, saving: true, error: null, errorDetail: null });
      const operation = (async () => {
        try {
          const note = await saveNoteContent(id, submitted, current.saved);
          const latest = get().documents[id];
          setDocument(id, { ...latest, saved: { title: note.title, body: note.body }, saving: false,
            dirty: !sameNoteContent(latest, submitted), error: null, errorDetail: null });
          return true;
        } catch (error) {
          setDocument(id, { ...get().documents[id], saving: false, ...saveError(error) });
          return false;
        }
      })();
      pendingSaves.set(id, operation);
      let success: boolean;
      try { success = await operation; }
      finally { pendingSaves.delete(id); }
      // Navigation/blur waits for all typing already made during this save.
      return success && (get().documents[id]?.dirty ? get().save(id) : true);
    },

    reload: async (id) => {
      // Do not replace a buffer while its own save is committing.
      if (pendingSaves.has(id)) await pendingSaves.get(id);
      try {
        const before = get().documents[id];
        const note = await getNote(id);
        if (!note) {
          if (before) setDocument(id, { ...before, error: "missing", errorDetail: null });
          return false;
        }
        // Typing while the reload was in flight must not be discarded.
        if (before !== get().documents[id]) return false;
        setDocument(id, cleanDocument(note));
        return true;
      } catch (error) {
        const current = get().documents[id];
        if (current) setDocument(id, { ...current, ...saveError(error) });
        return false;
      }
    },
  };
});
