import { create } from "zustand";
import {
  ackAlert as ackAlertIpc,
  archiveNote as archiveNoteIpc,
  createNote as createNoteIpc,
  deleteNote as deleteNoteIpc,
  getPrefs,
  listAlerts,
  listNotes,
  listTags,
  nowSecs,
  setPrefs,
  setSteps as setStepsIpc,
  toggleNoteComplete,
  updateNote as updateNoteIpc,
  upsertTags as upsertTagsIpc,
  type CreateNoteInput,
  type NoteAlert,
  type NoteFilter,
  type NoteItem,
  type NoteStep,
  type NoteTag,
  type StepInput,
  type TagInput,
  type UpdateNoteInput,
} from "../lib/notes";

export type NotesPanelMode = "hub" | "floating";
export type NotesTheme =
  | "taomni"
  | "light"
  | "dark"
  | "paper"
  | "sticky"
  | "sticky_bright"
  | "mint"
  | "sky"
  | "rose"
  | "graphite"
  | "compact";
export type NotesFont =
  | "inherit"
  | "inter"
  | "outfit"
  | "system"
  | "rounded"
  | "serif"
  | "songti"
  | "kaiti"
  | "handwriting"
  | "mono";

export interface NotesPanelPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** note_prefs keys owned by the notes feature. */
const PREF_PANEL_MODE = "notes.panel.mode";
const PREF_PANEL_POSITION = "notes.panel.position";
const PREF_PANEL_ALWAYS_ON_TOP = "notes.panel.alwaysOnTopInApp";
const PREF_PANEL_THEME = "notes.panel.theme";
const PREF_PANEL_FONT = "notes.panel.font";
const PREF_PANEL_FONT_SIZE = "notes.panel.fontSize";
const PREF_LAST_FILTER = "notes.lastFilter";
const PREF_STATUS_FILTERS = "notes.statusFilters";
const DEFAULT_NOTES_FONT_SIZE = 12;
const MIN_NOTES_FONT_SIZE = 10;
const MAX_NOTES_FONT_SIZE = 20;

const LEGACY_DEFAULT_NOTES_PANEL_SIZE = {
  width: 460,
  height: 560,
};

export const DEFAULT_NOTES_PANEL_POSITION: NotesPanelPosition = {
  x: 120,
  y: 120,
  width: 260,
  height: 320,
};

function coerceTheme(value: unknown): NotesTheme {
  return value === "light" ||
    value === "dark" ||
    value === "paper" ||
    value === "sticky" ||
    value === "sticky_bright" ||
    value === "mint" ||
    value === "sky" ||
    value === "rose" ||
    value === "graphite" ||
    value === "compact"
    ? value
    : "taomni";
}

function coerceFont(value: unknown): NotesFont {
  return value === "inter" ||
    value === "outfit" ||
    value === "system" ||
    value === "rounded" ||
    value === "serif" ||
    value === "songti" ||
    value === "kaiti" ||
    value === "handwriting" ||
    value === "mono"
    ? value
    : "inherit";
}

function clampNotesFontSize(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_NOTES_FONT_SIZE;
  return Math.min(MAX_NOTES_FONT_SIZE, Math.max(MIN_NOTES_FONT_SIZE, Math.round(n)));
}

function coerceFilter(value: unknown): NoteFilter {
  const filters: NoteFilter[] = [
    "recent_incomplete",
    "all",
    "pinned",
    "today",
    "due_soon",
    "overdue",
    "completed",
    "archived",
    "tag",
  ];
  return filters.includes(value as NoteFilter) ? (value as NoteFilter) : "recent_incomplete";
}

function normalizeStatusFilters(values: unknown): NoteFilter[] {
  const raw = Array.isArray(values) ? values : [values];
  const next: NoteFilter[] = [];
  for (const value of raw) {
    const filter = coerceFilter(value);
    if (filter === "tag" || next.includes(filter)) continue;
    if (filter === "all") return ["all"];
    next.push(filter);
  }
  return next.length > 0 ? next : ["recent_incomplete"];
}

