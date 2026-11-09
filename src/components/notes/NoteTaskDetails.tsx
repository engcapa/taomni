import { useState } from "react";
import { X } from "lucide-react";
import type { NoteItem } from "../../lib/notes";
import { useNotesTaskStore } from "../../stores/notesTaskStore";
import { useT } from "../../lib/i18n";
import { NoteDateTimeField } from "./NoteDateTimeField";
import { NotesSelect } from "./NotesSelect";
import { NoteTaskSteps } from "./NoteTaskSteps";

const COLORS = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899"];

/** Same task controls and persistence owner in both Notes editors. */
export function NoteTaskDetails({ note, prefix = "note-editor" }: { note: NoteItem; prefix?: string }) {
  const t = useT();
  const [newTag, setNewTag] = useState("");
  const [addingTag, setAddingTag] = useState(false);
  const actions = useNotesTaskStore.getState();
  const addTag = () => {
    const name = newTag.trim();
    if (!name || addingTag) return;
    setAddingTag(true);
    void actions.addTag(note.id, name).then((saved) => {
      if (saved) setNewTag((current) => current.trim() === name ? "" : current);
    }).finally(() => setAddingTag(false));
  };
  return <div className="flex flex-col gap-2" data-testid={`${prefix}-task-details`}>
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      <label className="inline-flex items-center gap-1">
        <span className="text-[var(--taomni-text-muted)]">{t("notes.priority")}</span>
        <NotesSelect className="w-[90px]" value={note.priority}
          options={[0, 1, 2, 3].map((value) => ({ value, label: t(`notes.priority_${value}`) }))}
          onChange={(value) => { void actions.patch(note.id, { priority: Number(value) }); }}
          testId={`${prefix}-priority`} ariaLabel={t("notes.priority")}
          selectBg="var(--taomni-input-bg)" selectColor="var(--taomni-text)" selectBorder="var(--taomni-input-border)" />
      </label>
      <NoteDateTimeField label={t("notes.dueAt")} value={note.due_at} testId={`${prefix}-due`}
        onChange={(due_at) => { void actions.patch(note.id, { due_at }); }} />
      <NoteDateTimeField label={t("notes.reminderAt")} value={note.reminder_at} testId={`${prefix}-reminder`}
        onChange={(reminder_at) => { void actions.patch(note.id, { reminder_at }); }} />
      <NoteDateTimeField label={t("notes.completedAt")} value={note.completed_at} testId={`${prefix}-completed-at`}
        onChange={(completed_at) => { void actions.patch(note.id, { completed_at }); }} />
    </div>
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-[var(--taomni-text-muted)]">{t("notes.color")}</span>
      <button type="button" className={`inline-flex h-4 w-4 items-center justify-center rounded-full border border-[var(--taomni-divider)] ${note.color === null ? "ring-1 ring-[var(--taomni-accent)]" : ""}`}
        onClick={() => { void actions.patch(note.id, { color: null }); }} title={t("notes.clearColor")}
        aria-label={t("notes.clearColor")} data-testid={`${prefix}-color-clear`}><X className="h-2.5 w-2.5" /></button>
      {COLORS.map((color) => <button key={color} type="button"
        className={`h-4 w-4 rounded-full border border-[var(--taomni-divider)] ${note.color === color ? "ring-2 ring-[var(--taomni-accent)]" : ""}`}
        style={{ background: color }} onClick={() => { void actions.patch(note.id, { color }); }}
        aria-pressed={note.color === color} title={`${t("notes.color")} ${color}`} aria-label={`${t("notes.color")} ${color}`}
        data-testid={`${prefix}-color-${color}`} />)}
    </div>
    <NoteTaskSteps note={note} prefix={prefix} />
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-[var(--taomni-text-muted)]">{t("notes.tags")}</span>
      <div className="flex flex-wrap items-center gap-1">
        {note.tags.map((tag) => <span key={tag.id} data-testid={`${prefix}-tag`}
          className="inline-flex h-5 items-center gap-1 rounded-full border border-[var(--taomni-divider)] px-1.5 text-[10px]">
          #{tag.name}<button type="button" className="hover:text-red-400" title={`${t("notes.delete")} ${tag.name}`}
            aria-label={`${t("notes.delete")} ${tag.name}`} onClick={() => { void actions.removeTag(note.id, tag.id); }}><X className="h-2.5 w-2.5" /></button>
        </span>)}
        <input type="text" className="taomni-input h-5 w-24 text-[10px]" placeholder={t("notes.tagPlaceholder")}
          aria-label={t("notes.tags")} value={newTag} onChange={(event) => setNewTag(event.target.value)} data-testid={`${prefix}-new-tag`}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); addTag(); } }} />
      </div>
    </div>
  </div>;
}
