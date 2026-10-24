/**
 * Transient view state of the Workspaces editor surface (v6.1 TASK-05/06).
 *
 * Kept outside the platform store because it is derived, never persisted:
 * the open document mirrors that live editor text, its dirty flag and (for the
 * Structure lens) a cheap symbol outline.
 */
import { create } from "zustand";

export interface WorkspaceDocumentState {
  tabId: string;
  path: string;
  language: string;
  text: string;
  dirty: boolean;
  savedText: string;
  loading: boolean;
  error: string | null;
}

export interface WorkspaceOutlineSymbol {
  label: string;
  kind: "class" | "function" | "interface" | "variable" | "method" | "heading";
  line: number;
}

export interface WorkspaceEditorState {
  documents: Record<string, WorkspaceDocumentState>;
  activeTabId: string | null;
  setDocument: (tabId: string, patch: Partial<WorkspaceDocumentState> & { path?: string }) => void;
  removeDocument: (tabId: string) => void;
  setActiveTab: (tabId: string | null) => void;
}

export const EMPTY_DOCUMENT: WorkspaceDocumentState = {
  tabId: "",
  path: "",
  language: "plaintext",
  text: "",
  dirty: false,
  savedText: "",
  loading: false,
  error: null,
};

export const useWorkspaceEditorStore = create<WorkspaceEditorState>((set) => ({
  documents: {},
  activeTabId: null,

  setDocument: (tabId, patch) => set((state) => {
    const current = state.documents[tabId] ?? { ...EMPTY_DOCUMENT, tabId };
    return { documents: { ...state.documents, [tabId]: { ...current, ...patch, tabId } } };
  }),

  removeDocument: (tabId) => set((state) => {
    if (!state.documents[tabId]) return state;
    const documents = { ...state.documents };
    delete documents[tabId];
    return { documents, activeTabId: state.activeTabId === tabId ? null : state.activeTabId };
  }),

  setActiveTab: (tabId) => set({ activeTabId: tabId }),
}));

export function languageFromPath(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "md":
      return "markdown";
    case "rs":
      return "rust";
    case "py":
      return "python";
    case "go":
      return "go";
    case "java":
      return "java";
    case "css":
      return "css";
    case "html":
      return "html";
    case "yml":
    case "yaml":
      return "yaml";
    case "sql":
      return "sql";
    case "xml":
      return "xml";
    case "php":
      return "php";
    case "c":
    case "h":
    case "cpp":
    case "hpp":
      return "cpp";
    default:
      return "plaintext";
  }
}

const OUTLINE_PATTERNS: Array<{ kind: WorkspaceOutlineSymbol["kind"]; pattern: RegExp }> = [
  { kind: "class", pattern: /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: "interface", pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: "function", pattern: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
  { kind: "function", pattern: /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/ },
  { kind: "variable", pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/ },
  { kind: "heading", pattern: /^\s*(#{1,6})\s+(.+)$/ },
];

export function outlineSymbols(text: string, limit = 200): WorkspaceOutlineSymbol[] {
  const symbols: WorkspaceOutlineSymbol[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length && symbols.length < limit; index += 1) {
    const line = lines[index];
    for (const { kind, pattern } of OUTLINE_PATTERNS) {
      const match = pattern.exec(line);
      if (!match) continue;
      const label = kind === "heading" ? match[2] : match[1];
      if (!label) continue;
      symbols.push({ label, kind, line: index + 1 });
      break;
    }
  }
  return symbols;
}
