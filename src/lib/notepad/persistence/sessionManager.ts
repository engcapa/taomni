import { notepadSessionLoad, notepadSessionSave } from "../ipc";

/**
 * Schema v1 for saved Notepad sessions.
 * Mark highlight rules are intentionally omitted and never persisted to session files.
 */
export interface SessionTabEntry {
  docKey: string;
  path: string | null;
  untitled: boolean;
  name: string;
  pinned: boolean;
  encoding: string;
  bom: boolean;
  eol: "LF" | "CRLF" | "CR";
  cursorLine: number;
  cursorCol: number;
  scrollTop: number;
  bookmarks: number[];
  wrap: boolean;
  readOnly: boolean;
  split: boolean;
  /** Optional inline content captured only when untitled documents lack a backup path. */
  untitledContent?: string;
}

export interface SessionFileV1 {
  version: 1;
  savedAt: number;
  activeDocKey: string | null;
  tabs: SessionTabEntry[];
}

export function serializeSession(
  tabs: SessionTabEntry[],
  activeDocKey: string | null,
): string {
  const sanitizedTabs: SessionTabEntry[] = tabs.map((t) => ({
    docKey: t.docKey,
    path: t.path,
    untitled: t.untitled,
    name: t.name,
    pinned: Boolean(t.pinned),
    encoding: t.encoding,
    bom: Boolean(t.bom),
    eol: t.eol,
    cursorLine: Math.max(1, Math.trunc(t.cursorLine || 1)),
    cursorCol: Math.max(1, Math.trunc(t.cursorCol || 1)),
    scrollTop: Math.max(0, Math.round(t.scrollTop || 0)),
    bookmarks: [...new Set(t.bookmarks.filter((n) => n >= 0))].sort((a, b) => a - b),
    wrap: Boolean(t.wrap),
    readOnly: Boolean(t.readOnly),
    split: Boolean(t.split),
    ...(t.untitled && t.untitledContent !== undefined ? { untitledContent: t.untitledContent } : {}),
  }));
  const payload: SessionFileV1 = {
    version: 1,
    savedAt: Date.now(),
    activeDocKey,
    tabs: sanitizedTabs,
  };
  return JSON.stringify(payload, null, 2);
}

export function parseSession(rawJson: string): SessionFileV1 {
  const parsed = JSON.parse(rawJson) as Partial<SessionFileV1>;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.tabs)) {
    throw new Error("corrupt: Invalid Taomni Notepad session v1 file");
  }
  return {
    version: 1,
    savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : Date.now(),
    activeDocKey: typeof parsed.activeDocKey === "string" ? parsed.activeDocKey : null,
    tabs: parsed.tabs.map((tab) => ({
      docKey: String(tab.docKey ?? ""),
      path: typeof tab.path === "string" ? tab.path : null,
      untitled: Boolean(tab.untitled),
      name: String(tab.name ?? "Untitled"),
      pinned: Boolean(tab.pinned),
      encoding: String(tab.encoding ?? "UTF-8"),
      bom: Boolean(tab.bom),
      eol: tab.eol === "CRLF" || tab.eol === "CR" ? tab.eol : "LF",
      cursorLine: typeof tab.cursorLine === "number" ? tab.cursorLine : 1,
      cursorCol: typeof tab.cursorCol === "number" ? tab.cursorCol : 1,
      scrollTop: typeof tab.scrollTop === "number" ? tab.scrollTop : 0,
      bookmarks: Array.isArray(tab.bookmarks) ? tab.bookmarks.filter((n): n is number => typeof n === "number") : [],
      wrap: Boolean(tab.wrap),
      readOnly: Boolean(tab.readOnly),
      split: Boolean(tab.split),
      ...(typeof tab.untitledContent === "string" ? { untitledContent: tab.untitledContent } : {}),
    })),
  };
}

export async function saveSessionToDisk(
  tabs: SessionTabEntry[],
  activeDocKey: string | null,
  filePath?: string | null,
): Promise<string> {
  const json = serializeSession(tabs, activeDocKey);
  return notepadSessionSave(json, filePath);
}

export async function loadSessionFromDisk(filePath?: string | null): Promise<SessionFileV1 | null> {
  const raw = await notepadSessionLoad(filePath);
  if (!raw) return null;
  return parseSession(raw);
}
