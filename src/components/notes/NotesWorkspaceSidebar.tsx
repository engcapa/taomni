import { Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { useNotesWorkspaceViewStore } from "../../stores/notesWorkspaceViewStore";
import { useNotesTaskStore } from "../../stores/notesTaskStore";
import { NOTES_WORKSPACE_ID } from "../../stores/workspaceNotes";
import { createAndOpenWorkspaceNote, openNoteWorkspace } from "../../lib/notes/notesWorkspaceNavigation";
import { useT } from "../../lib/i18n";
import { useNotesContentSync } from "./useNotesContentSync";
import { NoteStatusFilter, NoteTagFilters } from "./NoteFilters";
import { NotesList } from "./NotesList";
import { NoteTaskStatus } from "./NoteTaskActions";

export function NotesWorkspaceSidebar() {
  const t = useT();
  useNotesContentSync();
  const view = useNotesWorkspaceViewStore();
  const errors = useNotesTaskStore((state) => state.errors);
  const activeNoteId = useWorkspacePlatformStore((state) => {
    const notes = state.workspaces.find((workspace) => workspace.id === NOTES_WORKSPACE_ID);
    return notes?.openTabs.find((tab) => tab.id === notes.activeTabId)?.noteId ?? null;
  });
  const [creating, setCreating] = useState(false);
  useEffect(() => { void useNotesWorkspaceViewStore.getState().init(); }, []);
  return <div data-testid="notes-workspace-sidebar" className="flex min-h-0 flex-1 flex-col gap-1 p-2">
    <div className="flex items-center gap-1">
      <button type="button" data-testid="notes-workspace-new" className="taomni-btn flex h-7 flex-1 items-center gap-1 px-2"
        disabled={creating} onClick={() => {
          setCreating(true);
          void createAndOpenWorkspaceNote().finally(() => setCreating(false));
        }}><Plus className="h-3.5 w-3.5" />{t("notes.newNote")}</button>
      <NoteStatusFilter filters={view.statusFilters} onToggleFilter={view.toggleFilter} prefix="notes-workspace" />
      <button type="button" data-testid="notes-workspace-refresh" className="taomni-btn h-7 px-1"
        title={t("notes.reloadContent")} aria-label={t("notes.reloadContent")}
        onClick={() => { void view.load(); if (activeNoteId) void useNotesTaskStore.getState().load(activeNoteId); }}><RefreshCw className="h-3.5 w-3.5" /></button>
    </div>
    <label className="relative mt-1">
      <Search className="pointer-events-none absolute left-1.5 top-2 h-3 w-3 text-[var(--taomni-text-muted)]" />
      <input type="search" data-testid="notes-workspace-search" className="taomni-input h-7 w-full pl-6 text-xs"
        aria-label={t("notes.searchAria")} placeholder={t("notes.searchPlaceholder")}
        value={view.search} onChange={(event) => view.setSearch(event.target.value)} />
    </label>
    <NoteTagFilters tags={view.tags} tagFilterId={view.tagFilterId} onSelectTag={view.setTagFilter}
      prefix="notes-workspace" className="flex max-h-24 shrink-0 flex-wrap gap-1 overflow-auto py-1" />
    {view.error && <p role="alert" className="break-words text-xs text-red-400">{view.error}</p>}
    {Object.keys(errors).filter((id) => errors[id]).map((id) => <NoteTaskStatus key={id} noteId={id} />)}
    {view.loading && !view.notes.length && <p className="p-2 text-xs">{t("notes.loading")}</p>}
    {!view.loading && !view.notes.length && <p className="p-2 text-xs text-[var(--taomni-text-muted)]">{t("notes.emptyFiltered")}</p>}
    <div className="min-h-0 flex-1 overflow-auto" aria-label={t("notes.workspaceTitle")}
      data-testid="notes-workspace-results" data-count={view.notes.length} aria-busy={view.loading}>
      <NotesList notes={view.notes} activeNoteId={activeNoteId} prefix="notes-workspace" markdownTitles
        onSelect={(id) => { const note = view.notes.find((item) => item.id === id); if (note) void openNoteWorkspace(note); }}
        onToggleComplete={(id, completed) => { void useNotesTaskStore.getState().complete(id, completed); }} />
    </div>
  </div>;
}
