import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Archive, ArchiveRestore, CheckCircle2, Circle, Maximize2, Pin, Plus, Trash2, X } from "lucide-react";
import type { NoteItem, StepInput, UpdateNoteInput } from "../../lib/notes";
import { useNotesStore } from "../../stores/notesStore";
import { confirmAppDialog } from "../../lib/appDialogs";
import { useT } from "../../lib/i18n";
import { notesThemeStyle } from "../../lib/notes/notesTheme";
import { NotesSelect } from "./NotesSelect";
import { NoteDateTimeField } from "./NoteDateTimeField";
import { NoteTextField } from "./NoteTextField";
import { useNotesContentStore } from "../../stores/notesContentStore";
import { NoteContentStatus } from "./NoteContentStatus";
import { getNote } from "../../lib/notes";
import { openNoteWorkspace } from "../../lib/notes/notesWorkspaceNavigation";
import { useAppStore } from "../../stores/appStore";

const COLOR_SWATCHES = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899"];
const PRIORITIES = [0, 1, 2, 3] as const;
interface NoteEditorProps {
  note: NoteItem;
  onClose: () => void;
}

/**
 * NoteEditor — the detail/edit pane for a single note. Uses a local draft synced
 * from the selected note; text fields commit on blur, toggles/selects commit
 * immediately. Steps and tags are persisted through their own store actions.
 */
