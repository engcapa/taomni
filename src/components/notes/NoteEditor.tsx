import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type UIEvent as ReactUIEvent,
} from "react";
import { open as tauriOpen } from "@tauri-apps/plugin-shell";
import { ArrowLeft, Archive, ArchiveRestore, CheckCircle2, Circle, Pin, Plus, Trash2, X } from "lucide-react";
import type { NoteItem, StepInput, UpdateNoteInput } from "../../lib/notes";
import { useNotesStore } from "../../stores/notesStore";
import { confirmAppDialog } from "../../lib/appDialogs";
import { useT } from "../../lib/i18n";
import { NoteDateTimeField } from "./NoteDateTimeField";
import { extractNoteUrls, findNoteUrlAtIndex } from "../../lib/notes/noteLinks";
import { isTauriRuntime } from "../../lib/runtime";
import { renderLinkedNoteText } from "./NoteLinkText";

const COLOR_SWATCHES = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899"];
const PRIORITIES = [0, 1, 2, 3] as const;
type TextCursor = "text" | "pointer";

let noteTextMeasureContext: CanvasRenderingContext2D | null | undefined;

function getTextMeasureContext(): CanvasRenderingContext2D | null {
  if (noteTextMeasureContext !== undefined) return noteTextMeasureContext;
  if (typeof document === "undefined") {
    noteTextMeasureContext = null;
    return noteTextMeasureContext;
  }
  noteTextMeasureContext = document.createElement("canvas").getContext("2d");
  return noteTextMeasureContext;
}

function syncMeasureFont(ctx: CanvasRenderingContext2D, element: HTMLElement) {
  const style = window.getComputedStyle(element);
  ctx.font = style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}

function textIndexAtX(ctx: CanvasRenderingContext2D, line: string, startIndex: number, x: number): number {
  if (x <= 0) return startIndex;
  let previousWidth = 0;
  for (let i = 0; i < line.length; i += 1) {
    const width = ctx.measureText(line.slice(0, i + 1)).width;
    if (x < (previousWidth + width) / 2) return startIndex + i;
    previousWidth = width;
  }
  return startIndex + line.length;
}

