import { useEffect } from "react";
import type { NoteItem } from "../../lib/notes";
import { useNotesTaskStore } from "../../stores/notesTaskStore";

export function useNoteTask(id: string, fallback?: NoteItem) {
  const record = useNotesTaskStore((state) => state.records[id]);
  useEffect(() => { void useNotesTaskStore.getState().load(id); }, [id]);
  return record === undefined ? fallback : record ?? undefined;
}