export function NoteEditor({ note, onClose }: NoteEditorProps) {
  const t = useT();
  const updateNote = useNotesStore((s) => s.updateNote);
  const toggleComplete = useNotesStore((s) => s.toggleComplete);
  const archiveNote = useNotesStore((s) => s.archiveNote);
  const deleteNote = useNotesStore((s) => s.deleteNote);
  const setSteps = useNotesStore((s) => s.setSteps);
  const upsertTags = useNotesStore((s) => s.upsertTags);
  const allTags = useNotesStore((s) => s.tags);
  const theme = useNotesStore((s) => s.theme);
  const themeStyle = notesThemeStyle(theme);
  const selectBg = themeStyle["--taomni-input-bg" as keyof typeof themeStyle] as string | undefined;
  const selectColor = themeStyle["--taomni-text" as keyof typeof themeStyle] as string | undefined;
  const selectBorder = themeStyle["--taomni-input-border" as keyof typeof themeStyle] as string | undefined;

  const document = useNotesContentStore((state) => state.documents[note.id]);
  const title = document?.title ?? note.title;
  const body = document?.body ?? note.body;
  const setTitle = (value: string) => useNotesContentStore.getState().edit(note, { title: value });
  const setBody = (value: string) => useNotesContentStore.getState().edit(note, { body: value });
  const [openingWorkspace, setOpeningWorkspace] = useState(false);
  const [steps, setLocalSteps] = useState<StepInput[]>(() =>
    note.steps.map((s) => ({ id: s.id, title: s.title, completed_at: s.completed_at, sort_order: s.sort_order })),
  );
  const [tagIds, setTagIds] = useState<string[]>(() => note.tags.map((tg) => tg.id));
  const [newStep, setNewStep] = useState("");
  const [newTag, setNewTag] = useState("");
  const noteIdRef = useRef(note.id);

  useEffect(() => { useNotesContentStore.getState().adopt(note); }, [note]);

  // Resync the draft when a different note is selected.
  useEffect(() => {
    if (noteIdRef.current !== note.id) {
      noteIdRef.current = note.id;
      setLocalSteps(
        note.steps.map((s) => ({ id: s.id, title: s.title, completed_at: s.completed_at, sort_order: s.sort_order })),
      );
      setTagIds(note.tags.map((tg) => tg.id));
      setNewStep("");
      setNewTag("");
    }
  }, [note]);

  const done = note.completed_at !== null;
  const archived = note.archived_at !== null;

  // Build a full-replace patch from the current draft + an override.
  const commit = (override: Partial<UpdateNoteInput> = {}) => {
    void (async () => {
      if (!await useNotesContentStore.getState().save(note.id)) return;
      // Content-only edits must not replace task metadata from an older render.
      if (!Object.keys(override).some((key) => key !== "title" && key !== "body")) return;
      const latest = await getNote(note.id);
      if (!latest) return;
      await updateNote(note.id, {
        ...latest, tag_ids: latest.tags.map((tag) => tag.id), ...override,
        title: latest.title, body: latest.body,
      });
    })().catch((error) => console.error("notes: metadata save failed", error));
  };

  const persistSteps = (next: StepInput[]) => {
    setLocalSteps(next);
    void setSteps(note.id, next.map((s, i) => ({ ...s, sort_order: i })));
  };

  const addTagByName = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const created = await upsertTags([{ name: trimmed }]);
    const tag = created[0];
    if (tag && !tagIds.includes(tag.id)) {
      const next = [...tagIds, tag.id];
      setTagIds(next);
      commit({ tag_ids: next });
    }
    setNewTag("");
  };

  const removeTag = (id: string) => {
    const next = tagIds.filter((t) => t !== id);
    setTagIds(next);
    commit({ tag_ids: next });
  };

  const tagName = useMemo(() => {
    const map = new Map(allTags.map((tg) => [tg.id, tg]));
    return (id: string) => map.get(id)?.name ?? note.tags.find((tg) => tg.id === id)?.name ?? id;
  }, [allTags, note.tags]);
  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="note-editor" data-note-id={note.id}>
      {/* Editor header */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--taomni-divider)] shrink-0">
        <button
          type="button"
          className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
          onClick={onClose}
          title={t("notes.close")}
          aria-label={t("notes.close")}
          data-testid="note-editor-back"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
          onClick={() => void toggleComplete(note.id, !done)}
          title={done ? t("notes.reopen") : t("notes.complete")}
          aria-label={done ? t("notes.reopen") : t("notes.complete")}
          aria-pressed={done}
          data-testid="note-editor-complete"
        >
          {done ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400" /> : <Circle className="w-3.5 h-3.5" />}
        </button>
        <div className="flex-1" />
        <button type="button" className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
          data-testid="note-editor-preview" title={t("notes.largePreview")} aria-label={t("notes.largePreview")}
          disabled={openingWorkspace}
          onClick={() => {
            setOpeningWorkspace(true);
            void (async () => {
              if (await useNotesContentStore.getState().save(note.id)) await openNoteWorkspace(note, "preview");
            })().catch((error) => useAppStore.getState().setStatusMessage(String(error))).finally(() => setOpeningWorkspace(false));
          }}><Maximize2 className="h-3.5 w-3.5" /></button>
        <button
          type="button"
          className={`taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center ${note.pinned ? "text-[var(--taomni-accent)]" : ""}`}
          onClick={() => commit({ pinned: !note.pinned })}
          title={note.pinned ? t("notes.unpin") : t("notes.pin")}
          aria-label={note.pinned ? t("notes.unpin") : t("notes.pin")}
          aria-pressed={note.pinned}
          data-testid="note-editor-pin"
        >
          <Pin className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
          onClick={() => void archiveNote(note.id, !archived)}
          title={archived ? t("notes.unarchive") : t("notes.archive")}
          aria-label={archived ? t("notes.unarchive") : t("notes.archive")}
          data-testid="note-editor-archive"
        >
          {archived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
        </button>
        <button
          type="button"
          className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center hover:text-red-400"
          onClick={() => {
            void (async () => {
              const confirmed = await confirmAppDialog({
                message: t("notes.deleteConfirm"),
                confirmLabel: t("notes.delete"),
                danger: true,
              });
              if (confirmed) {
                await deleteNote(note.id);
                onClose();
              }
            })();
          }}
          title={t("notes.delete")}
          aria-label={t("notes.delete")}
          data-testid="note-editor-delete"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <div
        className="h-1 shrink-0"
        style={{ background: note.color ?? "transparent" }}
        data-testid="note-editor-color-strip"
      />

      {/* Editable fields */}
      <NoteContentStatus noteId={note.id} />
      <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-2">
        <NoteTextField kind="title" value={title} onChange={setTitle} onBlur={() => commit({ title })} />
        <NoteTextField kind="body" value={body} onChange={setBody} onBlur={() => commit({ body })} />

        {/* Priority + dates */}
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <label className="inline-flex items-center gap-1">
            <span className="text-[var(--taomni-text-muted)]">{t("notes.priority")}</span>
            <NotesSelect
              className="w-[90px]"
              value={note.priority}
              options={PRIORITIES.map((p) => ({
                value: p,
                label: t(`notes.priority_${p}`),
              }))}
              onChange={(val) => commit({ priority: Number(val) })}
              testId="note-editor-priority"
              ariaLabel={t("notes.priority")}
              selectBg={selectBg}
              selectColor={selectColor}
              selectBorder={selectBorder}
            />
          </label>
          <NoteDateTimeField
            label={t("notes.dueAt")}
            value={note.due_at}
            onChange={(due_at) => commit({ due_at })}
            testId="note-editor-due"
          />
          <NoteDateTimeField
            label={t("notes.reminderAt")}
            value={note.reminder_at}
            onChange={(reminder_at) => commit({ reminder_at })}
            testId="note-editor-reminder"
          />
        </div>

        {/* Color */}
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-[var(--taomni-text-muted)]">{t("notes.color")}</span>
          <button
            type="button"
            className={`w-4 h-4 rounded-full border border-[var(--taomni-divider)] inline-flex items-center justify-center ${note.color === null ? "ring-1 ring-[var(--taomni-accent)]" : ""}`}
            onClick={() => commit({ color: null })}
            title={t("notes.clearColor")}
            aria-label={`${t("notes.color")} none`}
          >
            <X className="w-2.5 h-2.5" />
          </button>
          {COLOR_SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              className={`w-4 h-4 rounded-full border border-[var(--taomni-divider)] ${note.color === c ? "ring-2 ring-offset-1 ring-[var(--taomni-accent)]" : ""}`}
              style={{ background: c }}
              onClick={() => commit({ color: c })}
              title={`${t("notes.color")} ${c}`}
              aria-label={`${t("notes.color")} ${c}`}
              data-testid={`note-editor-color-${c}`}
            />
          ))}
        </div>

        {/* Steps */}
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-[var(--taomni-text-muted)]">{t("notes.steps")}</span>
          {steps.map((step, i) => {
            const stepDone = step.completed_at != null;
            return (
              <div key={step.id ?? i} className="flex items-center gap-1.5" data-testid="note-editor-step">
                <button
                  type="button"
                  className="shrink-0 text-[var(--taomni-text-muted)] hover:text-[var(--taomni-accent)]"
                  onClick={() =>
                    persistSteps(
                      steps.map((s, j) =>
                        j === i ? { ...s, completed_at: stepDone ? null : Math.floor(Date.now() / 1000) } : s,
                      ),
                    )
                  }
                  aria-pressed={stepDone}
                  title={stepDone ? t("notes.reopen") : t("notes.complete")}
                  aria-label={stepDone ? t("notes.reopen") : t("notes.complete")}
                >
                  {stepDone ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400" /> : <Circle className="w-3.5 h-3.5" />}
                </button>
                <input
                  type="text"
                  className={`taomni-input h-6 text-[11px] flex-1 ${stepDone ? "line-through text-[var(--taomni-text-muted)]" : ""}`}
                  value={step.title}
                  onChange={(e) =>
                    setLocalSteps(steps.map((s, j) => (j === i ? { ...s, title: e.target.value } : s)))
                  }
                  onBlur={() => persistSteps(steps)}
                />
                <button
                  type="button"
                  className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center hover:text-red-400"
                  onClick={() => persistSteps(steps.filter((_, j) => j !== i))}
                  title={t("notes.delete")}
                  aria-label={t("notes.delete")}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              className="taomni-input h-6 text-[11px] flex-1"
              placeholder={t("notes.stepPlaceholder")}
              value={newStep}
              onChange={(e) => setNewStep(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newStep.trim()) {
                  persistSteps([...steps, { title: newStep.trim(), completed_at: null }]);
                  setNewStep("");
                }
              }}
              data-testid="note-editor-new-step"
            />
            <button
              type="button"
              className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
              onClick={() => {
                if (newStep.trim()) {
                  persistSteps([...steps, { title: newStep.trim(), completed_at: null }]);
                  setNewStep("");
                }
              }}
              title={t("notes.addStep")}
              aria-label={t("notes.addStep")}
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Tags */}
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-[var(--taomni-text-muted)]">{t("notes.tags")}</span>
          <div className="flex flex-wrap items-center gap-1">
            {tagIds.map((id) => (
              <span
                key={id}
                className="inline-flex items-center gap-1 h-5 px-1.5 rounded-full text-[10px] border border-[var(--taomni-divider)]"
                data-testid="note-editor-tag"
              >
                #{tagName(id)}
                <button
                  type="button"
                  className="hover:text-red-400"
                  onClick={() => removeTag(id)}
                  title={`${t("notes.delete")} ${tagName(id)}`}
                  aria-label={`${t("notes.delete")} ${tagName(id)}`}
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </span>
            ))}
            <input
              type="text"
              className="taomni-input h-5 text-[10px] w-24"
              placeholder={t("notes.tagPlaceholder")}
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void addTagByName(newTag);
                }
              }}
              data-testid="note-editor-new-tag"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
