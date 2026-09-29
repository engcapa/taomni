import { create } from "zustand";

export type WorkspaceEol = "LF" | "CRLF" | "CR";

export interface CodeWorkspaceLspProgress {
  key: string;
  label: string;
  message: string | null;
  percentage: number | null;
  cancellable: boolean;
}

/** One IDEA navigation-bar segment (ED-PARITY-010 DEC-010-06). */
export interface CodeWorkspaceNavigationSegment {
  label: string;
  kind: "root" | "dir" | "file" | "symbol";
  /** LSP SymbolKind for symbol segments (class, method, …). */
  symbolKind?: number;
}

export interface CodeWorkspaceStatusSegments {
  tabId: string;
  /** 1-based line for display. */
  line: number;
  /** 1-based column for display. */
  column: number;
  encoding: string;
  eol: WorkspaceEol;
  indentation?: string | null;
  languageId: string | null;
  lspActive: boolean;
  lspLabel: string | null;
  lspError: boolean;
  gitBranch: string | null;
  gitAhead: number;
  gitBehind: number;
  fontSize: number;
  /** Large-file mode: semantic tokens / inlay hints / highlight are downgraded. */
  largeFile: boolean;
  /** Most recently updated server work-done task, when one is active. */
  lspProgress?: CodeWorkspaceLspProgress | null;
  /** Selected character count (0 when the selection is empty). */
  selectionChars?: number;
  /** Line breaks inside the selection. */
  selectionLineBreaks?: number;
  /** Active editor is read-only (library/decompiled/locked). */
  readOnly?: boolean;
  /** Navigation bar path: root › directories › file › symbols. */
  navigation?: readonly CodeWorkspaceNavigationSegment[];
}

export interface CodeWorkspaceStatusActions {
  openLanguagePanel?: () => void;
  openGitManager?: () => void;
  cancelLspProgress?: () => void;
  /** Cycle the active editor's on-disk line ending and mark it dirty. */
  cycleEol?: () => void;
  /** Toggle preservation of the UTF-8 byte-order marker and mark it dirty. */
  toggleBom?: () => void;
  /** Open the charset/BOM chooser for the active editor. */
  chooseEncoding?: () => void;
  /** Cycle the active editor's indentation display and preference. */
  cycleIndentation?: () => void;
}

interface CodeWorkspaceStatusStoreState {
  /** Status-bar slot where the active workspace portals its SDK/Facts widgets. */
  widgetHost: HTMLElement | null;
  setWidgetHost: (host: HTMLElement | null) => void;
  /** Status-bar slot hosting the active editor's navigation bar (breadcrumbs). */
  navigationHost: HTMLElement | null;
  setNavigationHost: (host: HTMLElement | null) => void;
  /** Editor group currently portalling its breadcrumbs into `navigationHost`. */
  navigationPortalOwner: string | null;
  setNavigationPortalOwner: (owner: string | null, previous?: string | null) => void;
  status: CodeWorkspaceStatusSegments | null;
  actions: CodeWorkspaceStatusActions | null;
  setStatus: (status: CodeWorkspaceStatusSegments | null) => void;
  setActions: (tabId: string, actions: CodeWorkspaceStatusActions | null) => void;
  clearForTab: (tabId: string) => void;
}

function navigationEqual(
  left: readonly CodeWorkspaceNavigationSegment[] | undefined,
  right: readonly CodeWorkspaceNavigationSegment[] | undefined,
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length
    && a.every((segment, index) => segment.label === b[index]?.label && segment.kind === b[index]?.kind);
}

function segmentsEqual(
  left: CodeWorkspaceStatusSegments | null,
  right: CodeWorkspaceStatusSegments | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.tabId === right.tabId
    && left.line === right.line
    && left.column === right.column
    && left.encoding === right.encoding
    && left.eol === right.eol
    && left.indentation === right.indentation
    && left.languageId === right.languageId
    && left.lspActive === right.lspActive
    && left.lspLabel === right.lspLabel
    && left.lspError === right.lspError
    && left.gitBranch === right.gitBranch
    && left.gitAhead === right.gitAhead
    && left.gitBehind === right.gitBehind
    && left.fontSize === right.fontSize
    && left.largeFile === right.largeFile
    && (left.selectionChars ?? 0) === (right.selectionChars ?? 0)
    && (left.selectionLineBreaks ?? 0) === (right.selectionLineBreaks ?? 0)
    && !!left.readOnly === !!right.readOnly
    && navigationEqual(left.navigation, right.navigation)
    && left.lspProgress?.key === right.lspProgress?.key
    && left.lspProgress?.label === right.lspProgress?.label
    && left.lspProgress?.message === right.lspProgress?.message
    && left.lspProgress?.percentage === right.lspProgress?.percentage
    && left.lspProgress?.cancellable === right.lspProgress?.cancellable;
}

export function detectWorkspaceEol(text: string): WorkspaceEol {
  if (text.includes("\r\n")) return "CRLF";
  if (text.includes("\r")) return "CR";
  return "LF";
}

export function detectIndentation(text: string): { type: "spaces" | "tabs"; size: number; label: string } {
  let tabCount = 0;
  let space2Count = 0;
  let space4Count = 0;

  for (const line of text.split("\n").slice(0, 300)) {
    if (!line || /^\s*$/.test(line)) continue;
    if (line.startsWith("\t")) {
      tabCount += 1;
    } else {
      const match = line.match(/^ +/);
      if (match) {
        const len = match[0].length;
        if (len % 4 === 0) space4Count += 1;
        else if (len % 2 === 0) space2Count += 1;
      }
    }
  }

  if (tabCount > space2Count && tabCount > space4Count) {
    return { type: "tabs", size: 4, label: "Tab: 4" };
  }
  if (space4Count > space2Count) {
    return { type: "spaces", size: 4, label: "Spaces: 4" };
  }
  return { type: "spaces", size: 2, label: "Spaces: 2" };
}

export const useCodeWorkspaceStatusStore = create<CodeWorkspaceStatusStoreState>((set, get) => ({
  status: null,
  actions: null,
  widgetHost: null,
  setWidgetHost: (widgetHost) => {
    if (get().widgetHost !== widgetHost) set({ widgetHost });
  },
  navigationHost: null,
  setNavigationHost: (navigationHost) => {
    if (get().navigationHost !== navigationHost) set({ navigationHost });
  },
  navigationPortalOwner: null,
  setNavigationPortalOwner: (owner, previous) => {
    const current = get().navigationPortalOwner;
    // Clearing only releases the slot for the owner that still holds it.
    if (owner === null && previous !== undefined && current !== previous) return;
    if (current !== owner) set({ navigationPortalOwner: owner });
  },

  setStatus: (status) => {
    if (segmentsEqual(get().status, status)) return;
    set({ status });
  },

  setActions: (tabId, actions) => {
    const current = get().status;
    if (current && current.tabId !== tabId && actions) return;
    set({ actions });
  },

  clearForTab: (tabId) => {
    const current = get().status;
    if (current?.tabId === tabId) {
      set({ status: null, actions: null });
      return;
    }
    // Actions may outlive status briefly while switching files inside the same tab.
    if (!current) set({ actions: null });
  },
}));
