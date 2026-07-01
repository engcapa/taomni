import { CheckCircle2, Circle, Pin } from "lucide-react";
import type { NoteItem } from "../../lib/notes";
import { useT } from "../../lib/i18n";

interface NotesListProps {
  notes: NoteItem[];
  activeNoteId: string | null;
  onSelect: (id: string) => void;
  onToggleComplete: (id: string, completed: boolean) => void;
}

/** A compact, scrollable list of note cards. */
export function NotesList({ notes, activeNoteId, onSelect, onToggleComplete }: NotesListProps) {
  const t = useT();
  return (
    <ul className="flex flex-col" data-testid="notes-list">
      {notes.map((note) => {
        const done = note.completed_at !== null;
        const stepTotal = note.steps.length;
        const stepDone = note.steps.filter((s) => s.completed_at !== null).length;
        return (
          <li key={note.id}>
            <div
              role="button"
              tabIndex={0}
              data-testid="notes-list-item"
              data-note-id={note.id}
              aria-current={activeNoteId === note.id || undefined}
              className={`group flex items-start gap-2 px-2 py-1.5 border-b border-[var(--taomni-divider)] cursor-pointer hover:bg-[var(--taomni-hover)] ${
                activeNoteId === note.id ? "bg-[var(--taomni-selected)]" : ""
              }`}
              onClick={() => onSelect(note.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(note.id);
                }
              }}
            >
              <button
                type="button"
                className="mt-0.5 shrink-0 text-[var(--taomni-text-muted)] hover:text-[var(--taomni-accent)]"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleComplete(note.id, !done);
                }}
                title={done ? t("notes.reopen") : t("notes.complete")}
                aria-label={done ? t("notes.reopen") : t("notes.complete")}
                aria-pressed={done}
                data-testid="notes-toggle-complete"
              >
                {done ? (
                  <CheckCircle2 className="w-4 h-4 text-green-400" />
                ) : (
                  <Circle className="w-4 h-4" />
                )}
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  {note.pinned && <Pin className="w-3 h-3 shrink-0 text-[var(--taomni-accent)]" />}
                  <span
                    className={`text-[12px] truncate ${
                      done ? "line-through text-[var(--taomni-text-muted)]" : ""
                    }`}
                  >
                    {note.title.trim() || t("notes.untitled")}
                  </span>
                </div>
                {note.body.trim() && (
                  <div className="text-[11px] text-[var(--taomni-text-muted)] truncate">
                    {note.body.trim()}
                  </div>
                )}
                {stepTotal > 0 && (
                  <div className="text-[10px] text-[var(--taomni-text-muted)]">
                    {t("notes.stepProgress", { done: stepDone, total: stepTotal })}
                  </div>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
