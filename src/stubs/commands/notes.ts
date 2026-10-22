import { type InvokeArgs } from "./runtime";

export const NOTES_STORAGE_KEY = "taomni.stub.notes.v1";

export const NOTE_TAGS_STORAGE_KEY = "taomni.stub.noteTags.v1";

export const NOTE_PREFS_STORAGE_KEY = "taomni.stub.notePrefs.v1";

export const NOTE_ALERT_ACK_STORAGE_KEY = "taomni.stub.noteAlertAcks.v1";

// ---------- Tao Notes (browser-preview localStorage mirror of notes.db) ----------

export interface StubNoteStep {
  id: string;
  note_id: string;
  title: string;
  completed_at: number | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface StubNoteTag {
  id: string;
  name: string;
  color: string | null;
  created_at: number;
  updated_at: number;
}

export interface StubNote {
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
  steps: StubNoteStep[];
  tag_ids: string[];
}

export const NOTE_DUE_SOON_SECS = 30 * 60;

export const nowSecsStub = () => Math.floor(Date.now() / 1000);

export const stubId = () =>
  globalThis.crypto?.randomUUID?.() ?? `stub-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export function loadNotes(): StubNote[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(NOTES_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveNotes(notes: StubNote[]): void {
  localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(notes));
}

export function loadNoteTags(): StubNoteTag[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(NOTE_TAGS_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveNoteTags(tags: StubNoteTag[]): void {
  localStorage.setItem(NOTE_TAGS_STORAGE_KEY, JSON.stringify(tags));
}

export function loadNoteAcks(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(NOTE_ALERT_ACK_STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveNoteAcks(acks: Record<string, number>): void {
  localStorage.setItem(NOTE_ALERT_ACK_STORAGE_KEY, JSON.stringify(acks));
}

/** Hydrate the wire NoteItem shape (steps + resolved tags) from a stored note. */
export function stubNoteToItem(note: StubNote): Record<string, unknown> {
  const allTags = loadNoteTags();
  const tags = note.tag_ids
    .map((id) => allTags.find((t) => t.id === id))
    .filter((t): t is StubNoteTag => Boolean(t));
  const { tag_ids: _drop, ...rest } = note;
  return { ...rest, tags };
}

export function stubFilterNotes(notes: StubNote[], query: Record<string, unknown>): StubNote[] {
  const filter = (query.filter as string | undefined) ?? "recent_incomplete";
  const filters = Array.isArray(query.filters) && query.filters.length > 0 ? query.filters.map(String) : [filter];
  const now = Number(query.now) || nowSecsStub();
  const dueSoon = Number(query.due_soon_secs) || NOTE_DUE_SOON_SECS;
  const search = ((query.search as string | undefined) ?? "").trim().toLowerCase();
  const tagId = (query.tag_id as string | undefined) ?? null;
  const allTags = loadNoteTags();

  let list = notes.filter((n) =>
    filters.some((status) => {
      switch (status) {
        case "all":
          return n.archived_at === null;
        case "pinned":
          return n.archived_at === null && n.pinned;
        case "completed":
          return n.archived_at === null && n.completed_at !== null;
        case "archived":
          return n.archived_at !== null;
        case "today": {
          if (n.archived_at !== null || n.completed_at !== null || n.due_at === null) return false;
          const d = new Date(now * 1000);
          const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
          return n.due_at >= start && n.due_at < start + 86400;
        }
        case "due_soon":
          return (
            n.archived_at === null &&
            n.completed_at === null &&
            n.due_at !== null &&
            n.due_at > now &&
            n.due_at <= now + dueSoon
          );
        case "overdue":
          return n.archived_at === null && n.completed_at === null && n.due_at !== null && n.due_at <= now;
        default: // recent_incomplete
          return n.archived_at === null && n.completed_at === null;
      }
    }),
  );

  if (tagId) list = list.filter((n) => n.tag_ids.includes(tagId));
  if (search) {
    list = list.filter((n) => {
      if (n.title.toLowerCase().includes(search) || n.body.toLowerCase().includes(search)) return true;
      return n.tag_ids.some((id) => {
        const tag = allTags.find((t) => t.id === id);
        return tag ? tag.name.toLowerCase().includes(search) : false;
      });
    });
  }

  list.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const aNull = a.due_at === null ? 1 : 0;
    const bNull = b.due_at === null ? 1 : 0;
    if (aNull !== bNull) return aNull - bNull;
    if (a.due_at !== null && b.due_at !== null && a.due_at !== b.due_at) return a.due_at - b.due_at;
    return b.updated_at - a.updated_at;
  });

  const offset = Math.max(0, Number(query.offset) || 0);
  const limit = query.limit != null && Number(query.limit) >= 0 ? Number(query.limit) : undefined;
  return limit != null ? list.slice(offset, offset + limit) : list.slice(offset);
}

export async function invokeNotes<T>(cmd: string, args?: any): Promise<T> {
  switch (cmd) {

    // ---------- Tao Notes (browser preview) ----------
    case "notes_list": {
      const query = ((args as InvokeArgs | undefined)?.query as Record<string, unknown> | undefined) ?? {};
      return stubFilterNotes(loadNotes(), query).map(stubNoteToItem) as T;
    }

    case "notes_get": {
      const id = (args as InvokeArgs | undefined)?.id as string | undefined;
      const note = loadNotes().find((n) => n.id === id);
      return (note ? stubNoteToItem(note) : null) as T;
    }

    case "notes_create": {
      const input = ((args as InvokeArgs | undefined)?.input as Record<string, unknown> | undefined) ?? {};
      const ts = nowSecsStub();
      const note: StubNote = {
        id: stubId(),
        title: (input.title as string | undefined) ?? "",
        body: (input.body as string | undefined) ?? "",
        completed_at: null,
        pinned: (input.pinned as boolean | undefined) ?? false,
        archived_at: null,
        color: (input.color as string | null | undefined) ?? null,
        priority: Number(input.priority) || 0,
        due_at: (input.due_at as number | null | undefined) ?? null,
        reminder_at: (input.reminder_at as number | null | undefined) ?? null,
        repeat_rule: (input.repeat_rule as string | null | undefined) ?? null,
        source_tab_id: (input.source_tab_id as string | null | undefined) ?? null,
        source_session_id: (input.source_session_id as string | null | undefined) ?? null,
        source_title: (input.source_title as string | null | undefined) ?? null,
        source_uri: (input.source_uri as string | null | undefined) ?? null,
        created_at: ts,
        updated_at: ts,
        steps: [],
        tag_ids: ((input.tag_ids as string[] | undefined) ?? []).slice(),
      };
      saveNotes([note, ...loadNotes()]);
      return stubNoteToItem(note) as T;
    }

    case "notes_update": {
      const id = (args as InvokeArgs | undefined)?.id as string | undefined;
      const patch = ((args as InvokeArgs | undefined)?.patch as Record<string, unknown> | undefined) ?? {};
      const notes = loadNotes();
      const idx = notes.findIndex((n) => n.id === id);
      if (idx < 0) return null as T;
      const ts = nowSecsStub();
      notes[idx] = {
        ...notes[idx],
        title: (patch.title as string | undefined) ?? notes[idx].title,
        body: (patch.body as string | undefined) ?? "",
        pinned: (patch.pinned as boolean | undefined) ?? false,
        color: (patch.color as string | null | undefined) ?? null,
        priority: Number(patch.priority) || 0,
        due_at: (patch.due_at as number | null | undefined) ?? null,
        reminder_at: (patch.reminder_at as number | null | undefined) ?? null,
        repeat_rule: (patch.repeat_rule as string | null | undefined) ?? null,
        source_tab_id: (patch.source_tab_id as string | null | undefined) ?? null,
        source_session_id: (patch.source_session_id as string | null | undefined) ?? null,
        source_title: (patch.source_title as string | null | undefined) ?? null,
        source_uri: (patch.source_uri as string | null | undefined) ?? null,
        updated_at: ts,
        tag_ids: (patch.tag_ids as string[] | undefined) ?? notes[idx].tag_ids,
      };
      saveNotes(notes);
      return stubNoteToItem(notes[idx]) as T;
    }

    case "notes_delete": {
      const id = (args as InvokeArgs | undefined)?.id as string | undefined;
      saveNotes(loadNotes().filter((n) => n.id !== id));
      return undefined as T;
    }

    case "notes_toggle_complete": {
      const id = (args as InvokeArgs | undefined)?.id as string | undefined;
      const completed = Boolean((args as InvokeArgs | undefined)?.completed);
      const notes = loadNotes();
      const idx = notes.findIndex((n) => n.id === id);
      if (idx < 0) return null as T;
      const ts = nowSecsStub();
      notes[idx] = { ...notes[idx], completed_at: completed ? ts : null, updated_at: ts };
      saveNotes(notes);
      return stubNoteToItem(notes[idx]) as T;
    }

    case "notes_archive": {
      const id = (args as InvokeArgs | undefined)?.id as string | undefined;
      const archived = Boolean((args as InvokeArgs | undefined)?.archived);
      const notes = loadNotes();
      const idx = notes.findIndex((n) => n.id === id);
      if (idx < 0) return null as T;
      const ts = nowSecsStub();
      notes[idx] = { ...notes[idx], archived_at: archived ? ts : null, updated_at: ts };
      saveNotes(notes);
      return stubNoteToItem(notes[idx]) as T;
    }

    case "notes_list_tags": {
      return loadNoteTags().slice().sort((a, b) => a.name.localeCompare(b.name)) as T;
    }

    case "notes_upsert_tags": {
      const inputTags = ((args as InvokeArgs | undefined)?.tags as Array<Record<string, unknown>> | undefined) ?? [];
      const tags = loadNoteTags();
      const out: StubNoteTag[] = [];
      const ts = nowSecsStub();
      for (const t of inputTags) {
        const name = String(t.name ?? "").trim();
        if (!name) continue;
        const tagId = t.id as string | undefined;
        let existing =
          (tagId ? tags.find((x) => x.id === tagId) : undefined) ??
          tags.find((x) => x.name === name);
        if (existing) {
          existing.name = name;
          existing.color = (t.color as string | null | undefined) ?? null;
          existing.updated_at = ts;
        } else {
          existing = { id: stubId(), name, color: (t.color as string | null | undefined) ?? null, created_at: ts, updated_at: ts };
          tags.push(existing);
        }
        out.push(existing);
      }
      saveNoteTags(tags);
      return out as T;
    }

    case "notes_set_steps": {
      const noteId = (args as InvokeArgs | undefined)?.noteId as string | undefined;
      const stepInputs = ((args as InvokeArgs | undefined)?.steps as Array<Record<string, unknown>> | undefined) ?? [];
      const notes = loadNotes();
      const idx = notes.findIndex((n) => n.id === noteId);
      if (idx < 0) return [] as T;
      const ts = nowSecsStub();
      const steps: StubNoteStep[] = stepInputs.map((s, i) => ({
        id: (s.id as string | undefined) ?? stubId(),
        note_id: noteId as string,
        title: String(s.title ?? ""),
        completed_at: (s.completed_at as number | null | undefined) ?? null,
        sort_order: s.sort_order != null ? Number(s.sort_order) : i,
        created_at: ts,
        updated_at: ts,
      }));
      steps.sort((a, b) => a.sort_order - b.sort_order);
      notes[idx] = { ...notes[idx], steps, updated_at: ts };
      saveNotes(notes);
      return steps as T;
    }

    case "notes_get_prefs": {
      try {
        const parsed = JSON.parse(localStorage.getItem(NOTE_PREFS_STORAGE_KEY) ?? "{}");
        return (parsed && typeof parsed === "object" ? parsed : {}) as T;
      } catch {
        return {} as T;
      }
    }

    case "notes_set_prefs": {
      const prefs = ((args as InvokeArgs | undefined)?.prefs as Record<string, string> | undefined) ?? {};
      let current: Record<string, string> = {};
      try {
        current = JSON.parse(localStorage.getItem(NOTE_PREFS_STORAGE_KEY) ?? "{}") || {};
      } catch {
        current = {};
      }
      localStorage.setItem(NOTE_PREFS_STORAGE_KEY, JSON.stringify({ ...current, ...prefs }));
      return undefined as T;
    }

    case "notes_list_alerts": {
      const now = Number((args as InvokeArgs | undefined)?.now) || nowSecsStub();
      const dueSoon = Number((args as InvokeArgs | undefined)?.dueSoonSecs) || NOTE_DUE_SOON_SECS;
      const acks = loadNoteAcks();
      const alerts: Array<Record<string, unknown>> = [];
      for (const n of loadNotes()) {
        if (n.completed_at !== null || n.archived_at !== null) continue;
        const emit = (kind: string, fireAt: number) => {
          const id = `${n.id}:${kind}`;
          alerts.push({
            id,
            note_id: n.id,
            kind,
            state: acks[id] ? "acknowledged" : "pending",
            fire_at: fireAt,
            acknowledged_at: acks[id] ?? null,
            note_title: n.title,
            due_at: n.due_at,
            reminder_at: n.reminder_at,
          });
        };
        if (n.due_at !== null && n.due_at <= now) emit("overdue", n.due_at);
        else if (n.due_at !== null && n.due_at > now && n.due_at <= now + dueSoon) emit("due_soon", n.due_at);
        if (n.reminder_at !== null && n.reminder_at <= now) emit("reminder", n.reminder_at);
      }
      const rank: Record<string, number> = { overdue: 0, reminder: 1, due_soon: 2 };
      alerts.sort((a, b) => (rank[a.kind as string] - rank[b.kind as string]) || (Number(a.fire_at) - Number(b.fire_at)));
      return alerts as T;
    }

    case "notes_ack_alert": {
      const id = (args as InvokeArgs | undefined)?.id as string | undefined;
      if (id) {
        const acks = loadNoteAcks();
        acks[id] = nowSecsStub();
        saveNoteAcks(acks);
      }
      return undefined as T;
    }
    default: throw new Error(`Unhandled notes stub command: ${cmd}`);
  }
}
