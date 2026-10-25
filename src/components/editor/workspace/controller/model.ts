import { type WorkspaceFile, type WorkspaceGitRoot } from "../../../../lib/editor/workspace";
import { type LspDiagnostic, type LspDocumentStatus, type LspDocumentSymbol, type LspLocation, type LspPosition, type LspRange, type LspExternalFileChange } from "../../../../lib/editor/lsp";
import { type EditorGroupId, type EditorSplitOrientation } from "../../../../stores/codeWorkspaceStore";
import { WORKSPACE_BOTTOM_DOCK_WINDOWS } from "../toolWindowRegistry";
import { type LayoutNode } from "../recursiveLayoutTree";
import { type EditorSelectionRange } from "../CodeMirrorHost";
import { EditorView } from "@codemirror/view";
import { type InlineRenameAnchor } from "../InlineRenamePopup";
import { type RunGutterTarget } from "../runGutter";
import { type ResourceCleanupOutcome } from "../workspaceResourceRecoveryCoordinator";
import { type ToolWindowLayoutEntry } from "../useToolWindowLayout";
import { compareDocumentDescriptor, compareTextByteLength, normalizeCompareText, type CompareDocumentDescriptor, type CompareSelection, type CompareSource, type CompareTarget } from "../editorCompareModel";
import { type WorkspaceCommandRegistration } from "../workspaceCommands";
import type { CodeWorkspaceFileRef, CodeWorkspaceRootInfo, CodeWorkspaceTabInfo } from "../../../../types";
import { type OpenFileState, fsPathEquals, normalizeEditorText, normalizeFsPath } from "../codeWorkspaceModel";
import { type BreadcrumbPathSegment } from "../Breadcrumbs";
import { type DebugStackFrame } from "../dapDebugModel";
import { type ExtractReceipt, type ExtractSession } from "../extractMethodFlow";



export interface CodeWorkspaceTabProps {
  tabId: string;
  workspace: CodeWorkspaceTabInfo;
  visible?: boolean;
  onOpenGitManager?: (payload: CodeWorkspaceGitManagerPayload) => void;
  onSyncGitManager?: (payload: CodeWorkspaceGitManagerPayload) => void;
  onCommandsChange?: (tabId: string, registration: WorkspaceCommandRegistration | null) => void;
  hostIntegration?: import("../workspaceHostIntegration").WorkspaceHostIntegration;
}



export interface CodeWorkspaceGitManagerPayload {
    workspaceName: string;
    workspaceInstanceId?: string;
    workspaceId?: string;
    roots: WorkspaceGitRoot[];
    activeRepoRoot: string | null;
}



export type LspLocationOpenOptions = {
  groupId?: EditorGroupId;
  preview?: boolean;
  isCurrent?: () => boolean;
  /** Provider document that owns a virtual/library URI result. */
  originFile?: OpenFileState;
  /** Keep a semantic jump's history transaction until reveal succeeds. */
  recordHistory?: boolean;
  onRevealed?: (ref: CodeWorkspaceFileRef, position: LspPosition) => void;
};



export const TREE_DETAILS_STORAGE_KEY = "taomni.codeWorkspace.tree.details";



export function semanticLocationsFromResult(result: {
  status: LspDocumentStatus;
  locations: LspLocation[];
}): LspLocation[] | null {
  if (result.status.error) throw new Error(result.status.error);
  if (!result.status.available || !result.status.active) return null;
  return result.locations;
}



