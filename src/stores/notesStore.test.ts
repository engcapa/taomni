import { beforeEach, describe, expect, it, vi } from "vitest";
import { pendingAlertCounts, useNotesStore } from "./notesStore";
import type { NoteAlert } from "../lib/notes";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

// ---- Minimal in-memory backend mirroring notes.db semantics ----
interface FakeNote {
  id: string;
  title: string;
  body: string;
  completed_at: number | null;
  pinned: boolean;
  archived_at: number | null;
  color: string | null;
  priority: number;
  due_at: number | null;
  reminder_at: number | null;
  repeat_rule: string | null;
  source_tab_id: string | null;
  source_session_id: string | null;
  source_title: string | null;
  source_uri: string | null;
  created_at: number;
  updated_at: number;
  steps: unknown[];
  tags: unknown[];
}

let store: FakeNote[] = [];
let prefs: Record<string, string> = {};
let seq = 0;

function filterNotes(query: Record<string, unknown>): FakeNote[] {
  const filter = (query.filter as string) ?? "recent_incomplete";
  const filters = Array.isArray(query.filters) && query.filters.length > 0 ? query.filters.map(String) : [filter];
  const search = ((query.search as string) ?? "").toLowerCase();
  let list = store.filter((n) =>
    filters.some((status) => {
      switch (status) {
        case "all":
          return n.archived_at === null;
        case "completed":
          return n.archived_at === null && n.completed_at !== null;
        case "archived":
          return n.archived_at !== null;
        default:
          return n.archived_at === null && n.completed_at === null;
      }
    }),
  );
  if (search) {
    list = list.filter(
      (n) => n.title.toLowerCase().includes(search) || n.body.toLowerCase().includes(search),
    );
  }
  return list.sort((a, b) => (a.pinned === b.pinned ? b.updated_at - a.updated_at : a.pinned ? -1 : 1));
}

beforeEach(() => {
  store = [];
  prefs = {};
  seq = 0;
  useNotesStore.setState({
    notes: [],
    notesLoaded: false,
    activeNoteId: null,
    filter: "recent_incomplete",
    statusFilters: ["recent_incomplete"],
    search: "",
    tagFilterId: null,
    alerts: [],
    panelMode: "hub",
    theme: "taomni",
    font: "inherit",
    fontSize: 12,
    prefsLoaded: false,
  });
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown> = {}) => {
    switch (cmd) {
      case "notes_list":
        return filterNotes((args.query as Record<string, unknown>) ?? {});
      case "notes_create": {
        const input = (args.input as Record<string, unknown>) ?? {};
        const ts = 1000 + seq++;
        const note: FakeNote = {
          id: `n${seq}`,
          title: (input.title as string) ?? "",
          body: (input.body as string) ?? "",
          completed_at: null,
          pinned: (input.pinned as boolean) ?? false,
          archived_at: null,
          color: null,
          priority: 0,
          due_at: (input.due_at as number) ?? null,
          reminder_at: null,
          repeat_rule: null,
          source_tab_id: null,
          source_session_id: null,
          source_title: null,
          source_uri: null,
          created_at: ts,
          updated_at: ts,
          steps: [],
          tags: [],
        };
        store.unshift(note);
        return note;
      }
      case "notes_update": {
        const id = args.id as string;
        const patch = (args.patch as Record<string, unknown>) ?? {};
        const note = store.find((n) => n.id === id);
        if (!note) return null;
        note.title = (patch.title as string) ?? note.title;
        note.body = (patch.body as string) ?? "";
        note.pinned = (patch.pinned as boolean) ?? false;
        note.updated_at = 2000 + seq++;
        return note;
      }
      case "notes_toggle_complete": {
        const note = store.find((n) => n.id === args.id);
        if (!note) return null;
        note.completed_at = args.completed ? 1234 : null;
        return note;
      }
      case "notes_list_alerts":
        return [];
      case "notes_get_prefs":
        return prefs;
      case "notes_set_prefs":
        prefs = { ...prefs, ...((args.prefs as Record<string, string>) ?? {}) };
        return undefined;
      case "notes_list_tags":
        return [];
      default:
        return undefined;
    }
  });
});

