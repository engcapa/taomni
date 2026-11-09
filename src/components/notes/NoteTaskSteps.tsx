import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Circle, Plus, X } from "lucide-react";
import { nowSecs, type NoteItem, type NoteStep } from "../../lib/notes";
import { useNotesTaskStore } from "../../stores/notesTaskStore";
import { useT } from "../../lib/i18n";

function TaskStep({ step, prefix }: { step: NoteStep; prefix: string }) {
  const t = useT();
  const [title, setTitle] = useState(step.title);
  const [dirty, setDirty] = useState(false);
  const revision = useRef(0);
  useEffect(() => { if (!dirty) setTitle(step.title); }, [step.title, dirty]);
  const done = step.completed_at !== null;
  const change = useNotesTaskStore.getState().changeSteps;
  const commit = () => {
    if (!dirty) return;
    const submittedRevision = revision.current;
    void change(step.note_id, (steps) => steps.map((item) => item.id === step.id ? { ...item, title } : item))
      .then((saved) => { if (saved && revision.current === submittedRevision) setDirty(false); });
  };
  return <div className="flex items-center gap-1.5" data-testid={`${prefix}-step`} data-step-id={step.id}>
    <button type="button" className="shrink-0 text-[var(--taomni-text-muted)] hover:text-[var(--taomni-accent)]"
      data-testid={`${prefix}-step-complete`} aria-pressed={done}
      title={t(done ? "notes.reopen" : "notes.complete")} aria-label={t(done ? "notes.reopen" : "notes.complete")}
      onClick={() => { void change(step.note_id, (steps) => steps.map((item) => item.id === step.id
        ? { ...item, completed_at: item.completed_at == null ? nowSecs() : null } : item)); }}>
      {done ? <CheckCircle2 className="h-3.5 w-3.5 text-green-400" /> : <Circle className="h-3.5 w-3.5" />}
    </button>
    <input type="text" className={`taomni-input h-6 min-w-0 flex-1 text-[11px] ${done ? "line-through text-[var(--taomni-text-muted)]" : ""}`}
      aria-label={t("notes.steps")} value={title} onChange={(event) => { revision.current += 1; setTitle(event.target.value); setDirty(true); }} onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); commit(); } }} />
    <button type="button" className="shrink-0 text-[var(--taomni-text-muted)] hover:text-red-400"
      data-testid={`${prefix}-step-delete`} title={t("notes.delete")} aria-label={t("notes.delete")}
      onClick={() => { void change(step.note_id, (steps) => steps.filter((item) => item.id !== step.id)); }}><X className="h-3 w-3" /></button>
  </div>;
}

export function NoteTaskSteps({ note, prefix }: { note: NoteItem; prefix: string }) {
  const t = useT();
  const [newStep, setNewStep] = useState("");
  const [adding, setAdding] = useState(false);
  const add = () => {
    const title = newStep.trim();
    if (!title || adding) return;
    setAdding(true);
    const id = crypto.randomUUID();
    void useNotesTaskStore.getState().changeSteps(note.id, (steps) => steps.some((step) => step.id === id)
      ? steps : [...steps, { id, title, completed_at: null }])
      .then((saved) => { if (saved) setNewStep((current) => current.trim() === title ? "" : current); })
      .finally(() => setAdding(false));
  };
  return <div className="flex min-w-0 flex-col gap-1">
    <span className="text-[11px] text-[var(--taomni-text-muted)]">{t("notes.steps")}</span>
    {note.steps.map((step) => <TaskStep key={step.id} step={step} prefix={prefix} />)}
    <div className="flex items-center gap-1.5">
      <input type="text" className="taomni-input h-6 min-w-0 flex-1 text-[11px]" value={newStep}
        placeholder={t("notes.stepPlaceholder")} aria-label={t("notes.addStep")} data-testid={`${prefix}-new-step`}
        onChange={(event) => setNewStep(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); add(); } }} />
      <button type="button" className="taomni-btn inline-flex h-6 w-6 items-center justify-center p-0"
        disabled={adding} data-testid={`${prefix}-add-step`} title={t("notes.addStep")} aria-label={t("notes.addStep")}
        onClick={add}><Plus className="h-3.5 w-3.5" /></button>
    </div>
  </div>;
}
