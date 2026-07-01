import { useEffect } from "react";
import { Plus, Search } from "lucide-react";
import { useNotesStore } from "../../stores/notesStore";
import { useT } from "../../lib/i18n";
import { NotesList } from "./NotesList";

/**
 * NotesPanel — the 便签 tab content inside the Tao Hub. Phase 4 provides the
 * toolbar (new note + search) and the list; Phase 5 layers the full editor,
 * filter views, tags, steps, and due/reminder controls on top.
 */
export function NotesPanel() {
  const t = useT();
  const notes = useNotesStore((s) => s.notes);
  const loading = useNotesStore((s) => s.loading);
  const search = useNotesStore((s) => s.search);
  const notesLoaded = useNotesStore((s) => s.notesLoaded);
  const loadNotes = useNotesStore((s) => s.loadNotes);
  const loadPrefs = useNotesStore((s) => s.loadPrefs);
  const prefsLoaded = useNotesStore((s) => s.prefsLoaded);
  const setSearch = useNotesStore((s) => s.setSearch);
  const createNote = useNotesStore((s) => s.createNote);
  const toggleComplete = useNotesStore((s) => s.toggleComplete);
  const setActiveNote = useNotesStore((s) => s.setActiveNote);
  const activeNoteId = useNotesStore((s) => s.activeNoteId);

  useEffect(() => {
    if (!prefsLoaded) void loadPrefs();
    if (!notesLoaded) void loadNotes();
  }, [prefsLoaded, notesLoaded, loadPrefs, loadNotes]);

  return (
    <div
      className="flex-1 min-h-0 flex flex-col"
      data-testid="notes-panel"
      style={{ background: "var(--taomni-sidebar-bg)" }}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--taomni-divider)] shrink-0">
        <button
          type="button"
          className="taomni-btn h-6 px-2 inline-flex items-center gap-1 text-[11px]"
          onClick={() => void createNote({ title: "" })}
          title={t("notes.newNote")}
          aria-label={t("notes.newNoteAria")}
          data-testid="notes-new"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>{t("notes.newNote")}</span>
        </button>
        <div className="relative flex-1 min-w-0">
          <Search className="w-3 h-3 absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
          <input
            type="text"
            className="taomni-input h-6 w-full text-[11px] pl-6 pr-2"
            placeholder={t("notes.searchPlaceholder")}
            aria-label={t("notes.searchAria")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="notes-search"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && notes.length === 0 ? (
          <div className="p-4 text-center text-[11px] text-[var(--taomni-text-muted)]">
            {t("notes.loading")}
          </div>
        ) : notes.length === 0 ? (
          <div className="p-6 text-center text-[12px] text-[var(--taomni-text-muted)]">
            <div>{search ? t("notes.emptyFiltered") : t("notes.empty")}</div>
            {!search && <div className="mt-1 text-[11px]">{t("notes.emptyHint")}</div>}
          </div>
        ) : (
          <NotesList
            notes={notes}
            activeNoteId={activeNoteId}
            onSelect={setActiveNote}
            onToggleComplete={(id, completed) => void toggleComplete(id, completed)}
          />
        )}
      </div>
    </div>
  );
}