function pointToInputTextIndex(
  element: HTMLInputElement | HTMLTextAreaElement,
  text: string,
  clientX: number,
  clientY: number,
): number | null {
  const ctx = getTextMeasureContext();
  if (!ctx) return null;
  const style = window.getComputedStyle(element);
  syncMeasureFont(ctx, element);
  const rect = element.getBoundingClientRect();
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(style.paddingRight) || 0;
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const fontSize = Number.parseFloat(style.fontSize) || 12;
  const parsedLineHeight = Number.parseFloat(style.lineHeight);
  const lineHeight = Number.isFinite(parsedLineHeight) ? parsedLineHeight : fontSize * 1.35;
  const x = clientX - rect.left - paddingLeft + element.scrollLeft;

  if (element instanceof HTMLInputElement) {
    return textIndexAtX(ctx, text, 0, x);
  }

  const y = clientY - rect.top - paddingTop + element.scrollTop;
  const contentWidth = Math.max(1, element.clientWidth - paddingLeft - paddingRight);
  const lines: Array<{ start: number; text: string }> = [];
  let lineStart = 0;
  let lineText = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\n") {
      lines.push({ start: lineStart, text: lineText });
      lineStart = i + 1;
      lineText = "";
      continue;
    }
    const next = `${lineText}${char}`;
    if (lineText && ctx.measureText(next).width > contentWidth) {
      lines.push({ start: lineStart, text: lineText });
      lineStart = i;
      lineText = char;
    } else {
      lineText = next;
    }
  }
  lines.push({ start: lineStart, text: lineText });
  const visualLineIndex = Math.max(0, Math.min(lines.length - 1, Math.floor(y / lineHeight)));
  const line = lines[visualLineIndex];
  return textIndexAtX(ctx, line.text, line.start, x);
}

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

  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [steps, setLocalSteps] = useState<StepInput[]>(() =>
    note.steps.map((s) => ({ id: s.id, title: s.title, completed_at: s.completed_at, sort_order: s.sort_order })),
  );
  const [tagIds, setTagIds] = useState<string[]>(() => note.tags.map((tg) => tg.id));
  const [newStep, setNewStep] = useState("");
  const [newTag, setNewTag] = useState("");
  const [titleCursor, setTitleCursor] = useState<TextCursor>("text");
  const [bodyCursor, setBodyCursor] = useState<TextCursor>("text");
  const noteIdRef = useRef(note.id);
  const bodyLinkOverlayRef = useRef<HTMLDivElement | null>(null);

  // Resync the draft when a different note is selected.
  useEffect(() => {
    if (noteIdRef.current !== note.id) {
      noteIdRef.current = note.id;
      setTitle(note.title);
      setBody(note.body);
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
    const patch: UpdateNoteInput = {
      title,
      body,
      pinned: note.pinned,
      color: note.color,
      priority: note.priority,
      due_at: note.due_at,
      reminder_at: note.reminder_at,
      repeat_rule: note.repeat_rule,
      source_tab_id: note.source_tab_id,
      source_session_id: note.source_session_id,
      source_title: note.source_title,
      source_uri: note.source_uri,
      tag_ids: tagIds,
      ...override,
    };
    void updateNote(note.id, patch);
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
  const titleHasUrl = useMemo(() => extractNoteUrls(title).length > 0, [title]);
  const bodyHasUrl = useMemo(() => extractNoteUrls(body).length > 0, [body]);
  const titleLinkPreview = useMemo(() => renderLinkedNoteText(title), [title]);
  const bodyLinkPreview = useMemo(() => renderLinkedNoteText(body), [body]);

  useEffect(() => {
    if (!titleHasUrl) setTitleCursor("text");
  }, [titleHasUrl]);

  useEffect(() => {
    if (!bodyHasUrl) setBodyCursor("text");
  }, [bodyHasUrl]);

  const openNoteUrl = (url: string) => {
    if (isTauriRuntime()) {
      void tauriOpen(url).catch((err) => {
        console.error("notes: failed to open URL", err);
      });
      return;
    }
    const newWindow = window.open(url, "_blank", "noopener,noreferrer");
    if (newWindow) newWindow.opener = null;
  };

  const handleTextUrlClick = (
    event: ReactMouseEvent<HTMLInputElement | HTMLTextAreaElement>,
    text: string,
  ) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const match = findNoteUrlAtIndex(text, event.currentTarget.selectionStart ?? 0);
    if (!match) return;
    event.preventDefault();
    openNoteUrl(match.url);
  };

  const updateUrlCursor = (
    event: ReactMouseEvent<HTMLInputElement | HTMLTextAreaElement>,
    text: string,
    setCursor: (cursor: TextCursor) => void,
  ) => {
    const index = pointToInputTextIndex(event.currentTarget, text, event.clientX, event.clientY);
    setCursor(index !== null && findNoteUrlAtIndex(text, index) ? "pointer" : "text");
  };

  const syncBodyLinkOverlayScroll = (event: ReactUIEvent<HTMLTextAreaElement>) => {
    if (bodyLinkOverlayRef.current) {
      bodyLinkOverlayRef.current.scrollTop = event.currentTarget.scrollTop;
    }
  };

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
          className="taomni-btn h-6 px-2 inline-flex items-center gap-1 text-[11px]"
          onClick={() => void toggleComplete(note.id, !done)}
          aria-pressed={done}
          data-testid="note-editor-complete"
        >
          {done ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400" /> : <Circle className="w-3.5 h-3.5" />}
          <span>{done ? t("notes.completed") : t("notes.complete")}</span>
        </button>
        <div className="flex-1" />
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
      <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-2">
        <div className="notes-link-field-shell" data-has-url={titleHasUrl || undefined}>
          {titleHasUrl && (
            <div
              className="notes-link-overlay notes-link-overlay-title"
              aria-hidden="true"
              data-testid="note-editor-title-link-preview"
            >
              {titleLinkPreview}
            </div>
          )}
          <input
            type="text"
            className="taomni-input h-7 text-[13px] font-semibold w-full"
            placeholder={t("notes.titlePlaceholder")}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onClick={(e) => handleTextUrlClick(e, title)}
            onMouseMove={(e) => updateUrlCursor(e, title, setTitleCursor)}
            onMouseLeave={() => setTitleCursor("text")}
            onBlur={() => commit({ title })}
            style={{ cursor: titleCursor }}
            data-testid="note-editor-title"
            data-has-url={titleHasUrl || undefined}
          />
        </div>
        <div className="notes-link-field-shell" data-has-url={bodyHasUrl || undefined}>
          {bodyHasUrl && (
            <div
              ref={bodyLinkOverlayRef}
              className="notes-link-overlay notes-link-overlay-body"
              aria-hidden="true"
              data-testid="note-editor-body-link-preview"
            >
              {bodyLinkPreview}
            </div>
          )}
          <textarea
            className="taomni-input notes-link-textarea text-[12px] w-full resize-none min-h-[80px]"
            placeholder={t("notes.bodyPlaceholder")}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onClick={(e) => handleTextUrlClick(e, body)}
            onMouseMove={(e) => updateUrlCursor(e, body, setBodyCursor)}
            onMouseLeave={() => setBodyCursor("text")}
            onScroll={syncBodyLinkOverlayScroll}
            onBlur={() => commit({ body })}
            style={{ cursor: bodyCursor }}
            rows={4}
            data-testid="note-editor-body"
            data-has-url={bodyHasUrl || undefined}
          />
        </div>

        {/* Priority + dates */}
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <label className="inline-flex items-center gap-1">
            <span className="text-[var(--taomni-text-muted)]">{t("notes.priority")}</span>
            <select
              className="taomni-input h-6 text-[11px] px-1"
              value={note.priority}
              onChange={(e) => commit({ priority: Number(e.target.value) })}
              data-testid="note-editor-priority"
              aria-label={t("notes.priority")}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {t(`notes.priority_${p}`)}
                </option>
              ))}
            </select>
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
