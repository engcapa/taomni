import { useEffect, useRef, useState } from "react";
import { Monitor, PanelRightClose, Plus, Search, Settings } from "lucide-react";
import { useNotesStore } from "../../stores/notesStore";
import { useT } from "../../lib/i18n";
import { NotesList } from "./NotesList";
import { NoteStatusFilter, NoteTagFilters } from "./NoteFilters";
import { NoteEditor } from "./NoteEditor";
import { NoteThemeSettings } from "./NoteThemeSettings";
import { notesFontSizeStyle, notesFontStyle, notesThemeDensity, notesThemeStyle } from "../../lib/notes/notesTheme";
import { emitNotesDockSignal } from "../../lib/notes/notesWindowSync";
import { isTauriRuntime } from "../../lib/runtime";
import { detachNotesPanel, requestNotesReturn, useNotesWindowStore } from "../../lib/shell/notesPanelWindow";

interface NotesPanelProps {
  showPanelModeToggle?: boolean;
}

/**
 * NotesPanel — the 便签 tab content inside the Tao Hub. A master/detail surface
 * sized for the narrow drawer: toolbar + filter chips over the list, with the
 * editor replacing the list when a note is selected (§4.2).
 */
export function NotesPanel({ showPanelModeToggle = true }: NotesPanelProps = {}) {
  const t = useT();
  const notes = useNotesStore((s) => s.notes);
  const loading = useNotesStore((s) => s.loading);
  const search = useNotesStore((s) => s.search);
  const filter = useNotesStore((s) => s.filter);
  const statusFilters = useNotesStore((s) => s.statusFilters);
  const tagFilterId = useNotesStore((s) => s.tagFilterId);
  const tags = useNotesStore((s) => s.tags);
  const initPanel = useNotesStore((s) => s.initPanel);
  const loadTags = useNotesStore((s) => s.loadTags);
  const setSearch = useNotesStore((s) => s.setSearch);
  const toggleStatusFilter = useNotesStore((s) => s.toggleStatusFilter);
  const setTagFilter = useNotesStore((s) => s.setTagFilter);
  const createNote = useNotesStore((s) => s.createNote);
  const toggleComplete = useNotesStore((s) => s.toggleComplete);
  const setActiveNote = useNotesStore((s) => s.setActiveNote);
  const activeNoteId = useNotesStore((s) => s.activeNoteId);
  const activeNoteSnapshot = useNotesStore((s) => s.activeNoteSnapshot);
  const theme = useNotesStore((s) => s.theme);
  const font = useNotesStore((s) => s.font);
  const fontSize = useNotesStore((s) => s.fontSize);
  const panelMode = useNotesStore((s) => s.panelMode);
  const setPanelMode = useNotesStore((s) => s.setPanelMode);
  const loadError = useNotesStore((s) => s.loadError), saveError = useNotesStore((s) => s.saveError);
  const move = useNotesWindowStore();
  const [showSettings, setShowSettings] = useState(false);
  const [creatingNote, setCreatingNote] = useState(false);
  const creatingNoteRef = useRef(false);

  useEffect(() => {
    // Bootstrap prefs → list in order (prefs may restore a non-default filter),
    // holding the loading state across both so the list matches the filter chip.
    void initPanel();
    void loadTags();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeNote = activeNoteId ? notes.find((n) => n.id === activeNoteId) ?? (activeNoteSnapshot?.id === activeNoteId ? activeNoteSnapshot : null) : null;
  const themeStyle = notesThemeStyle(theme);
  const fontStyle = notesFontStyle(font);
  const fontSizeStyle = notesFontSizeStyle(fontSize);
  const density = notesThemeDensity(theme);
  const floatingActive = panelMode === "floating";

  const toggleFloatingPanel = () => {
    if (isTauriRuntime()) {
      if (move.phase === "detached") requestNotesReturn();
      else void detachNotesPanel(t("notes.title")).catch(() => undefined);
      return;
    }
    if (floatingActive) {
      setPanelMode("hub");
      emitNotesDockSignal();
      return;
    }
    setPanelMode("floating");
  };

  const handleCreateNote = async () => {
    if (creatingNoteRef.current) return;
    creatingNoteRef.current = true;
    setCreatingNote(true);
    try {
      const note = await createNote({ title: "" });
      if (note) setActiveNote(note.id);
    } finally {
      creatingNoteRef.current = false;
      setCreatingNote(false);
    }
  };

  return (
    <div
      className="flex-1 min-h-0 flex flex-col"
      data-testid="notes-panel"
      data-notes-theme={theme}
      data-density={density}
      data-window-phase={move.phase}
      inert={move.phase === "committing" || move.phase === "returning"}
      style={{ background: "var(--taomni-sidebar-bg)", color: "var(--taomni-text)", ...themeStyle, ...fontStyle, ...fontSizeStyle }}
    >
      {move.recovery && <p role="status" data-testid="shell-notes-recovered" className="p-2 text-xs shrink-0">{move.recovery}</p>}
      {(loadError || saveError || move.error) && <div role="alert" data-testid="shell-notes-error" className="p-2 text-xs shrink-0"><p>{move.error ?? saveError ?? loadError}</p><button data-testid="shell-notes-retry" onClick={() => {
        if (move.error) void detachNotesPanel(t("notes.title")).catch(() => undefined);
        else if (saveError) { const draft = import("../../lib/notes/notesViewState"); void draft.then(({ flushNotesEditor }) => flushNotesEditor()).catch(() => undefined); }
        else void useNotesStore.getState().loadNotes();
      }}>{t("common.retry")}</button></div>}
      {activeNote ? (
        <>
        {showPanelModeToggle && <button type="button" data-testid="notes-floating-toggle" className="taomni-btn shrink-0 self-end m-1 h-6 w-6 p-0 inline-flex items-center justify-center"
          title={floatingActive ? t("notes.panelModeHub") : t("notes.panelModeFloating")} aria-label={floatingActive ? t("notes.panelModeHub") : t("notes.panelModeFloating")} aria-pressed={floatingActive} onClick={toggleFloatingPanel}>
          {floatingActive ? <PanelRightClose className="w-3.5 h-3.5" /> : <Monitor className="w-3.5 h-3.5" />}
        </button>}
        <NoteEditor note={activeNote} onClose={() => setActiveNote(null)} />
        </>
      ) : (
        <>
          {/* Toolbar */}
          <div
            className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--taomni-divider)] shrink-0"
            data-testid="notes-toolbar"
          >
            <button
              type="button"
              className="taomni-btn h-6 w-6 shrink-0 p-0 inline-flex items-center justify-center"
              onClick={() => void handleCreateNote()}
              disabled={creatingNote}
              title={t("notes.newNote")}
              aria-label={t("notes.newNoteAria")}
              data-testid="notes-new"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
            <NoteStatusFilter filters={statusFilters} onToggleFilter={toggleStatusFilter} />
            <div className="relative flex-1 min-w-0">
              <Search className="w-3 h-3 absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
              <input
                type="search"
                className="taomni-input h-6 w-full text-[11px] pl-6"
                placeholder={t("notes.searchPlaceholder")}
                aria-label={t("notes.searchAria")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                data-testid="notes-search"
              />
            </div>
            {showPanelModeToggle && (
              <button
                type="button"
                className={`taomni-btn h-6 w-6 shrink-0 p-0 inline-flex items-center justify-center ${floatingActive ? "bg-[var(--taomni-selected)] text-[var(--taomni-accent)]" : ""}`}
                onClick={toggleFloatingPanel}
                title={floatingActive ? t("notes.panelModeHub") : t("notes.panelModeFloating")}
                aria-label={floatingActive ? t("notes.panelModeHub") : t("notes.panelModeFloating")}
                aria-pressed={floatingActive}
                data-testid="notes-floating-toggle"
              >
                {floatingActive ? <PanelRightClose className="w-3.5 h-3.5" /> : <Monitor className="w-3.5 h-3.5" />}
              </button>
            )}
            <button
              type="button"
              className={`taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center ${showSettings ? "bg-[var(--taomni-selected)]" : ""}`}
              onClick={() => setShowSettings((v) => !v)}
              title={t("notes.settings")}
              aria-label={t("notes.settings")}
              aria-pressed={showSettings}
              data-testid="notes-settings-toggle"
            >
              <Settings className="w-3.5 h-3.5" />
            </button>
          </div>

          {showSettings && <NoteThemeSettings />}

          <NoteTagFilters
            tagFilterId={tagFilterId}
            tags={tags}
            onSelectTag={setTagFilter}
          />

          {/* List */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {loading && notes.length === 0 ? (
              <div className="p-4 text-center text-[11px] text-[var(--taomni-text-muted)]">
                {t("notes.loading")}
              </div>
            ) : notes.length === 0 ? (
              <div className="p-6 text-center text-[12px] text-[var(--taomni-text-muted)]">
                <div>
                  {search || filter !== "recent_incomplete" || statusFilters.length !== 1 || tagFilterId
                    ? t("notes.emptyFiltered")
                    : t("notes.empty")}
                </div>
                {!search && filter === "recent_incomplete" && statusFilters.length === 1 && !tagFilterId && (
                  <div className="mt-1 text-[11px]">{t("notes.emptyHint")}</div>
                )}
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
        </>
      )}
    </div>
  );
}
