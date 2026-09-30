/**
 * ED-PARITY-007 browser fixture: a controlled Java provider for the isolated
 * `/preview/parity007` root.
 *
 * It only answers the five LSP commands an Extract Method transaction uses and
 * derives every symbol/edit from the REAL document text in the browser VFS, so
 * the production candidate filter, intention session, workspace edit, history
 * and rename chain all run unchanged. It cannot prove JDT LS semantics, host
 * disk bytes or WebView behaviour — `TC-IDE-PARITY-007-03` owns those.
 */
import type {
  LspCodeAction,
  LspCodeActionResolveResult,
  LspCodeActionsResult,
  LspDocumentStatus,
  LspDocumentSymbol,
  LspDocumentSymbolsResult,
  LspPosition,
  LspPrepareRenameResult,
  LspRange,
  LspRenameResult,
  LspWorkspaceEdit,
} from "../lib/editor/lsp";
import { vfsReadText } from "./localVfs";

export const parity007Root = "/preview/parity007";

const enabledKey = "taomni.qa.parity007.enabled";
const modeKey = "taomni.qa.parity007.mode";

export const PARITY007_EXTRACT_MODE_NAMES = [
  "normal",
  "multi-candidate",
  "none",
  "empty-supported",
  "disabled",
  "command-only",
  "malformed",
  "timeout",
  "changed",
  "error",
  "resolve-error",
  "symbols-error",
  "symbols-ambiguous",
  "rename-error",
  "multi-file",
  "write-failure",
] as const;

type Parity007Mode = (typeof PARITY007_EXTRACT_MODE_NAMES)[number];

/** DEC-03: the provider default name, fixed by this controlled fixture. */
export const PARITY007_DEFAULT_NAME = "extracted";
export const PARITY007_RENAME_NAME = "sumOf";
export const PARITY007_BOUNDARY_SELECTION = "Extract Method is not available for this selection";

export function parity007Enabled(path?: string): boolean {
  try {
    return localStorage.getItem(enabledKey) === "true"
      && (path === undefined || path.startsWith(`${parity007Root}/`));
  } catch {
    return false;
  }
}

export function parity007Mode(): Parity007Mode {
  try {
    const raw = JSON.parse(localStorage.getItem(modeKey) ?? '"normal"') as string;
    return (PARITY007_EXTRACT_MODE_NAMES as readonly string[]).includes(raw)
      ? (raw as Parity007Mode)
      : "normal";
  } catch {
    return "normal";
  }
}

export function parity007DocumentPath(args?: {
  rootPath?: string | null;
  filePath?: string;
}): string {
  const filePath = String(args?.filePath ?? "");
  return args?.rootPath === parity007Root
    ? `${parity007Root}/${filePath.replace(/^\/+/, "")}`
    : filePath;
}