describe("notesStore", () => {
  it("loads notes on demand", async () => {
    store.push({
      id: "seed",
      title: "seeded",
      body: "",
      completed_at: null,
      pinned: false,
      archived_at: null,
      color: null,
      priority: 0,
      due_at: null,
      reminder_at: null,
      repeat_rule: null,
      source_tab_id: null,
      source_session_id: null,
      source_title: null,
      source_uri: null,
      created_at: 1,
      updated_at: 1,
      steps: [],
      tags: [],
    });
    await useNotesStore.getState().loadNotes();
    expect(useNotesStore.getState().notes.map((n) => n.id)).toEqual(["seed"]);
    expect(useNotesStore.getState().notesLoaded).toBe(true);
  });

  it("creates a note that defaults to incomplete", async () => {
    const note = await useNotesStore.getState().createNote({ title: "Buy milk" });
    expect(note?.completed_at).toBeNull();
    expect(useNotesStore.getState().notes.some((n) => n.id === note?.id)).toBe(true);
    expect(useNotesStore.getState().activeNoteId).toBe(note?.id);
  });

  it("resets non-matching filters when creating a new note", async () => {
    useNotesStore.setState({
      filter: "completed",
      statusFilters: ["completed"],
      search: "missing",
      tagFilterId: "tag-1",
    });

    const note = await useNotesStore.getState().createNote({ title: "visible draft" });

    expect(note?.completed_at).toBeNull();
    expect(useNotesStore.getState().filter).toBe("recent_incomplete");
    expect(useNotesStore.getState().statusFilters).toEqual(["recent_incomplete"]);
    expect(useNotesStore.getState().search).toBe("");
    expect(useNotesStore.getState().tagFilterId).toBeNull();
    expect(useNotesStore.getState().activeNoteId).toBe(note?.id);
    expect(useNotesStore.getState().notes.some((n) => n.id === note?.id)).toBe(true);
  });

  it("updates a note's title", async () => {
    const note = await useNotesStore.getState().createNote({ title: "old" });
    await useNotesStore.getState().updateNote(note!.id, { title: "new", body: "" });
    // loadNotes runs after update; wait a tick for the fire-and-forget refresh.
    await useNotesStore.getState().loadNotes();
    expect(useNotesStore.getState().notes.find((n) => n.id === note!.id)?.title).toBe("new");
  });

  it("toggling complete removes the note from the recent-incomplete view", async () => {
    const note = await useNotesStore.getState().createNote({ title: "task" });
    await useNotesStore.getState().toggleComplete(note!.id, true);
    await useNotesStore.getState().loadNotes();
    expect(useNotesStore.getState().notes.some((n) => n.id === note!.id)).toBe(false);
  });

  it("search filters the loaded list", async () => {
    await useNotesStore.getState().createNote({ title: "deployment plan" });
    await useNotesStore.getState().createNote({ title: "grocery list" });
    useNotesStore.getState().setSearch("deployment");
    await useNotesStore.getState().loadNotes();
    const titles = useNotesStore.getState().notes.map((n) => n.title);
    expect(titles).toContain("deployment plan");
    expect(titles).not.toContain("grocery list");
  });

  it("toggles multiple status filters and sends them to notes_list", async () => {
    const done = await useNotesStore.getState().createNote({ title: "done" });
    await useNotesStore.getState().toggleComplete(done!.id, true);
    useNotesStore.getState().toggleStatusFilter("completed");
    await useNotesStore.getState().loadNotes();
    expect(useNotesStore.getState().statusFilters).toEqual(["recent_incomplete", "completed"]);
    expect(useNotesStore.getState().notes.map((n) => n.title)).toContain("done");
  });

  it("persists floating panel prefs", async () => {
    useNotesStore.getState().setPanelMode("floating");
    useNotesStore.getState().setTheme("paper");
    useNotesStore.getState().setFont("outfit");
    useNotesStore.getState().setFontSize(16);
    await Promise.resolve();
    expect(prefs["notes.panel.mode"]).toBe(JSON.stringify("floating"));
    expect(prefs["notes.panel.theme"]).toBe(JSON.stringify("paper"));
    expect(prefs["notes.panel.font"]).toBe(JSON.stringify("outfit"));
    expect(prefs["notes.panel.fontSize"]).toBe(JSON.stringify(16));
    // Reload picks the persisted values back up.
    await useNotesStore.getState().loadPrefs();
    expect(useNotesStore.getState().panelMode).toBe("floating");
    expect(useNotesStore.getState().theme).toBe("paper");
    expect(useNotesStore.getState().font).toBe("outfit");
    expect(useNotesStore.getState().fontSize).toBe(16);
  });

  it("clamps the persisted notes font size", async () => {
    useNotesStore.getState().setFontSize(99);
    await Promise.resolve();
    expect(prefs["notes.panel.fontSize"]).toBe(JSON.stringify(20));
    await useNotesStore.getState().loadPrefs();
    expect(useNotesStore.getState().fontSize).toBe(20);
  });
});

describe("pendingAlertCounts", () => {
  it("counts pending alerts by severity and ignores acknowledged ones", () => {
    const alerts: NoteAlert[] = [
      { id: "1", note_id: "a", kind: "overdue", state: "pending", fire_at: 1, acknowledged_at: null, note_title: "a", due_at: 1, reminder_at: null },
      { id: "2", note_id: "b", kind: "due_soon", state: "pending", fire_at: 2, acknowledged_at: null, note_title: "b", due_at: 2, reminder_at: null },
      { id: "3", note_id: "c", kind: "reminder", state: "acknowledged", fire_at: 3, acknowledged_at: 9, note_title: "c", due_at: null, reminder_at: 3 },
    ];
    const counts = pendingAlertCounts(alerts);
    expect(counts).toEqual({ overdue: 1, dueSoon: 1, reminder: 0, total: 2 });
  });
});
