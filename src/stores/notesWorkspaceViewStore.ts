import { create } from "zustand";
import { getPrefs, listNotes, listTags, nowSecs, setPrefs, type NoteFilter, type NoteItem, type NoteTag } from "../lib/notes";
import { normalizeStatusFilters, toggleStatusFilter } from "../lib/notes/noteFilters";

const FILTER_PREF = "notes.workspace.statusFilters";
interface NotesWorkspaceViewState {
  notes: NoteItem[];
  tags: NoteTag[];
  search: string;
  statusFilters: NoteFilter[];
  tagFilterId: string | null;
  loading: boolean;
  error: string | null;
  initialized: boolean;
  init: () => Promise<void>;
  load: () => Promise<void>;
  setSearch: (search: string) => void;
  toggleFilter: (filter: NoteFilter) => void;
  setTagFilter: (id: string | null) => void;
  resetForCreate: () => void;
}

/** Independent view state; SQLite query semantics are shared with Tao Notes. */
export const useNotesWorkspaceViewStore = create<NotesWorkspaceViewState>((set, get) => {
  let request = 0;
  let filterRevision = 0;
  let initializing: Promise<void> | undefined;
  const setFilters = (statusFilters: NoteFilter[]) => {
    filterRevision += 1;
    set({ statusFilters });
    void setPrefs({ [FILTER_PREF]: JSON.stringify(statusFilters) }).catch((error) => set({ error: String(error) }));
  };
  return {
    notes: [], tags: [], search: "", statusFilters: ["recent_incomplete"], tagFilterId: null,
    loading: false, error: null, initialized: false,
    init: async () => {
      if (get().initialized) { await get().load(); return; }
      if (initializing) return initializing;
      const revision = filterRevision;
      initializing = (async () => {
        try {
          const prefs = await getPrefs();
          if (revision === filterRevision && prefs[FILTER_PREF]) {
            try { set({ statusFilters: normalizeStatusFilters(JSON.parse(prefs[FILTER_PREF])) }); }
            catch { /* Malformed preferences use the default status. */ }
          }
          set({ initialized: true });
          await get().load();
        } catch (error) { set({ error: String(error) }); }
        finally { initializing = undefined; }
      })();
      return initializing;
    },
    load: async () => {
      const generation = ++request;
      const { statusFilters, search, tagFilterId } = get();
      set({ loading: true, error: null });
      try {
        const [notes, tags] = await Promise.all([
          listNotes({ filters: statusFilters, search: search.trim() || undefined, tag_id: tagFilterId ?? undefined, now: nowSecs() }),
          listTags(),
        ]);
        if (generation === request) set({ notes, tags, loading: false });
      } catch (error) {
        if (generation === request) set({ error: String(error), loading: false });
      }
    },
    setSearch: (search) => { set({ search }); void get().load(); },
    toggleFilter: (filter) => {
      setFilters(toggleStatusFilter(get().statusFilters, filter));
      void get().load();
    },
    setTagFilter: (tagFilterId) => { set({ tagFilterId }); void get().load(); },
    resetForCreate: () => {
      setFilters(["recent_incomplete"]);
      set({ search: "", tagFilterId: null });
      void get().load();
    },
  };
});