export function breadcrumbSegmentsForFile(
  file: OpenFileState,
  roots: CodeWorkspaceRootInfo[],
): BreadcrumbPathSegment[] {
  // Library sources have no directory trail — show where the class came from.
  if (file.library) {
    const trail: BreadcrumbPathSegment[] = [];
    if (file.library.container) {
      trail.push({ label: file.library.container, path: "", kind: "root" });
    }
    trail.push({ label: file.title, path: file.path, kind: "file" });
    return trail;
  }
  if (file.ref.kind === "root") {
    const rootId = file.ref.rootId;
    const root = roots.find((candidate) => candidate.id === rootId);
    if (!root) return [{ label: file.title, path: file.ref.path, kind: "file" }];
    const parts = file.ref.path.split("/").filter(Boolean);
    let path = "";
    return [
      { label: root.name, path: "", kind: "root" },
      ...parts.map((part, index): BreadcrumbPathSegment => {
        path = path ? `${path}/${part}` : part;
        return { label: part, path, kind: index === parts.length - 1 ? "file" : "directory" };
      }),
    ];
  }
  const normalized = normalizeFsPath(file.ref.path);
  const parts = normalized.split("/").filter(Boolean);
  let path = normalized.startsWith("/") ? "/" : "";
  return parts.map((part, index): BreadcrumbPathSegment => {
    path = path === "/" ? `/${part}` : path ? `${path}/${part}` : part;
    return { label: part, path, kind: index === parts.length - 1 ? "file" : "directory" };
  });
}



export function initialInlayHintRange(text: string): LspRange {
  const lines = text.split("\n");
  const endLine = Math.min(Math.max(lines.length - 1, 0), 199);
  return {
    start: { line: 0, character: 0 },
    end: { line: endLine, character: lines[endLine]?.length ?? 0 },
  };
}



/** Maven / Gradle build descriptors that warrant a jdtls project reload on save. */
export function isJavaBuildFile(languagePath: string): boolean {
  const name = languagePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return name === "pom.xml"
    || name === "build.gradle"
    || name === "build.gradle.kts"
    || name === "settings.gradle"
    || name === "settings.gradle.kts";
}



export function encodingSupportsBom(encoding: string): boolean {
  const normalized = encoding.trim().toLowerCase().replace(/_/g, "-");
  return normalized === "utf-8" || normalized === "utf-16le" || normalized === "utf-16be";
}



export function compareSelectionFromEditorSelection(
  selection: EditorSelectionRange,
): CompareSelection | undefined {
  if (selection.empty || (
    selection.start.line === selection.end.line
    && selection.start.character === selection.end.character
  )) return undefined;
  return {
    start: { ...selection.start },
    end: { ...selection.end },
    text: normalizeCompareText(selection.text),
  };
}



export function compareDescriptorForOpenFile(
  file: OpenFileState,
  source: CompareSource,
  path: string,
  text = file.text,
  title = file.title,
): CompareDocumentDescriptor {
  return compareDocumentDescriptor({
    title,
    path,
    text,
    encoding: file.encoding ?? "UTF-8",
    eol: file.eol,
    bom: file.bom ?? false,
    sizeBytes: text === file.text && !file.dirty ? file.size : compareTextByteLength(text),
    source,
    readOnly: false,
  });
}



export function compareTargetForOpenFile(
  file: OpenFileState,
  selection?: CompareSelection,
): CompareTarget {
  return {
    fileKey: file.key,
    documentRevision: file.documentRevision ?? 0,
    expectedText: file.text,
    selection,
  };
}



export function comparePositionOffset(text: string, position: { line: number; character: number }): number {
  const lines = text.split("\n");
  const line = Math.min(Math.max(0, position.line), Math.max(0, lines.length - 1));
  let offset = 0;
  for (let index = 0; index < line; index += 1) {
    offset += (lines[index]?.length ?? 0) + 1;
  }
  return offset + Math.min(Math.max(0, position.character), lines[line]?.length ?? 0);
}



export function replaceCompareSelection(
  text: string,
  selection: CompareSelection,
  replacement: string,
): string | null {
  const from = comparePositionOffset(text, selection.start);
  const to = comparePositionOffset(text, selection.end);
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  if (text.slice(start, end) !== selection.text) return null;
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}



export function compareTargetMatches(file: OpenFileState | null, target: CompareTarget): boolean {
  return !!file
    && file.key === target.fileKey
    && (file.documentRevision ?? 0) === target.documentRevision
    && file.text === target.expectedText;
}



export interface ExternalDiskSnapshot {
  text: string;
  eol: OpenFileState["eol"];
  encoding: string;
  bom: boolean;
  hash: string;
  mtime: number;
  size: number;
}



