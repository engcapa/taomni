import { invoke } from "@tauri-apps/api/core";

// Wire types mirror the Rust `notes::db` models (snake_case), matching how the
// chat module surfaces its DB rows. All timestamps are Unix **seconds**.

export interface NoteStep {
  id: string;
  note_id: string;
  title: string;
  completed_at: number | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface NoteTag {
  id: string;
  name: string;
  color: string | null;
  created_at: number;
  updated_at: number;
}

export interface NoteItem {
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
  steps: NoteStep[];
  tags: NoteTag[];
}

export type NoteFilter =
  | "recent_incomplete"
  | "all"
  | "pinned"
  | "today"
  | "due_soon"
  | "overdue"
  | "completed"
  | "archived"
  | "tag";

export interface NoteQuery {
  filter?: NoteFilter;
  search?: string;
  tag_id?: string;
  limit?: number;
  offset?: number;
  now?: number;
  due_soon_secs?: number;
}

export interface CreateNoteInput {
  title?: string;
  body?: string;
  pinned?: boolean;
  color?: string | null;
  priority?: number;
  due_at?: number | null;
  reminder_at?: number | null;
  repeat_rule?: string | null;
  source_tab_id?: string | null;
  source_session_id?: string | null;
  source_title?: string | null;
  source_uri?: string | null;
  tag_ids?: string[];
}

/** Full-replace patch: send the complete editable state; nullable fields clear by passing null. */
export interface UpdateNoteInput {
  title: string;
  body: string;
  pinned?: boolean;
  color?: string | null;
  priority?: number;
  due_at?: number | null;
  reminder_at?: number | null;
  repeat_rule?: string | null;
  source_tab_id?: string | null;
  source_session_id?: string | null;
  source_title?: string | null;
  source_uri?: string | null;
  tag_ids?: string[];
}

export interface StepInput {
  id?: string;
  title: string;
  completed_at?: number | null;
  sort_order?: number;
}

export interface TagInput {
  id?: string;
  name: string;
  color?: string | null;
}

export type NoteAlertKind = "overdue" | "due_soon" | "reminder";
export type NoteAlertState = "pending" | "acknowledged";

export interface NoteAlert {
  id: string;
  note_id: string;
  kind: NoteAlertKind;
  state: NoteAlertState;
  fire_at: number;
  acknowledged_at: number | null;
  note_title: string;
  due_at: number | null;
  reminder_at: number | null;
}

/** Current time in Unix seconds (the notes wire convention). */
export function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

export async function listNotes(query: NoteQuery = {}): Promise<NoteItem[]> {
  return invoke<NoteItem[]>("notes_list", { query });
}

export async function getNote(id: string): Promise<NoteItem | null> {
  return invoke<NoteItem | null>("notes_get", { id });
}

export async function createNote(input: CreateNoteInput = {}): Promise<NoteItem> {
  return invoke<NoteItem>("notes_create", { input });
}

export async function updateNote(id: string, patch: UpdateNoteInput): Promise<NoteItem | null> {
  return invoke<NoteItem | null>("notes_update", { id, patch });
}

export async function deleteNote(id: string): Promise<void> {
  await invoke("notes_delete", { id });
}

export async function toggleNoteComplete(id: string, completed: boolean): Promise<NoteItem | null> {
  return invoke<NoteItem | null>("notes_toggle_complete", { id, completed });
}

export async function archiveNote(id: string, archived: boolean): Promise<NoteItem | null> {
  return invoke<NoteItem | null>("notes_archive", { id, archived });
}

export async function listTags(): Promise<NoteTag[]> {
  return invoke<NoteTag[]>("notes_list_tags", {});
}

export async function upsertTags(tags: TagInput[]): Promise<NoteTag[]> {
  return invoke<NoteTag[]>("notes_upsert_tags", { tags });
}

export async function setSteps(noteId: string, steps: StepInput[]): Promise<NoteStep[]> {
  return invoke<NoteStep[]>("notes_set_steps", { noteId, steps });
}

export async function getPrefs(): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("notes_get_prefs", {});
}

export async function setPrefs(prefs: Record<string, string>): Promise<void> {
  await invoke("notes_set_prefs", { prefs });
}

export async function listAlerts(now?: number, dueSoonSecs?: number): Promise<NoteAlert[]> {
  return invoke<NoteAlert[]>("notes_list_alerts", {
    now: now ?? null,
    dueSoonSecs: dueSoonSecs ?? null,
  });
}

export async function ackAlert(id: string): Promise<void> {
  await invoke("notes_ack_alert", { id });
}

/** Derive the badge state of a note purely from its timestamps + a reference now. */
export function noteAlertKind(
  note: Pick<NoteItem, "completed_at" | "archived_at" | "due_at" | "reminder_at">,
  now: number = nowSecs(),
  dueSoonSecs = 30 * 60,
): NoteAlertKind | null {
  if (note.completed_at !== null || note.archived_at !== null) return null;
  if (note.due_at !== null && note.due_at <= now) return "overdue";
  if (note.reminder_at !== null && note.reminder_at <= now) return "reminder";
  if (note.due_at !== null && note.due_at > now && note.due_at <= now + dueSoonSecs) return "due_soon";
  return null;
}