function normalizePanelPosition(position: NotesPanelPosition): NotesPanelPosition {
  const width = Number(position.width) || DEFAULT_NOTES_PANEL_POSITION.width;
  const height = Number(position.height) || DEFAULT_NOTES_PANEL_POSITION.height;
  const isLegacyDefault =
    width === LEGACY_DEFAULT_NOTES_PANEL_SIZE.width &&
    height === LEGACY_DEFAULT_NOTES_PANEL_SIZE.height;
  return {
    x: Number(position.x) || DEFAULT_NOTES_PANEL_POSITION.x,
    y: Number(position.y) || DEFAULT_NOTES_PANEL_POSITION.y,
    width: isLegacyDefault ? DEFAULT_NOTES_PANEL_POSITION.width : width,
    height: isLegacyDefault ? DEFAULT_NOTES_PANEL_POSITION.height : height,
  };
}

interface NotesStore {
  notes: NoteItem[];
  notesLoaded: boolean;
  loading: boolean;
  activeNoteId: string | null;
  filter: NoteFilter;
  statusFilters: NoteFilter[];
  search: string;
  tagFilterId: string | null;
  tags: NoteTag[];
  alerts: NoteAlert[];

  // Panel prefs (mirrored from note_prefs).
  panelMode: NotesPanelMode;
  panelPosition: NotesPanelPosition;
  alwaysOnTopInApp: boolean;
  theme: NotesTheme;
  font: NotesFont;
  fontSize: number;
  prefsLoaded: boolean;

  loadNotes: () => Promise<void>;
  loadTags: () => Promise<void>;
  createNote: (input?: CreateNoteInput) => Promise<NoteItem | null>;
  updateNote: (id: string, patch: UpdateNoteInput) => Promise<void>;
  toggleComplete: (id: string, completed: boolean) => Promise<void>;
  archiveNote: (id: string, archived: boolean) => Promise<void>;
  deleteNote: (id: string) => Promise<void>;
  setSteps: (noteId: string, steps: StepInput[]) => Promise<NoteStep[]>;
  upsertTags: (tags: TagInput[]) => Promise<NoteTag[]>;
  setActiveNote: (id: string | null) => void;
  setFilter: (filter: NoteFilter) => void;
  setStatusFilters: (filters: NoteFilter[]) => void;
  toggleStatusFilter: (filter: NoteFilter) => void;
  setSearch: (search: string) => void;
  setTagFilter: (tagId: string | null) => void;

  refreshAlerts: () => Promise<void>;
  ackAlert: (id: string) => Promise<void>;

  /// One-shot panel bootstrap: apply persisted prefs (which may restore a
  /// non-default filter) BEFORE the first list load, so the visible list and
  /// the filter chip agree on first paint. Holds `loading` across both fetches
  /// to avoid an empty→loading→empty flicker.
  initPanel: () => Promise<void>;
  loadPrefs: () => Promise<void>;
  setPanelMode: (mode: NotesPanelMode) => void;
  setPanelPosition: (position: NotesPanelPosition) => void;
  setAlwaysOnTop: (value: boolean) => void;
  setTheme: (theme: NotesTheme) => void;
  setFont: (font: NotesFont) => void;
  setFontSize: (size: number) => void;
}

async function persistPref(key: string, value: unknown): Promise<void> {
  try {
    await setPrefs({ [key]: JSON.stringify(value) });
  } catch (e) {
    console.warn(`notes: persist pref ${key} failed`, e);
  }
}