export interface PendingExternalFileConflict {
  key: string;
  path: string;
  baseText: string;
  localText: string;
  disk: ExternalDiskSnapshot | null;
}



export interface PendingExternalFileEvent {
  change: LspExternalFileChange;
  timer: number;
}



export interface WorkspaceEditTabSnapshot {
  activeGroupId: EditorGroupId;
  splitOrientation: EditorSplitOrientation | null;
  layoutTreeV2: LayoutNode;
  files: Array<{
    path: string;
    ref: CodeWorkspaceFileRef;
    groups: Array<{
      id: EditorGroupId;
      active: boolean;
      preview: boolean;
      pinned: boolean;
    }>;
  }>;
}



export const EXTERNAL_FILE_EVENT_SETTLE_MS = 140;


export const WORKSPACE_BOOKMARK_MNEMONICS = [..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"];



export function coalesceExternalFileChange(
  previous: LspExternalFileChange,
  next: LspExternalFileChange,
): LspExternalFileChange {
  // Atomic replacement commonly arrives as Remove followed by Create for the
  // same path. The editor should treat that sequence as one content change.
  if (previous.type === 3 && next.type === 1) {
    return { ...next, type: 2 };
  }
  return next;
}



export function externalDiskSnapshot(file: WorkspaceFile): ExternalDiskSnapshot {
  const normalized = normalizeEditorText(file.text);
  return {
    text: normalized.text,
    eol: normalized.eol,
    encoding: file.encoding ?? "UTF-8",
    bom: file.bom ?? file.text.startsWith("\uFEFF"),
    hash: file.hash,
    mtime: file.mtime,
    size: file.size,
  };
}




// Keep document synchronization ahead of the comparatively expensive derived
// LSP features.  In particular, rust-analyzer semantic tokens can be large
// enough that applying them while somebody is still typing is noticeable.
// Background typing coalesces didChange at this interval; completion/signature
// force-flush immediately so the server is not one keystroke behind.
// Slightly longer than a single keystroke so jdtls is not flooded while still
// feeling immediate once ensureLspDocumentSynced force-flushes for completion.
/**
 * ED-PARITY-024 tool windows and their IDEA new-UI default anchors: Project
 * (left top) with Structure split below it (left bottom), Documentation on
 * the right, and the bottom tool windows bottom-left.
 */
/** IDEA registers these on demand: the stripe button appears once opened. */
export const ON_DEMAND_TOOL_WINDOWS = new Set(["references", "call-hierarchy", "type-hierarchy", "coverage"]);


export const WORKSPACE_TOOL_WINDOW_LAYOUT_ENTRIES: readonly ToolWindowLayoutEntry[] = [
  { id: "project", defaultAnchor: "left-top" },
  { id: "structure", defaultAnchor: "left-bottom" },
  { id: "documentation", defaultAnchor: "right-top" },
  ...[...WORKSPACE_BOTTOM_DOCK_WINDOWS.map((window) => window.id), "git"].map((id) => ({
    id,
    defaultAnchor: "bottom-left" as const,
    bottomDock: true,
    hiddenUntilUsed: ON_DEMAND_TOOL_WINDOWS.has(id),
  })),
];



export const LSP_CHANGE_SYNC_DELAY_MS = 140;


export const LSP_FEATURE_SYNC_WAIT_MS = 400;


export const LSP_HIGHLIGHT_IDLE_DELAY_MS = 500;


export const LSP_INLAY_HINT_IDLE_DELAY_MS = 650;


export const LSP_SEMANTIC_TOKENS_IDLE_DELAY_MS = 900;


export const LSP_DOCUMENT_SYMBOLS_IDLE_DELAY_MS = 650;


// CodeMirror owns the live text while the user is typing. Publishing every
// keypress into the workspace-wide Zustand object redraws the file tree,
// panels, and command chrome, so commit an editing burst as one update.
export const EDITOR_TEXT_COMMIT_IDLE_DELAY_MS = 220;


// Shared empty result so "no diagnostics" is always the same array identity.
export const EMPTY_DISPLAY_DIAGNOSTICS: LspDiagnostic[] = [];



export const DECLARATION_DEFINITION_EQUIVALENT_LANGUAGES = new Set([
  "java",
  "kotlin",
  "scala",
  "groovy",
  "python",
  "rust",
  "go",
  "typescript",
  "javascript",
  "typescriptreact",
  "javascriptreact",
  "php",
  "ruby",
  "swift",
  "dart",
  "lua",
]);



export const DECLARATION_DEFINITION_EQUIVALENT_EXTENSIONS = new Set([
  "java",
  "kt",
  "kts",
  "scala",
  "sc",
  "groovy",
  "gvy",
  "gy",
  "gsh",
  "py",
  "pyw",
  "rs",
  "go",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "php",
  "rb",
  "swift",
  "dart",
  "lua",
]);



/**
 * Languages where declarations and definitions are physically identical
 * (no separate C-style header/implementation files). For these languages,
 * IDEA's Ctrl+B ("Go to Declaration or Usages") maps directly to definition
 * navigation so symbols resolve through standard definition providers.
 */
export function isDeclarationDefinitionEquivalentLanguage(
  languageId?: string | null,
  filePath?: string | null,
): boolean {
  if (languageId && DECLARATION_DEFINITION_EQUIVALENT_LANGUAGES.has(languageId.toLowerCase())) {
    return true;
  }
  if (filePath) {
    const ext = filePath.split(".").pop()?.toLowerCase();
    if (ext && DECLARATION_DEFINITION_EQUIVALENT_EXTENSIONS.has(ext)) {
      return true;
    }
  }
  return false;
}



export function extractContextSnippet(
  text: string,
  targetLine: number,
  targetOffset?: number,
): { lineText: string; contextSnippet: string } {
  if (targetOffset !== undefined) {
    const offset = Math.max(0, Math.min(targetOffset, text.length));
    const targetLineStart = offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
    const targetLineBreak = text.indexOf("\n", offset);
    const targetLineEnd = targetLineBreak === -1 ? text.length : targetLineBreak;
    const contextStart = targetLine <= 0
      ? targetLineStart
      : targetLineStart > 1
        ? text.lastIndexOf("\n", targetLineStart - 2) + 1
        : 0;
    const nextLineBreak = targetLineBreak === -1
      ? -1
      : text.indexOf("\n", targetLineBreak + 1);
    const contextEnd = nextLineBreak === -1 ? text.length : nextLineBreak;
    return {
      lineText: text.slice(targetLineStart, targetLineEnd),
      contextSnippet: text.slice(contextStart, contextEnd),
    };
  }

  const desiredStart = Math.max(0, targetLine - 1);
  const desiredEnd = targetLine + 1;
  let currentLine = 0;
  let lineStart = 0;
  let targetLineStart = 0;
  let targetLineEnd = text.length;
  let startLineOffset = 0;
  let endLineOffset = text.length;

  let pos = 0;
  while (pos <= text.length) {
    const nextNewline = text.indexOf("\n", pos);
    const lineEnd = nextNewline === -1 ? text.length : nextNewline;
    if (currentLine === desiredStart) startLineOffset = lineStart;
    if (currentLine === targetLine) {
      targetLineStart = lineStart;
      targetLineEnd = lineEnd;
    }
    if (currentLine === desiredEnd) {
      endLineOffset = lineEnd;
      break;
    }
    if (nextNewline === -1) {
      if (currentLine < desiredEnd) endLineOffset = text.length;
      break;
    }
    currentLine++;
    lineStart = nextNewline + 1;
    pos = lineStart;
  }

  return {
    lineText: text.slice(targetLineStart, targetLineEnd),
    contextSnippet: text.slice(startLineOffset, endLineOffset),
  };
}



export interface ResourceCleanupRecoveryView {
  readonly recoveryId: string;
  readonly fileKey: string;
  readonly nextStage: string;
  readonly error: string;
  readonly completedStageCount: number;
  readonly attemptCount: number;
}



export interface TabPolicyLifecycleReceiptView {
  readonly status: "applied" | "no-op" | "aborted" | "stale";
  readonly layoutRevision: number;
  readonly activeKey: string | null;
  readonly evictedCount: number;
  readonly cleanupCount: number;
  readonly cleanupCommittedCount: number;
  readonly cleanupRecoveryCount: number;
  readonly openResourceCount: number;
}



/** Resolve the execution line for one visible editor group. */
export function debugCurrentLineForFile(
  location: { path: string; line: number } | null,
  frames: readonly Pick<DebugStackFrame, "id" | "path" | "line" | "sourceName">[],
  selectedFrameId: number | null | undefined,
  activeFilePath: string | null,
  stopped: boolean,
): number | null {
  if (!activeFilePath) return null;
  if (location && fsPathEquals(location.path, activeFilePath)) return location.line;
  if (!stopped) return null;
  const frame = frames.find((candidate) => candidate.id === selectedFrameId) ?? frames[0];
  if (!frame || frame.line < 1) return null;
  const sourceName = frame.sourceName ?? frame.path?.split(/[\\/]/).pop() ?? null;
  const fileName = activeFilePath.split(/[\\/]/).pop() ?? null;
  return sourceName && fileName && sourceName === fileName ? frame.line : null;
}



export interface PendingClosedFile {
  cleanup: Promise<ResourceCleanupOutcome> | null;
  didCloseCompleted: boolean;
}



/**
 * Typed Reformat Document outcome. Provider unavailability is a value, never
 * a silent null: the action layer turns each reason into a status message and
 * keeps the buffer untouched (AC-FMT-03/04).
 */
export type FormatFileOutcome =
  | { state: "formatted"; text: string }
  | { state: "unchanged"; text: string }
  | { state: "unavailable"; reason: string };



/**
 * ED-PARITY-007 DEC-07: typed Rename outcome. Extract Method uses it to keep
 * the committed extraction when the naming step fails, instead of pretending
 * the whole transaction was cancelled.
 */
export type RenameSymbolAtResult = {
  status: "applied" | "unchanged" | "empty-edit" | "cancelled" | "stale" | "failed";
  message?: string;
  recoveryId?: string;
  /** The provider refused the name before any write; the caller may retry. */
  retryable?: boolean;
};



export const EMPTY_RUN_GUTTER: RunGutterTarget[] = [];



/** ED-PARITY-017: outcome of one in-place naming session. */
export type InlineNameResult =
  | { kind: "commit"; name: string }
  | { kind: "cancel" }
  | { kind: "dialog"; value: string };



export interface InlineRenameRequest {
  id: number;
  kind: "rename" | "extract";
  fileKey: string;
  view: EditorView;
  anchor: InlineRenameAnchor;
  initialValue: string;
  suggestions: string[];
  initialError: string | null;
  languageId: string | null;
  resolve: (result: InlineNameResult) => void;
}



/**
 * ED-PARITY-007 DEC-07: shell-side extension of the pure Extract session. The
 * before-symbols sample belongs to the frozen pre-commit context, the receipt
 * is attached at the canonical commit boundary, and the abort controller only
 * records that this owner stopped listening.
 */
export type ExtractSessionState = ExtractSession & {
  beforeSymbols: LspDocumentSymbol[] | null;
  receipt?: ExtractReceipt;
  abortController: AbortController;
};



export interface ExtractNamingPromptState {
  sessionId: string;
  title: string;
  label: string;
  confirmLabel: string;
  initialValue: string;
  resolve: (value: string | null) => void;
}



/** ED-PARITY-014 DEC-014-03: tool windows listed beside Recent Files (IDEA switcher). */
export const RECENT_FILES_TOOL_WINDOWS = [
  { id: "project", label: "Project", shortcut: "Alt+1" },
  { id: "problems", label: "Problems", shortcut: "Alt+6" },
  { id: "structure", label: "Structure", shortcut: "Alt+7" },
  { id: "terminal", label: "Terminal", shortcut: "Alt+F12" },
  { id: "search", label: "Find" },
  { id: "run", label: "Run" },
  { id: "debug", label: "Debug" },
  { id: "todos", label: "TODO" },
] as const;
