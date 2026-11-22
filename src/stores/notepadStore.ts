import { create } from "zustand";
import { documentPathKey } from "../lib/openFile/pathIdentity";
import type { NotepadSearchMode } from "../lib/notepad/transforms/escape";

export type NotepadDockPos = "right" | "bottom" | "float";
export type NotepadPanelId = "minimap" | "doclist" | "chars" | "results";
export type NotepadSplitOrient = "v" | "h";
export type NotepadViewMode = "" | "fullscreen" | "postit" | "focus";
export type NotepadFindTab = "find" | "replace" | "files" | "mark";

export interface NotepadPanelState {
  open: boolean;
  pos: NotepadDockPos;
  x?: number;
  y?: number;
}

export interface NotepadSymbolFlags {
  space: boolean;
  tab: boolean;
  eol: boolean;
  nonprint: boolean;
  indent: boolean;
  wrap: boolean;
}

export interface NotepadMarkRule {
  id: string;
  style: number; // 0 = Find Mark, 1..5 = Token Style 1..5
  query: string;
  mode: NotepadSearchMode;
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface NotepadFindState {
  open: boolean;
  tab: NotepadFindTab;
  compact: boolean;
  opacity: number;
  query: string;
  replace: string;
  mode: NotepadSearchMode;
  caseSensitive: boolean;
  wholeWord: boolean;
  wrapAround: boolean;
  backward: boolean;
  inSelection: boolean;
  dotAll: boolean;
  highlightAll: boolean;
  incremental: boolean;
  markStyle: number;
  filesDir: string;
  filesFilter: string;
  filesIncludeSubdirs: boolean;
}

export interface NotepadSearchResultHit {
  docId?: string;
  filePath?: string;
  name: string;
  line: number; // 0-based
  column: number; // 0-based
  from: number;
  to: number;
  lineText: string;
  matchLength: number;
}

export interface NotepadMacroStep {
  type: "command" | "insertText";
  commandId?: string;
  args?: Record<string, unknown>;
  text?: string;
}

export interface NotepadSavedMacro {
  name: string;
  key?: string;
  steps: NotepadMacroStep[];
}

export interface NotepadMacroState {
  recording: boolean;
  recordingDocId: string | null;
  buffer: NotepadMacroStep[];
  saved: NotepadSavedMacro[];
  hash: string;
  tampered: boolean;
  loaded: boolean;
}

export interface NotepadCompareState {
  open: boolean;
  leftTitle: string;
  leftContent: string;
  rightTitle: string;
  rightContent: string;
  ignoreWhitespace: boolean;
  ignoreCase: boolean;
}

export interface NotepadDocState {
  docId: string;
  titleHint?: string;
  split: boolean;
  orient: NotepadSplitOrient;
  syncScroll: boolean;
  syncScrollV: boolean;
  syncScrollH: boolean;
  activePane: 0 | 1;
  bookmarks: number[];
  marks: NotepadMarkRule[];
  paneSelections: [{ from: number; to: number }, { from: number; to: number }];
  paneScrolls: [{ top: number; left: number }, { top: number; left: number }];
  beginSelectAnchor: { pos: number; columnMode: boolean } | null;
  activeMatch: { from: number; to: number } | null;
  changeHistoryBaseline: string[] | null;
  changeHistoryResetNonce: number;
  largeEditConfirmed: boolean;
  detectedEncoding?: string;
  lastBackupAt?: number;
  backupState?: "idle" | "saving" | "saved" | "error";
  find: NotepadFindState;
}

export interface NotepadStoreState {
  docs: Record<string, NotepadDocState>;
  panels: Record<NotepadPanelId, NotepadPanelState>;
  ui: { menubar: boolean; toolbar: boolean; statusbar: boolean };
  viewMode: NotepadViewMode;
  insertMode: boolean;
  virtualSpace: boolean;
  zoomDelta: number;
  symbols: NotepadSymbolFlags;
  clipboardHistory: string[];
  results: NotepadSearchResultHit[];
  resultsTitle: string;
  macro: NotepadMacroState;
  compare: NotepadCompareState | null;
  ensureDoc: (docId: string, titleHint?: string) => NotepadDocState;
  removeDoc: (docId: string) => void;
  rekeyDoc: (oldDocId: string, newDocId: string, titleHint?: string) => void;
  patchDoc: (docId: string, patch: Partial<NotepadDocState>) => void;
  patchFind: (docId: string, patch: Partial<NotepadFindState>) => void;
  toggleBookmark: (docId: string, lineZeroBased: number) => void;
  setBookmarks: (docId: string, lines: number[]) => void;
  addMark: (docId: string, rule: NotepadMarkRule) => void;
  clearMarks: (docId: string, style?: number) => void;
  togglePanel: (panel: NotepadPanelId) => void;
  setPanelPos: (panel: NotepadPanelId, pos: NotepadDockPos, coords?: { x: number; y: number }) => void;
  setUiFlag: (key: "menubar" | "toolbar" | "statusbar", value: boolean) => void;
  setViewMode: (mode: NotepadViewMode) => void;
  setInsertMode: (insertMode: boolean) => void;
  setVirtualSpace: (virtualSpace: boolean) => void;
  setZoomDelta: (delta: number) => void;
  toggleSymbol: (key: keyof NotepadSymbolFlags) => void;
  toggleAllSymbols: () => void;
  pushClipboardHistory: (text: string) => void;
  setSearchResults: (title: string, hits: NotepadSearchResultHit[]) => void;
  patchMacro: (patch: Partial<NotepadMacroState>) => void;
  setCompare: (compare: NotepadCompareState | null) => void;
}

const PANELS_PREFS_KEY = "taomni.notepad.panels.v1";

export function defaultFindState(): NotepadFindState {
  return {
    open: false,
    tab: "find",
    compact: false,
    opacity: 1,
    query: "",
    replace: "",
    mode: "normal",
    caseSensitive: false,
    wholeWord: false,
    wrapAround: true,
    backward: false,
    inSelection: false,
    dotAll: false,
    highlightAll: true,
    incremental: false,
    markStyle: 0,
    filesDir: "",
    filesFilter: "*.txt;*.md;*.log",
    filesIncludeSubdirs: true,
  };
}

export function createDefaultDocState(docId: string, titleHint?: string): NotepadDocState {
  return {
    docId: documentPathKey(docId),
    titleHint,
    split: false,
    orient: "v",
    syncScroll: false,
    syncScrollV: false,
    syncScrollH: false,
    activePane: 0,
    bookmarks: [],
    marks: [],
    paneSelections: [{ from: 0, to: 0 }, { from: 0, to: 0 }],
    paneScrolls: [{ top: 0, left: 0 }, { top: 0, left: 0 }],
    beginSelectAnchor: null,
    activeMatch: null,
    changeHistoryBaseline: null,
    changeHistoryResetNonce: 0,
    largeEditConfirmed: false,
    backupState: "idle",
    find: defaultFindState(),
  };
}

function defaultPanels(): Record<NotepadPanelId, NotepadPanelState> {
  const base: Record<NotepadPanelId, NotepadPanelState> = {
    minimap: { open: false, pos: "right" },
    doclist: { open: false, pos: "right" },
    chars: { open: false, pos: "right" },
    results: { open: false, pos: "bottom" },
  };
  try {
    const raw = JSON.parse(localStorage.getItem(PANELS_PREFS_KEY) ?? "null") as Partial<Record<NotepadPanelId, NotepadPanelState>> | null;
    if (raw && typeof raw === "object") {
      for (const id of ["minimap", "doclist", "chars", "results"] as const) {
        const entry = raw[id];
        if (entry && ["right", "bottom", "float"].includes(entry.pos)) {
          base[id] = { open: false, pos: entry.pos, x: entry.x, y: entry.y };
        }
      }
    }
  } catch {
    // Ignore invalid stored panel layout.
  }
  return base;
}

function persistPanelPositions(panels: Record<NotepadPanelId, NotepadPanelState>): void {
  try {
    localStorage.setItem(PANELS_PREFS_KEY, JSON.stringify(panels));
  } catch {
    // Ignore storage errors.
  }
}

export function nextUntitledName(pattern: string, existingTitles: Iterable<string>): string {
  const used = new Set(existingTitles);
  let idx = 1;
  while (used.has(pattern.replace("{n}", String(idx)))) {
    idx += 1;
  }
  return pattern.replace("{n}", String(idx));
}

export const useNotepadStore = create<NotepadStoreState>((set, get) => ({
  docs: {},
  panels: defaultPanels(),
  ui: { menubar: true, toolbar: true, statusbar: true },
  viewMode: "",
  insertMode: true,
  virtualSpace: false,
  zoomDelta: 0,
  symbols: { space: false, tab: false, eol: false, nonprint: false, indent: false, wrap: false },
  clipboardHistory: [],
  results: [],
  resultsTitle: "",
  macro: {
    recording: false,
    recordingDocId: null,
    buffer: [],
    saved: [],
    hash: "",
    tampered: false,
    loaded: false,
  },
  compare: null,

  ensureDoc(docId, titleHint) {
    const key = documentPathKey(docId);
    const existing = get().docs[key];
    if (existing) return existing;
    const created = createDefaultDocState(key, titleHint);
    set((state) => ({ docs: { ...state.docs, [key]: created } }));
    return created;
  },

  removeDoc(docId) {
    const key = documentPathKey(docId);
    set((state) => {
      if (!state.docs[key]) return state;
      const docs = { ...state.docs };
      delete docs[key];
      return { docs };
    });
  },

  rekeyDoc(oldDocId, newDocId, titleHint) {
    const oldKey = documentPathKey(oldDocId);
    const newKey = documentPathKey(newDocId);
    set((state) => {
      const current = state.docs[oldKey] ?? createDefaultDocState(oldKey);
      const docs = { ...state.docs };
      if (oldKey !== newKey) delete docs[oldKey];
      docs[newKey] = { ...current, docId: newKey, titleHint: titleHint ?? current.titleHint };
      return { docs };
    });
  },

  patchDoc(docId, patch) {
    const key = documentPathKey(docId);
    set((state) => {
      const current = state.docs[key] ?? createDefaultDocState(key);
      const merged = { ...current, ...patch };
      if (patch.syncScrollV !== undefined || patch.syncScrollH !== undefined) {
        merged.syncScroll = Boolean(merged.syncScrollV || merged.syncScrollH);
      } else if (patch.syncScroll !== undefined) {
        merged.syncScrollV = patch.syncScroll;
        merged.syncScrollH = patch.syncScroll;
      }
      return { docs: { ...state.docs, [key]: merged } };
    });
  },

  patchFind(docId, patch) {
    const key = documentPathKey(docId);
    set((state) => {
      const current = state.docs[key] ?? createDefaultDocState(key);
      return {
        docs: {
          ...state.docs,
          [key]: { ...current, find: { ...current.find, ...patch } },
        },
      };
    });
  },

  toggleBookmark(docId, lineZeroBased) {
    const key = documentPathKey(docId);
    set((state) => {
      const current = state.docs[key] ?? createDefaultDocState(key);
      const exists = current.bookmarks.includes(lineZeroBased);
      const bookmarks = exists
        ? current.bookmarks.filter((ln) => ln !== lineZeroBased)
        : [...current.bookmarks, lineZeroBased].sort((a, b) => a - b);
      return { docs: { ...state.docs, [key]: { ...current, bookmarks } } };
    });
  },

  setBookmarks(docId, lines) {
    const key = documentPathKey(docId);
    const uniqueSorted = [...new Set(lines.filter((n) => n >= 0))].sort((a, b) => a - b);
    get().patchDoc(key, { bookmarks: uniqueSorted });
  },

  addMark(docId, rule) {
    const key = documentPathKey(docId);
    set((state) => {
      const current = state.docs[key] ?? createDefaultDocState(key);
      return { docs: { ...state.docs, [key]: { ...current, marks: [...current.marks, rule] } } };
    });
  },

  clearMarks(docId, style) {
    const key = documentPathKey(docId);
    set((state) => {
      const current = state.docs[key];
      if (!current) return state;
      const marks = style === undefined ? [] : current.marks.filter((m) => m.style !== style);
      return { docs: { ...state.docs, [key]: { ...current, marks } } };
    });
  },

  togglePanel(panel) {
    set((state) => {
      const next = { ...state.panels, [panel]: { ...state.panels[panel], open: !state.panels[panel].open } };
      return { panels: next };
    });
  },

  setPanelPos(panel, pos, coords) {
    set((state) => {
      const next = {
        ...state.panels,
        [panel]: {
          ...state.panels[panel],
          pos,
          ...(coords ? { x: coords.x, y: coords.y } : {}),
        },
      };
      persistPanelPositions(next);
      return { panels: next };
    });
  },

  setUiFlag(key, value) {
    set((state) => ({ ui: { ...state.ui, [key]: value } }));
  },

  setViewMode(viewMode) {
    set({ viewMode });
  },

  setInsertMode(insertMode) {
    set({ insertMode });
  },

  setVirtualSpace(virtualSpace) {
    set({ virtualSpace });
  },

  setZoomDelta(zoomDelta) {
    set({ zoomDelta: Math.max(-5, Math.min(19, zoomDelta)) });
  },

  toggleSymbol(key) {
    set((state) => ({ symbols: { ...state.symbols, [key]: !state.symbols[key] } }));
  },

  toggleAllSymbols() {
    set((state) => {
      const allOn = Object.values(state.symbols).every(Boolean);
      const next = !allOn;
      return {
        symbols: { space: next, tab: next, eol: next, nonprint: next, indent: next, wrap: next },
      };
    });
  },

  pushClipboardHistory(text) {
    if (!text) return;
    set((state) => {
      const deduped = [text, ...state.clipboardHistory.filter((item) => item !== text)].slice(0, 30);
      return { clipboardHistory: deduped };
    });
  },

  setSearchResults(resultsTitle, results) {
    set((state) => ({
      resultsTitle,
      results,
      panels: { ...state.panels, results: { ...state.panels.results, open: true } },
    }));
  },

  patchMacro(patch) {
    set((state) => ({ macro: { ...state.macro, ...patch } }));
  },

  setCompare(compare) {
    set({ compare });
  },
}));