export const useNotesStore = create<NotesStore>((set, get) => ({
  notes: [],
  notesLoaded: false,
  loading: false,
  activeNoteId: null,
  filter: "recent_incomplete",
  statusFilters: ["recent_incomplete"],
  search: "",
  tagFilterId: null,
  tags: [],
  alerts: [],
  panelMode: "hub",
  panelPosition: DEFAULT_NOTES_PANEL_POSITION,
  alwaysOnTopInApp: false,
  theme: "taomni",
  font: "inherit",
  fontSize: DEFAULT_NOTES_FONT_SIZE,
  prefsLoaded: false,

  loadNotes: async () => {
    const { filter, statusFilters, search, tagFilterId } = get();
    set({ loading: true });
    try {
      const notes = await listNotes({
        filter,
        filters: statusFilters,
        search: search.trim() || undefined,
        tag_id: tagFilterId ?? undefined,
        now: nowSecs(),
      });
      set({ notes: Array.isArray(notes) ? notes : [], notesLoaded: true, loading: false });
    } catch (e) {
      console.error("notes_list failed:", e);
      set({ notesLoaded: true, loading: false });
    }
  },

  loadTags: async () => {
    try {
      const tags = await listTags();
      set({ tags: Array.isArray(tags) ? tags : [] });
    } catch (e) {
      console.error("notes_list_tags failed:", e);
    }
  },

  createNote: async (input) => {
    try {
      const note = await createNoteIpc(input ?? {});
      set((s) => ({ notes: [note, ...s.notes], activeNoteId: note.id }));
      // A brand-new note may not match the current filter (e.g. "completed");
      // reload so the visible list stays consistent with the active view.
      void get().loadNotes();
      return note;
    } catch (e) {
      console.error("notes_create failed:", e);
      return null;
    }
  },

  updateNote: async (id, patch) => {
    try {
      const updated = await updateNoteIpc(id, patch);
      if (updated) {
        set((s) => ({ notes: s.notes.map((n) => (n.id === id ? updated : n)) }));
      }
      void get().loadNotes();
      void get().refreshAlerts();
    } catch (e) {
      console.error("notes_update failed:", e);
    }
  },

  toggleComplete: async (id, completed) => {
    try {
      const updated = await toggleNoteComplete(id, completed);
      if (updated) {
        set((s) => ({ notes: s.notes.map((n) => (n.id === id ? updated : n)) }));
      }
      void get().loadNotes();
      void get().refreshAlerts();
    } catch (e) {
      console.error("notes_toggle_complete failed:", e);
    }
  },

  archiveNote: async (id, archived) => {
    try {
      await archiveNoteIpc(id, archived);
      void get().loadNotes();
      void get().refreshAlerts();
    } catch (e) {
      console.error("notes_archive failed:", e);
    }
  },

  deleteNote: async (id) => {
    try {
      await deleteNoteIpc(id);
      set((s) => ({
        notes: s.notes.filter((n) => n.id !== id),
        activeNoteId: s.activeNoteId === id ? null : s.activeNoteId,
      }));
      void get().refreshAlerts();
    } catch (e) {
      console.error("notes_delete failed:", e);
    }
  },

  setSteps: async (noteId, steps) => {
    try {
      const result = await setStepsIpc(noteId, steps);
      set((s) => ({
        notes: s.notes.map((n) => (n.id === noteId ? { ...n, steps: result } : n)),
      }));
      return result;
    } catch (e) {
      console.error("notes_set_steps failed:", e);
      return [];
    }
  },

  upsertTags: async (tags) => {
    try {
      const result = await upsertTagsIpc(tags);
      await get().loadTags();
      return result;
    } catch (e) {
      console.error("notes_upsert_tags failed:", e);
      return [];
    }
  },

  setActiveNote: (id) => set({ activeNoteId: id }),

  setFilter: (filter) => {
    const statusFilters = normalizeStatusFilters(filter);
    set({ filter: statusFilters[0], statusFilters, tagFilterId: null });
    void persistPref(PREF_LAST_FILTER, filter);
    void persistPref(PREF_STATUS_FILTERS, statusFilters);
    void get().loadNotes();
  },

  setStatusFilters: (filters) => {
    const statusFilters = normalizeStatusFilters(filters);
    set({ statusFilters, filter: statusFilters[0] });
    void persistPref(PREF_STATUS_FILTERS, statusFilters);
    void persistPref(PREF_LAST_FILTER, statusFilters[0]);
    void get().loadNotes();
  },

  toggleStatusFilter: (filter) => {
    const { statusFilters } = get();
    if (filter === "tag") return;
    if (filter === "all") {
      get().setStatusFilters(["all"]);
      return;
    }
    const base = statusFilters.filter((f) => f !== "all");
    const next = base.includes(filter) ? base.filter((f) => f !== filter) : [...base, filter];
    get().setStatusFilters(next);
  },

  setSearch: (search) => {
    set({ search });
    void get().loadNotes();
  },

  setTagFilter: (tagId) => {
    set({ tagFilterId: tagId });
    void get().loadNotes();
  },

  refreshAlerts: async () => {
    try {
      const alerts = await listAlerts(nowSecs());
      set({ alerts: Array.isArray(alerts) ? alerts : [] });
    } catch (e) {
      console.error("notes_list_alerts failed:", e);
    }
  },

  ackAlert: async (id) => {
    try {
      await ackAlertIpc(id);
      set((s) => ({
        alerts: s.alerts.map((a) =>
          a.id === id ? { ...a, state: "acknowledged", acknowledged_at: nowSecs() } : a,
        ),
      }));
    } catch (e) {
      console.error("notes_ack_alert failed:", e);
    }
  },

  initPanel: async () => {
    const { prefsLoaded, notesLoaded } = get();
    if (prefsLoaded && notesLoaded) return;
    // Keep the loading indicator up while prefs resolve so the empty state
    // never flashes before the (possibly filter-adjusted) list arrives.
    set({ loading: true });
    if (!prefsLoaded) await get().loadPrefs();
    await get().loadNotes();
  },

  loadPrefs: async () => {
    try {
      const prefs = await getPrefs();
      const parse = <T,>(key: string, fallback: T): T => {
        const raw = prefs[key];
        if (raw === undefined) return fallback;
        try {
          return JSON.parse(raw) as T;
        } catch {
          return fallback;
        }
      };
      const position = parse<NotesPanelPosition>(PREF_PANEL_POSITION, DEFAULT_NOTES_PANEL_POSITION);
      const lastFilter = coerceFilter(parse<string>(PREF_LAST_FILTER, "recent_incomplete"));
      const statusFilters = normalizeStatusFilters(parse<NoteFilter[] | NoteFilter>(PREF_STATUS_FILTERS, lastFilter));
      set({
        panelMode: parse<string>(PREF_PANEL_MODE, "hub") === "floating" ? "floating" : "hub",
        panelPosition: normalizePanelPosition(position),
        alwaysOnTopInApp: parse<boolean>(PREF_PANEL_ALWAYS_ON_TOP, false) === true,
        theme: coerceTheme(parse<string>(PREF_PANEL_THEME, "taomni")),
        font: coerceFont(parse<string>(PREF_PANEL_FONT, "inherit")),
        fontSize: clampNotesFontSize(parse<number>(PREF_PANEL_FONT_SIZE, DEFAULT_NOTES_FONT_SIZE)),
        filter: statusFilters[0],
        statusFilters,
        prefsLoaded: true,
      });
    } catch (e) {
      console.error("notes_get_prefs failed:", e);
      set({ prefsLoaded: true });
    }
  },

  setPanelMode: (mode) => {
    set({ panelMode: mode });
    void persistPref(PREF_PANEL_MODE, mode);
  },

  setPanelPosition: (position) => {
    set({ panelPosition: position });
    void persistPref(PREF_PANEL_POSITION, position);
  },

  setAlwaysOnTop: (value) => {
    set({ alwaysOnTopInApp: value });
    void persistPref(PREF_PANEL_ALWAYS_ON_TOP, value);
  },

  setTheme: (theme) => {
    set({ theme });
    void persistPref(PREF_PANEL_THEME, theme);
  },

  setFont: (font) => {
    set({ font });
    void persistPref(PREF_PANEL_FONT, font);
  },

  setFontSize: (fontSize) => {
    const next = clampNotesFontSize(fontSize);
    set({ fontSize: next });
    void persistPref(PREF_PANEL_FONT_SIZE, next);
  },
}));

/** Count of unacknowledged note alerts, split by severity — for the Tao Ribbon badge. */
export function pendingAlertCounts(alerts: NoteAlert[]): {
  overdue: number;
  dueSoon: number;
  reminder: number;
  total: number;
} {
  let overdue = 0;
  let dueSoon = 0;
  let reminder = 0;
  for (const a of alerts) {
    if (a.state !== "pending") continue;
    if (a.kind === "overdue") overdue += 1;
    else if (a.kind === "due_soon") dueSoon += 1;
    else if (a.kind === "reminder") reminder += 1;
  }
  return { overdue, dueSoon, reminder, total: overdue + dueSoon + reminder };
}
