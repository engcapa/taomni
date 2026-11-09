import { Archive, ArchiveRestore, CheckCircle2, Circle, Pin, Trash2 } from "lucide-react";
import type { NoteItem } from "../../lib/notes";
import { confirmAppDialog } from "../../lib/appDialogs";
import { useT } from "../../lib/i18n";
import { useNotesTaskStore } from "../../stores/notesTaskStore";

export function NoteTaskActions({ note, prefix = "note-editor", onDeleted }: {
  note: NoteItem; prefix?: string; onDeleted: () => void;
}) {
  const t = useT();
  const pending = useNotesTaskStore((state) => (state.pending[note.id] ?? 0) > 0);
  const done = note.completed_at !== null;
  const archived = note.archived_at !== null;
  const actions = useNotesTaskStore.getState();
  return <div className="flex shrink-0 items-center gap-1" data-testid={`${prefix}-task-actions`}>
    <button type="button" className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
      disabled={pending} data-testid={`${prefix}-complete`} aria-pressed={done}
      title={t(done ? "notes.reopen" : "notes.complete")} aria-label={t(done ? "notes.reopen" : "notes.complete")}
      onClick={() => { void actions.complete(note.id, !done); }}>
      {done ? <CheckCircle2 className="h-3.5 w-3.5 text-green-400" /> : <Circle className="h-3.5 w-3.5" />}
    </button>
    <button type="button" className={`taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center ${note.pinned ? "text-[var(--taomni-accent)]" : ""}`}
      disabled={pending} data-testid={`${prefix}-pin`} aria-pressed={note.pinned}
      title={t(note.pinned ? "notes.unpin" : "notes.pin")} aria-label={t(note.pinned ? "notes.unpin" : "notes.pin")}
      onClick={() => { void actions.patch(note.id, { pinned: !note.pinned }); }}><Pin className="h-3.5 w-3.5" /></button>
    <button type="button" className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
      disabled={pending} data-testid={`${prefix}-archive`} aria-pressed={archived}
      title={t(archived ? "notes.unarchive" : "notes.archive")} aria-label={t(archived ? "notes.unarchive" : "notes.archive")}
      onClick={() => { void actions.archive(note.id, !archived); }}>
      {archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
    </button>
    <button type="button" className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center hover:text-red-400"
      disabled={pending} data-testid={`${prefix}-delete`} title={t("notes.delete")} aria-label={t("notes.delete")}
      onClick={() => { void (async () => {
        if (await confirmAppDialog({ message: t("notes.deleteConfirm"), confirmLabel: t("notes.delete"), danger: true })) {
          if (await actions.remove(note.id)) onDeleted();
        }
      })(); }}><Trash2 className="h-3.5 w-3.5" /></button>
  </div>;
}

export function NoteTaskStatus({ noteId }: { noteId: string }) {
  const t = useT();
  const error = useNotesTaskStore((state) => state.errors[noteId]);
  const pending = useNotesTaskStore((state) => (state.pending[noteId] ?? 0) > 0);
  if (!error) return null;
  return <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 px-2 py-1 text-xs text-red-400">
    <span title={error}>{t("notes.taskSaveFailed")}</span>
    <button type="button" className="taomni-btn px-2" disabled={pending}
      onClick={() => { void useNotesTaskStore.getState().retry(noteId); }}>{t("notes.retrySave")}</button>
  </div>;
}
