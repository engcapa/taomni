import { getNote, type StepInput } from "../notes";
import { useNotesStore } from "../../stores/notesStore";
import { waitShellReady } from "../shell/readiness";

export interface NoteDraftSnapshot {
  noteId: string; title: string; body: string; steps: StepInput[]; tagIds: string[];
  newStep: string; newTag: string; scrollTop: number;
  titleSelection: [number, number]; bodySelection: [number, number];
}
export interface NotesViewSnapshot { activeNoteId: string | null; draft: NoteDraftSnapshot | null }
export interface NotesEditorController { snapshot(): NoteDraftSnapshot; restore(snapshot: NoteDraftSnapshot): void; flush(): Promise<void> }
let editor: NotesEditorController | undefined;
const drafts = new Map<string, NoteDraftSnapshot>();
const viewListeners = new Set<() => void>();
export function subscribeNotesViewChanges(listener: () => void) {
  viewListeners.add(listener);
  return () => { viewListeners.delete(listener); };
}
export function notifyNotesViewChanged() { for (const listener of viewListeners) listener(); }
export function registerNotesEditor(controller: NotesEditorController) {
  editor = controller;
  const draft = drafts.get(controller.snapshot().noteId);
  if (draft) { drafts.delete(draft.noteId); controller.restore(draft); }
  return () => { if (editor === controller) editor = undefined; };
}
export function snapshotNotesView(): NotesViewSnapshot {
  const activeNoteId = useNotesStore.getState().activeNoteId;
  return { activeNoteId, draft: editor?.snapshot().noteId === activeNoteId ? editor.snapshot() : activeNoteId ? drafts.get(activeNoteId) ?? null : null };
}
export async function flushNotesEditor() { await editor?.flush(); }
export function validateNotesView(raw: unknown): NotesViewSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as NotesViewSnapshot;
  if (s.activeNoteId !== null && typeof s.activeNoteId !== "string") return null;
  if (s.draft !== null) {
    const d = s.draft;
    if (!d || d.noteId !== s.activeNoteId || typeof d.title !== "string" || typeof d.body !== "string" || !Array.isArray(d.steps) || !Array.isArray(d.tagIds)
      || !d.tagIds.every((id) => typeof id === "string") || !d.steps.every((step) => step && typeof step.title === "string")
      || typeof d.newStep !== "string" || typeof d.newTag !== "string" || !Number.isFinite(d.scrollTop)
      || ![d.titleSelection, d.bodySelection].every((range) => Array.isArray(range) && range.length === 2 && range.every((n) => Number.isInteger(n) && n >= 0))) return null;
  }
  return s;
}
export async function restoreNotesView(snapshot: NotesViewSnapshot) {
  const store = useNotesStore.getState();
  if (!store.prefsLoaded || !store.notesLoaded) await store.initPanel();
  if (!snapshot.activeNoteId) { useNotesStore.getState().setActiveNote(null); return; }
  const note = await getNote(snapshot.activeNoteId);
  if (!note) throw new Error("This note is no longer available. Keep the source window open.");
  if (snapshot.draft) drafts.set(note.id, snapshot.draft);
  useNotesStore.setState({ activeNoteId: note.id, activeNoteSnapshot: note });
  await waitShellReady(() => editor?.snapshot().noteId === note.id);
  if (snapshot.draft) { editor!.restore(snapshot.draft); drafts.delete(note.id); }
}
