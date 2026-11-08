import { detectDetachedRoute } from "../lib/detachedSession";

export interface NoteContent {
  title: string;
  body: string;
}

export interface NoteDocument extends NoteContent {
  saved: NoteContent;
  dirty: boolean;
  saving: boolean;
  error: "conflict" | "missing" | "storage" | null;
  errorDetail: string | null;
}

const RECOVERY_KEY = "taomni.notes.drafts.v1";

function recoveryKey(): string {
  // A clean main window must never erase an independent floating window's draft.
  return detectDetachedRoute()?.kind === "notes" ? `${RECOVERY_KEY}.floating` : RECOVERY_KEY;
}

export function sameNoteContent(a: NoteContent, b: NoteContent): boolean {
  return a.title === b.title && a.body === b.body;
}

export function readNoteDrafts(): Record<string, NoteDocument> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(recoveryKey()) ?? "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).flatMap(([id, value]) => {
      const doc = value as Partial<NoteDocument> | null;
      if (!doc || typeof doc.title !== "string" || typeof doc.body !== "string"
        || typeof doc.saved?.title !== "string" || typeof doc.saved.body !== "string") return [];
      return [[id, { title: doc.title, body: doc.body, saved: doc.saved, dirty: true,
        saving: false, error: null, errorDetail: null } satisfies NoteDocument]];
    }));
  } catch { return {}; }
}

export function persistNoteDrafts(documents: Record<string, NoteDocument>): string | null {
  try {
    localStorage.setItem(recoveryKey(), JSON.stringify(Object.fromEntries(
      Object.entries(documents).filter(([, doc]) => doc.dirty)
        .map(([id, doc]) => [id, { title: doc.title, body: doc.body, saved: doc.saved }]),
    )));
    return null;
  } catch (error) { return String(error); }
}
