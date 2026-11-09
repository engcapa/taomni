import { create } from "zustand";
import {
  archiveNote, deleteNote, getNote, nowSecs, setSteps, updateNoteMetadata, upsertTags,
  type NoteItem, type NoteMetadataPatch, type StepInput,
} from "../lib/notes";

interface NotesTaskState {
  records: Record<string, NoteItem | null>;
  pending: Record<string, number>;
  errors: Record<string, string | null>;
  load: (id: string) => Promise<void>;
  patch: (id: string, patch: NoteMetadataPatch) => Promise<boolean>;
  complete: (id: string, completed: boolean) => Promise<boolean>;
  archive: (id: string, archived: boolean) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  changeSteps: (id: string, change: (steps: StepInput[]) => StepInput[]) => Promise<boolean>;
  addTag: (id: string, name: string) => Promise<boolean>;
  removeTag: (id: string, tagId: string) => Promise<boolean>;
  retry: (id: string) => Promise<boolean>;
}

/** Task writes are independent of content drafts and serialized per note. */
export const useNotesTaskStore = create<NotesTaskState>((set, get) => {
  const queues = new Map<string, Promise<boolean>>();
  const generations = new Map<string, number>();
  type Operation = () => Promise<NoteItem | null>;
  const failures = new Map<string, { operation: Operation; message: string; field?: string }[]>();
  const run = (id: string, operation: Operation, field?: string): Promise<boolean> => {
    generations.set(id, (generations.get(id) ?? 0) + 1);
    set((state) => ({ pending: { ...state.pending, [id]: (state.pending[id] ?? 0) + 1 } }));
    const previous = queues.get(id);
    const result = (async () => {
      if (previous) await previous;
      try {
        const note = await operation();
        const remaining = (failures.get(id) ?? []).filter((failure) =>
          failure.operation !== operation && (!field || failure.field !== field));
        failures.set(id, remaining);
        set((state) => ({ records: { ...state.records, [id]: note }, errors: { ...state.errors, [id]: remaining[0]?.message ?? null } }));
        return true;
      } catch (error) {
        const remaining = (failures.get(id) ?? []).filter((failure) =>
          failure.operation !== operation && (!field || failure.field !== field));
        remaining.push({ operation, message: String(error), field });
        failures.set(id, remaining);
        set((state) => ({ errors: { ...state.errors, [id]: remaining[0].message } }));
        return false;
      } finally {
        set((state) => ({ pending: { ...state.pending, [id]: Math.max(0, (state.pending[id] ?? 1) - 1) } }));
      }
    })();
    queues.set(id, result);
    void result.finally(() => { if (queues.get(id) === result) queues.delete(id); });
    return result;
  };
  const requireNote = async (id: string): Promise<NoteItem> => {
    const note = await getNote(id);
    if (!note) throw new Error("The note was deleted.");
    return note;
  };
  const patchExisting = async (id: string, patch: NoteMetadataPatch) => {
    const note = await updateNoteMetadata(id, patch);
    if (!note) throw new Error("The note was deleted.");
    return note;
  };
  return {
    records: {}, pending: {}, errors: {},
    load: async (id) => {
      const generation = (generations.get(id) ?? 0) + 1;
      generations.set(id, generation);
      // A change event can arrive before its own write has returned.
      const pending = queues.get(id);
      if (pending) await pending;
      if (generation !== generations.get(id)) return;
      try {
        const note = await getNote(id);
        if (generation !== generations.get(id)) return;
        set((state) => ({ records: { ...state.records, [id]: note },
          errors: { ...state.errors, [id]: failures.get(id)?.[0]?.message ?? null } }));
      } catch (error) {
        if (generation === generations.get(id)) {
          set((state) => ({ errors: { ...state.errors, [id]: String(error) } }));
        }
      }
    },
    patch: (id, patch) => run(id, () => patchExisting(id, patch), `metadata:${Object.keys(patch).sort().join(",")}`),
    complete: (id, completed) => get().patch(id, { completed_at: completed ? nowSecs() : null }),
    archive: (id, archived) => run(id, async () => {
      const note = await archiveNote(id, archived);
      if (!note) throw new Error("The note was deleted.");
      return note;
    }, "archive"),
    remove: (id) => run(id, async () => {
      await deleteNote(id);
      failures.delete(id);
      return null;
    }),
    changeSteps: (id, change) => run(id, async () => {
      const note = await requireNote(id);
      const steps = change(note.steps).map((step, index) => ({ ...step, sort_order: index }));
      return { ...note, steps: await setSteps(id, steps) };
    }),
    addTag: (id, name) => run(id, async () => {
      const note = await requireNote(id);
      const [tag] = await upsertTags([{ name: name.trim() }]);
      if (!tag) throw new Error("The tag could not be saved.");
      return patchExisting(id, { tag_ids: [...new Set([...note.tags.map((item) => item.id), tag.id])] });
    }),
    removeTag: (id, tagId) => run(id, async () => {
      const note = await requireNote(id);
      return patchExisting(id, { tag_ids: note.tags.filter((tag) => tag.id !== tagId).map((tag) => tag.id) });
    }),
    retry: async (id) => {
      const failed = failures.get(id)?.[0];
      if (failed) return run(id, failed.operation, failed.field);
      await get().load(id);
      return !get().errors[id];
    },
  };
});