export function parity007Status(path: string): LspDocumentStatus {
  return {
    path,
    uri: `file://${path}`,
    presetId: "java",
    languageId: "java",
    displayName: "Java (B-007 fixture)",
    available: true,
    active: true,
    semanticReady: true,
    selectedCommandId: "parity007-controlled",
    selectedCommand: null,
    installHint: null,
    error: null,
    capabilities: {
      completion: false,
      signatureHelp: false,
      hover: false,
      definition: false,
      typeDefinition: false,
      implementation: false,
      references: false,
      documentSymbol: true,
      workspaceSymbol: false,
      rename: true,
      formatting: false,
      rangeFormatting: false,
      codeAction: true,
      documentHighlight: false,
      callHierarchy: false,
      typeHierarchy: false,
      inlayHint: false,
      selectionRange: false,
      semanticTokens: false,
      completionTriggerCharacters: [],
      signatureTriggerCharacters: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Read-only observation + controlled timing
// ---------------------------------------------------------------------------

type Phase = "request" | "resolve" | "symbols-before" | "symbols-after" | "prepare-rename" | "rename";

const PHASES: readonly Phase[] = [
  "request",
  "resolve",
  "symbols-before",
  "symbols-after",
  "prepare-rename",
  "rename",
];

type Pending = { phase: Phase; release: () => void };

const pending: Pending[] = [];
const holdOnce = new Set<Phase>();
const events: Array<{ phase: Phase; mode: string; detail: string }> = [];

function record(phase: Phase, detail: string): void {
  events.push({ phase, mode: parity007Mode(), detail });
}

async function held<T>(phase: Phase, result: () => T | PromiseLike<T>): Promise<T> {
  if (!holdOnce.has(phase)) return result();
  holdOnce.delete(phase);
  record(phase, "held");
  return new Promise<T>((resolve) => {
    pending.push({ phase, release: () => resolve(result()) });
  });
}

declare global {
  interface Window {
    __taomniQaParity007?: {
      observe: () => {
        mode: string;
        events: Array<{ phase: Phase; mode: string; detail: string }>;
        pending: Phase[];
        lastRange: LspRange;
      };
      setMode: (value: string) => void;
      hold: (phase: string) => boolean;
      release: (phase: string) => number;
    };
  }
}

if (typeof window !== "undefined") {
  window.__taomniQaParity007 = {
    observe: () => ({
      mode: parity007Mode(),
      events: [...events],
      pending: pending.map((entry) => entry.phase),
      // Read-only: the exact LSP range the production passed to codeAction.
      lastRange: lastSelectionRange,
    }),
    setMode: (value: string) => {
      localStorage.setItem(modeKey, JSON.stringify(value));
    },
    hold: (phase: string) => {
      if (!(PHASES as readonly string[]).includes(phase)) return false;
      holdOnce.add(phase as Phase);
      return true;
    },
    release: (phase: string) => {
      const entries = pending.filter((entry) => entry.phase === phase);
      for (const entry of entries) {
        pending.splice(pending.indexOf(entry), 1);
        entry.release();
      }
      return entries.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Real-document helpers
// ---------------------------------------------------------------------------

/**
 * Provider-side document buffers. The workspace keeps dirty text in memory and
 * only writes the VFS on save, so a provider that read the VFS directly would
 * answer every request with the last saved revision — the dirty-buffer and
 * symbols-after scenarios would silently test nothing. `lsp_open_document`,
 * `lsp_change_document`, `lsp_save_document` and `lsp_close_document` are
 * dispatched here so the controlled provider follows the real document
 * lifecycle.
 */
const documentBuffers = new Map<string, string>();

export function parity007OpenDocument(path: string, text: string | null | undefined): void {
  if (typeof text === "string") documentBuffers.set(path, text);
}

export function parity007ChangeDocument(path: string, text: string | null | undefined): void {
  if (typeof text === "string") documentBuffers.set(path, text);
}

export function parity007SaveDocument(path: string, text: string | null | undefined): void {
  if (typeof text === "string") documentBuffers.set(path, text);
}

export function parity007CloseDocument(path: string): void {
  documentBuffers.delete(path);
}

export function parity007DocumentBuffer(path: string): string | null {
  return documentBuffers.get(path) ?? null;
}

/** Live provider text: the open buffer when present, otherwise the saved file. */
async function readDocumentText(path: string): Promise<string> {
  const buffered = documentBuffers.get(path);
  if (buffered !== undefined) return buffered;
  try {
    return await vfsReadText(path);
  } catch {
    return "";
  }
}

function lineRange(text: string, line: number, start: number, end: number): LspRange {
  const lineText = text.split("\n")[line] ?? "";
  return {
    start: { line, character: Math.min(start, lineText.length) },
    end: { line, character: Math.min(end, lineText.length) },
  };
}

/**
 * Java keywords that can precede a parenthesis but are never a method name.
 * Without this guard the same regex also matches "for (int v : values) {",
 * which reports control flow as methods and poisons any outline diff.
 */
const NON_METHOD_KEYWORDS = new Set([
  "for", "if", "else", "while", "switch", "case", "catch", "finally", "do",
  "try", "return", "new", "throw", "assert", "synchronized", "super", "this",
]);

/** Minimal Java outline over the real bytes: the class plus its methods. */
function symbolsFromText(text: string): LspDocumentSymbol[] {
  const symbols: LspDocumentSymbol[] = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const classMatch = /^\s*(?:public\s+|final\s+)*(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (classMatch) {
      const name = classMatch[1]!;
      const column = line.indexOf(name);
      symbols.push({
        name,
        detail: null,
        kind: 5,
        depth: 0,
        range: lineRange(text, index, 0, line.length),
        selectionRange: lineRange(text, index, column, column + name.length),
      });
      return;
    }
    const methodMatch = /^\s{2,}(?:(?:public|private|protected|static|final|synchronized|abstract|native)\s+)*([\w$<>\[\],.\s]+?)\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/.exec(line);
    if (!methodMatch) return;
    const name = methodMatch[2]!;
    if (NON_METHOD_KEYWORDS.has(name)) return;
    const column = line.indexOf(name);
    symbols.push({
      name,
      detail: null,
      kind: 6,
      depth: 1,
      range: lineRange(text, index, 0, line.length),
      selectionRange: lineRange(text, index, column, column + name.length),
    });
  });
  return symbols;
}

/** True when a line starts a Java method declaration (not control flow). */
function looksLikeMethodDeclaration(line: string): boolean {
  const match = /^\s{2,}(?:(?:public|private|protected|static|final|synchronized|abstract|native)\s+)*([\w$<>\[\],.\s]+?)\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/.exec(line);
  if (!match) return false;
  return !NON_METHOD_KEYWORDS.has(match[2]!);
}

function wordAt(text: string, position: LspPosition): { word: string; start: number; end: number } | null {
  const line = text.split("\n")[position.line] ?? "";
  const pattern = /[A-Za-z_$][\w$]*/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    if (match.index <= position.character && position.character <= match.index + match[0].length) {
      return { word: match[0], start: match.index, end: match.index + match[0].length };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Provider responses
// ---------------------------------------------------------------------------

function methodCandidate(title: string, disabledReason?: string): LspCodeAction {
  const raw: Record<string, unknown> = {
    title,
    kind: "refactor.extract.function",
    data: { parity007Kind: "extract-method", title },
  };
  if (disabledReason) raw.disabled = { reason: disabledReason };
  return {
    title,
    kind: "refactor.extract.function",
    isPreferred: !disabledReason,
    edit: null,
    command: null,
    commandArguments: null,
    raw,
  };
}

function variableCandidate(): LspCodeAction {
  return {
    title: "Extract to local variable",
    kind: "refactor.extract.variable",
    isPreferred: false,
    edit: null,
    command: null,
    commandArguments: null,
    raw: { title: "Extract to local variable", kind: "refactor.extract.variable", data: { parity007Kind: "extract-variable" } },
  };
}

let lastSelectionRange: LspRange = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
};

export async function parity007CodeActions(
  path: string,
  args: { startLine?: number; startCharacter?: number; endLine?: number; endCharacter?: number },
): Promise<LspCodeActionsResult> {
  const mode = parity007Mode();
  lastSelectionRange = {
    start: { line: args.startLine ?? 0, character: args.startCharacter ?? 0 },
    end: { line: args.endLine ?? 0, character: args.endCharacter ?? 0 },
  };
  record("request", mode);
  return held("request", () => {
    if (mode === "timeout") {
      throw new Error("language server request timed out: textDocument/codeAction");
    }
    if (mode === "changed") {
      throw new Error("language server request cancelled: document changed");
    }
    if (mode === "error") {
      throw new Error("B-007 controlled provider error");
    }
    if (mode === "malformed") {
      return { status: parity007Status(path), actions: [null, { kind: "quickfix" }] as unknown as LspCodeAction[] };
    }
    if (mode === "command-only") {
      return {
        status: parity007Status(path),
        actions: [{
          title: "Extract to method",
          kind: "refactor.extract.function",
          isPreferred: true,
          edit: null,
          command: "demo.parity007Extract",
          commandArguments: [],
          raw: { title: "Extract to method", kind: "refactor.extract.function", command: "demo.parity007Extract", arguments: [] },
        }],
      };
    }
    if (mode === "none") {
      return { status: parity007Status(path), actions: [variableCandidate()] };
    }
    if (mode === "disabled") {
      return {
        status: parity007Status(path),
        actions: [methodCandidate("Extract to method", "Nothing extractable in the current selection")],
      };
    }
    if (mode === "multi-candidate") {
      return {
        status: parity007Status(path),
        actions: [
          methodCandidate("Extract to method"),
          methodCandidate("Extract to method (inline)"),
          methodCandidate("Extract to method (unavailable)", "Selected block has multiple outputs"),
        ],
      };
    }
    return { status: parity007Status(path), actions: [methodCandidate("Extract to method"), variableCandidate()] };
  });
}

/**
 * The real provider expands an empty selection to the statement the caret sits
 * on. A fixture that anchors the edit on the zero-length caret instead inserts a
 * call in front of the statement and reports a broken extraction, so mirror the
 * provider behaviour: a caret inside a method body owns the whole statement line.
 */
function statementRangeFor(text: string, range: LspRange): LspRange {
  const caret = range.start.line === range.end.line && range.start.character === range.end.character;
  if (!caret) return range;
  const lineText = text.split("\n")[range.start.line] ?? "";
  if (!/^\s{8,}\S/.test(lineText)) return range;
  return {
    start: { line: range.start.line, character: 0 },
    end: { line: range.start.line + 1, character: 0 },
  };
}

async function extractEdit(path: string): Promise<LspWorkspaceEdit | null> {
  const text = await readDocumentText(path);
  if (!text) return null;
  const lines = text.split("\n");
  const statementRange = statementRangeFor(text, lastSelectionRange);
  const indent = (lines[statementRange.start.line] ?? "").match(/^\s*/)?.[0] ?? "";
  const methodLines = [
    `    private static int ${PARITY007_DEFAULT_NAME}(int[] values) {`,
    "        int sum = 0;",
    "        for (int v : values) {",
    "            sum += v;",
    "        }",
    "        return sum;",
    "    }",
    "",
  ];
  let insertLine = -1;
  for (let index = statementRange.end.line + 1; index < lines.length; index += 1) {
    if (looksLikeMethodDeclaration(lines[index] ?? "")) {
      insertLine = index;
      break;
    }
  }
  const documentEdits = [{
    uri: `file://${path}`,
    path,
    edits: [
      { range: statementRange, newText: `${indent}int sum = ${PARITY007_DEFAULT_NAME}(values);\n` },
      ...(insertLine >= 0
        ? [{
            range: { start: { line: insertLine, character: 0 }, end: { line: insertLine, character: 0 } },
            newText: `${methodLines.join("\n")}\n`,
          }]
        : []),
    ],
  }];
  return { documentEdits };
}

export async function parity007CodeActionResolve(
  path: string,
  action: LspCodeAction | null | undefined,
  helperPath: string,
): Promise<LspCodeActionResolveResult> {
  const mode = parity007Mode();
  record("resolve", mode);
  const resolved = await held("resolve", () => action ?? null);
  if (!resolved || parity007Mode() === "resolve-error") {
    return { status: parity007Status(path), action: null };
  }
  const edit = await extractEdit(path);
  if (!edit) {
    return { status: parity007Status(path), action: null };
  }
  const helperText = await readDocumentText(helperPath);
  const withHelper: LspWorkspaceEdit = mode === "multi-file" && helperText
    ? {
        documentEdits: [
          ...(edit.documentEdits ?? []),
          {
            uri: `file://${helperPath}`,
            path: helperPath,
            edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "// parity007 multi-file edit\n" }],
          },
        ],
      }
    : edit;
  return {
    status: parity007Status(path),
    action: {
      ...resolved,
      edit: withHelper,
      command: null,
      commandArguments: null,
    },
  };
}

export async function parity007DocumentSymbols(path: string): Promise<LspDocumentSymbolsResult> {
  const text = await readDocumentText(path);
  // Built by concatenation: an escaped template interpolation would leave the
  // literal "${PARITY007_DEFAULT_NAME}" in the pattern and never match.
  const postExtraction = new RegExp(
    "(?:" + PARITY007_DEFAULT_NAME + "|" + PARITY007_RENAME_NAME + ")\\(values\\)",
  ).test(text);
  const phase: Phase = postExtraction ? "symbols-after" : "symbols-before";
  const outline = symbolsFromText(text);
  // The trace records the served outline and the buffer identity so a lifecycle
  // failure can be attributed to the exact revision the provider answered with.
  record(
    phase,
    parity007Mode() + " · bytes=" + String(text.length) + " · " +
      outline.map((symbol) => symbol.name).join("/"),
  );
  return held(phase, () => {
    const mode = parity007Mode();
    if (mode === "symbols-error") {
      throw new Error("B-007 controlled documentSymbol failure");
    }
    const symbols = symbolsFromText(text);
    if (mode === "symbols-ambiguous" && postExtraction) {
      symbols.push({
        name: "extractedExtra",
        detail: null,
        kind: 6,
        depth: 1,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      });
    }
    return { status: parity007Status(path), symbols };
  });
}

export async function parity007PrepareRename(
  path: string,
  position: LspPosition,
): Promise<LspPrepareRenameResult> {
  record("prepare-rename", parity007Mode());
  return held("prepare-rename", async () => {
    const text = await readDocumentText(path);
    const found = wordAt(text, position);
    if (!found) {
      return {
        status: parity007Status(path),
        range: null,
        placeholder: null,
        allowed: false,
        message: "B-007 controlled provider cannot rename here",
      };
    }
    return {
      status: parity007Status(path),
      range: lineRange(text, position.line, found.start, found.end),
      placeholder: found.word,
      allowed: true,
      message: null,
    };
  });
}

export async function parity007Rename(
  path: string,
  position: LspPosition,
  newName: string,
): Promise<LspRenameResult> {
  record("rename", parity007Mode());
  return held("rename", async () => {
    if (parity007Mode() === "rename-error") {
      throw new Error("B-007 controlled rename failure: the provider rejected this rename");
    }
    const text = await readDocumentText(path);
    const found = wordAt(text, position);
    if (!found) {
      throw new Error("B-007 controlled rename failure: no renameable symbol at the position");
    }
    // A real provider rejects invalid identifiers and conflicts itself; the
    // workspace must never fake that with a text replacement.
    if (!/^[A-Za-z_$][\w$]*$/.test(newName)) {
      throw new Error(`B-007 controlled rename failure: '${newName}' is not a valid identifier`);
    }
    if (text.includes(`${newName}(`)) {
      throw new Error(`B-007 controlled rename failure: '${newName}' already exists in this scope`);
    }
    // ED-PARITY-017 DEC-017-06: one minimal edit per whole-word occurrence,
    // like a real provider, so the preview can show true preimage/postimage.
    const pattern = new RegExp(`(?<![\\w$])${found.word.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
    const edits: { range: LspRange; newText: string }[] = [];
    text.split("\n").forEach((lineText, line) => {
      for (const match of lineText.matchAll(pattern)) {
        const start = match.index ?? 0;
        edits.push({ range: lineRange(text, line, start, start + found.word.length), newText: newName });
      }
    });
    const documentEdits = [{ uri: `file://${path}`, path, edits }];
    // multi-file mode: a second real document change (required-edit preview).
    if (parity007Mode() === "multi-file") {
      const helperPath = `${parity007Root}/src/main/java/demo/ExtractHelper.java`;
      const helperText = await readDocumentText(helperPath);
      if (helperText) {
        documentEdits.push({
          uri: `file://${helperPath}`,
          path: helperPath,
          edits: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: `// renamed ${found.word} to ${newName}\n`,
          }],
        });
      }
    }
    return {
      status: parity007Status(path),
      edit: { documentEdits },
    };
  });
}

export function parity007WriteFailure(path: string): boolean {
  return parity007Mode() === "write-failure" && path.includes("/demo/");
}
