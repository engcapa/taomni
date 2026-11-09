import { useEffect, useState } from "react";
import { ArrowLeft, Maximize2 } from "lucide-react";
import type { NoteItem } from "../../lib/notes";
import { useT } from "../../lib/i18n";
import { NoteTextField } from "./NoteTextField";
import { useNotesContentStore } from "../../stores/notesContentStore";
import { NoteContentStatus } from "./NoteContentStatus";
import { openNoteWorkspace } from "../../lib/notes/notesWorkspaceNavigation";
import { useAppStore } from "../../stores/appStore";
import { useNoteTask } from "./useNoteTask";
import { NoteTaskActions, NoteTaskStatus } from "./NoteTaskActions";
import { NoteTaskDetails } from "./NoteTaskDetails";

export function NoteEditor({ note: fallback, onClose }: { note: NoteItem; onClose: () => void }) {
  const t = useT();
  const note = useNoteTask(fallback.id, fallback) ?? fallback;
  const document = useNotesContentStore((state) => state.documents[note.id]);
  const [openingWorkspace, setOpeningWorkspace] = useState(false);
  useEffect(() => { useNotesContentStore.getState().adopt(note); }, [note]);
  const save = () => { void useNotesContentStore.getState().save(note.id); };
  return <div className="flex-1 min-h-0 flex flex-col" data-testid="note-editor" data-note-id={note.id}>
    <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--taomni-divider)] px-2 py-1.5">
      <button type="button" className="taomni-btn inline-flex h-6 w-6 items-center justify-center p-0"
        onClick={onClose} title={t("notes.close")} aria-label={t("notes.close")} data-testid="note-editor-back">
        <ArrowLeft className="h-3.5 w-3.5" />
      </button>
      <NoteTaskActions note={note} onDeleted={onClose} />
      <div className="flex-1" />
      <button type="button" className="taomni-btn inline-flex h-6 w-6 items-center justify-center p-0"
        data-testid="note-editor-preview" title={t("notes.largePreview")} aria-label={t("notes.largePreview")}
        disabled={openingWorkspace} onClick={() => {
          setOpeningWorkspace(true);
          void (async () => {
            if (await useNotesContentStore.getState().save(note.id)) await openNoteWorkspace(note, "preview");
          })().catch((error) => useAppStore.getState().setStatusMessage(String(error))).finally(() => setOpeningWorkspace(false));
        }}><Maximize2 className="h-3.5 w-3.5" /></button>
    </div>
    <div className="h-1 shrink-0" style={{ background: note.color ?? "transparent" }} data-testid="note-editor-color-strip" />
    <NoteContentStatus noteId={note.id} />
    <NoteTaskStatus noteId={note.id} />
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
      <NoteTextField kind="title" value={document?.title ?? note.title}
        onChange={(title) => useNotesContentStore.getState().edit(note, { title })} onBlur={save} />
      <NoteTextField kind="body" value={document?.body ?? note.body}
        onChange={(body) => useNotesContentStore.getState().edit(note, { body })} onBlur={save} />
      <NoteTaskDetails key={note.id} note={note} />
    </div>
  </div>;
}
