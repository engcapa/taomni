import { FileText, Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useNotesContentStore } from "../../stores/notesContentStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { NOTES_WORKSPACE_ID } from "../../stores/workspaceNotes";
import { createAndOpenWorkspaceNote, openNoteWorkspace } from "../../lib/notes/notesWorkspaceNavigation";
import { useT } from "../../lib/i18n";
import { useNotesContentSync } from "./useNotesContentSync";

/** Notes navigation has its own catalog, independent of the Hub's task filters. */
export function NotesWorkspaceSidebar() {
  const t = useT();
  useNotesContentSync();
  const catalog = useNotesContentStore((state) => state.catalog);
  const loading = useNotesContentStore((state) => state.catalogLoading);
  const error = useNotesContentStore((state) => state.catalogError);
  const activeNoteId = useWorkspacePlatformStore((state) => {
    const notes = state.workspaces.find((workspace) => workspace.id === NOTES_WORKSPACE_ID);
    return notes?.openTabs.find((tab) => tab.id === notes.activeTabId)?.noteId;
  });
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  useEffect(() => { void useNotesContentStore.getState().loadCatalog(); }, []);
  const query = search.trim().toLocaleLowerCase();
  const notes = catalog.filter((note) => `${note.title}\n${note.body}`.toLocaleLowerCase().includes(query));
  return <div data-testid="notes-workspace-sidebar" className="flex min-h-0 flex-1 flex-col gap-1 p-2">
    <div className="flex items-center gap-1">
      <button type="button" data-testid="notes-workspace-new" className="taomni-btn flex h-7 flex-1 items-center gap-1 px-2"
        disabled={creating} onClick={() => {
          setCreating(true);
          void createAndOpenWorkspaceNote().finally(() => setCreating(false));
        }}><Plus className="h-3.5 w-3.5" />{t("notes.newNote")}</button>
      <button type="button" data-testid="notes-workspace-refresh" className="taomni-btn h-7 px-1"
        title={t("notes.reloadContent")} aria-label={t("notes.reloadContent")}
        onClick={() => { void useNotesContentStore.getState().loadCatalog(); }}><RefreshCw className="h-3.5 w-3.5" /></button>
    </div>
    <label className="relative mt-1">
      <Search className="pointer-events-none absolute left-1.5 top-2 h-3 w-3 text-[var(--taomni-text-muted)]" />
      <input type="search" data-testid="notes-workspace-search" className="taomni-input h-7 w-full pl-6 text-xs"
        aria-label={t("notes.searchAria")} placeholder={t("notes.searchPlaceholder")}
        value={search} onChange={(event) => setSearch(event.target.value)} />
    </label>
    {error && <p role="alert" className="break-words text-xs text-[var(--taomni-danger)]">{error}</p>}
    {loading && !catalog.length && <p className="p-2 text-xs">{t("notes.loading")}</p>}
    {!loading && !notes.length && <p className="p-2 text-xs text-[var(--taomni-text-muted)]">{t(query ? "notes.emptyFiltered" : "notes.empty")}</p>}
    <div className="min-h-0 flex-1 overflow-auto" role="list" aria-label={t("notes.workspaceTitle")}>
      {notes.map((note) => <button key={note.id} type="button" role="listitem" data-testid="notes-workspace-note"
        data-note-id={note.id} aria-current={note.id === activeNoteId || undefined}
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1.5 text-left text-xs hover:bg-[var(--taomni-hover)]"
        style={{ background: note.id === activeNoteId ? "var(--taomni-selected)" : undefined }}
        title={`${note.title || t("notes.titlePlaceholder")}.md`}
        onClick={() => { void openNoteWorkspace(note); }}>
        <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
        <span className="min-w-0 flex-1 truncate">{note.title || t("notes.titlePlaceholder")}.md</span>
        {note.completed_at !== null && <span title={t("notes.completed")}>✓</span>}
        {note.archived_at !== null && <span title={t("notes.archived")}>▣</span>}
      </button>)}
    </div>
  </div>;
}
