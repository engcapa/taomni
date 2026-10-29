import { type WorkspaceDocumentTransactionOwner } from "../workspaceDocumentTransactionOwner";
import { type QuickDocContent } from "../referenceDocumentation";
import type { EffectiveCodeStyle } from "../codeStyleModel";
import type { LspCompletionItem, LspCompletionResolveResult, LspCompletionResult, LspDiagnostic, LspDocumentHighlight, LspInlayHint, LspSemanticToken, LspPosition, LspRange } from "../../../../lib/editor/lsp";
import type { ParameterPopupView } from "../referenceInfoSession";
import { type WorkspaceClipboardHandle } from "../workspaceClipboardSession";
import { type ClipboardObservationRecord } from "../clipboardObservationContract";
import { LspCompletionController, type CompletionAcceptanceDiagnostic, type CompletionInvocationRequest, type CompletionRequestIdentity, type CompletionRequestToken } from "../lspCompletion";
import type { CompletionScopeFactsState } from "../completionScopeAdapter";
import { type RunGutterTarget } from "../runGutter";
import { type GitLineChange } from "../gitEditorChrome";
import { type DebugBreakpointMarker, type DebugGutterAnchor } from "../debugEditorChrome";
import { type EditorAppearanceExtensionProfile } from "../editorAppearanceExtension";
import type { FileCoverage } from "../coverageModel";
import type { DebugStepAction } from "../dapDebugModel";
import type { GitBlameLine } from "../../../../lib/git";
import { type RegionFoldingProvenance } from "../workspaceEditorCommands";
import { type PersistedEditorViewState } from "../workspaceLayoutPersistence";
import { type SemanticEditSource, type SurroundKind } from "../workspaceSemanticEditing";
import type { WorkspaceActionHost } from "../workspaceActionHost";


/** Breakpoint gutter actions beyond toggle/edit (IDEA mouse model). */
export interface BreakpointGutterActions {
  toggleEnabled?: (line: number) => void;
  add?: (line: number, kind: "temporary" | "logging", anchor?: DebugGutterAnchor) => void;
  openMenu?: (line: number, anchor: DebugGutterAnchor) => void;
}


export interface EditorRevealTarget {
  line: number;
  character: number;
  focus?: boolean;
  /** Optional selection end; without it the reveal only places the caret. */
  end?: { line: number; character: number };
}


/** ED-PARITY-012 DEC-012-06: one Go to Line:Column dialog request. */
export interface GoToLineRequest {
  current: { line: number; column: number };
  lineCount: number;
  apply: (target: { line: number; column: number }) => void;
  cancel: () => void;
}


export interface EditorSelectionRange {
  start: LspPosition;
  end: LspPosition;
  empty: boolean;
  text: string;
  /** Viewport-relative rect of the selection head; null when empty/unavailable. */
  rect: { top: number; left: number; right: number; bottom: number } | null;
  /**
   * ED-PARITY-011 DEC-011-07: true when the user made this selection by a
   * pointer drag or a Shift+navigation extend — not by Find, navigation,
   * double/triple click, Select All or a programmatic jump.
   */
  userSelected?: boolean;
}


export interface CodeMirrorHostProps {
  path: string;
  /** Stable buffer identity used by the workspace editor command owner. */
  fileKey?: string;
  /** Buffers still open in this pane; closed buffers must leave its state cache. */
  retainedFileKeys?: readonly string[];
  /** Editor view or group identifier (§8.26 / ED-MULTIVIEW-002). */
  viewId?: string;
  /** Shared document transaction owner (§8.26 / ED-MULTIVIEW-002). */
  transactionOwner?: WorkspaceDocumentTransactionOwner | null;
  /**
   * ED-AUDIT-008: claim a Ctrl+Z / Ctrl+Shift+Z stroke for the workspace-edit
   * journal before the document ledger acts. `true` = the journal consumed
   * the stroke, `false` = the journal is busy and the stroke is blocked,
   * `undefined` = the journal has nothing in this direction.
   */
  onWorkspaceHistoryClaim?: (action: "undo" | "redo") => boolean | undefined;
  /**
   * ED-AUDIT-008: the controlled snapshot is a workspace-history restore
   * (journal undo/redo or recovery). Its reconciliation runs as an
   * "undo"-origin transaction so no second undoable document entry is
   * recorded beside the journal transaction that owns the change.
   */
  historyReplay?: boolean;
  /** Store revision used when the first view creates the canonical document. */
  documentRevision?: number;
  doc: string;
  visible: boolean;
  /**
   * ED-REPAIR-008: whether this editor instance belongs to the active editor group.
   * When false, the host is inactive even if visible (e.g. in multi-split layouts).
   */
  active?: boolean;
  /**
   * Owning workspace instance id (§8.17.6): copy/cut write the workspace
   * clipboard session and paste reads it across every split view.
   */
  clipboardWorkspaceId?: string;
  /** Root workspace clipboard handle (§8.26.2 AA1) */
  clipboardHandle?: WorkspaceClipboardHandle | null;
  /** Surfaced when a clipboard operation degraded (system clipboard failed). */
  onClipboardUnavailable?: (message: string) => void;
  /**
   * ED-CLIP-004: typed, metadata-only observation of every settled guarded
   * clipboard result. Carries outcome/effect/permission-epoch facts, never the
   * clipboard payload, so packaged-runtime evidence can assert which enum
   * member production actually chose.
   */
  onClipboardObservation?: (record: ClipboardObservationRecord) => void;
  diagnostics: LspDiagnostic[];
  highlights?: LspDocumentHighlight[];
  inlayHints?: LspInlayHint[];
  semanticTokens?: LspSemanticToken[];
  gitChanges?: GitLineChange[];
  gitBlame?: GitBlameLine | null;
  /** File test coverage data. */
  fileCoverage?: FileCoverage | null;
  /** Whether coverage gutter overlay is enabled. */
  coverageEnabled?: boolean;
  /** Debug breakpoints on this file (M9) — rendered in the breakpoint gutter. */
  debugBreakpoints?: DebugBreakpointMarker[];
  /** 1-based line the debugger is currently stopped on for this file (or null). */
  debugCurrentLine?: number | null;
  /** Selected-frame locals (`name → value`) rendered as inline values. */
  debugInlineValues?: Record<string, string>;
  /** Stepping / stop actions for the debugger keymap; null when no session runs. */
  debugStep?: ((action: DebugStepAction) => void) | null;
  debugRunToCursor?: ((line: number) => void) | null;
  debugStop?: (() => void) | null;
  /** Hover evaluation while stopped in this file (null disables the tooltip). */
  debugEvaluate?: ((expression: string) => Promise<{ value: string; type: string | null } | null>) | null;
  reveal: EditorRevealTarget | null;
  /** Block edits (library / decompiled sources that have no file to write back to). */
  readOnly?: boolean;
  onChange: (doc: string, caret: LspPosition, caretOffset: number) => void;
  onSave: () => void;
  onHover: (position: LspPosition) => Promise<QuickDocContent | null>;
  onPinHoverDoc?: (content: QuickDocContent) => void;
  onDefinition: (position: LspPosition) => Promise<boolean>;
  onReferences: (position: LspPosition) => Promise<void>;
  onComplete?: (
    position: LspPosition,
    triggerCharacter: string | null,
    token: CompletionRequestToken,
    /** Repeated-call facts (§8.19.4); ordinal ≥ 2 requests expanded scope. */
    invocation?: CompletionInvocationRequest,
  ) => Promise<LspCompletionResult | null>;
  onCompleteResolve?: (
    raw: unknown,
    token: CompletionRequestToken,
  ) => Promise<LspCompletionResolveResult | LspCompletionItem | null>;
  /** Live completion request identity (§8.16.2); null = typed unavailable. */
  getCompletionIdentity: () => CompletionRequestIdentity | null;
  onCompletionDiagnostic: (kind: CompletionAcceptanceDiagnostic, detail?: string) => void;
  /** ED-COMP-004: explicit completion that falls back for missing scope facts. */
  onScopeFallback?: (state: CompletionScopeFactsState) => void;
  /**
   * §8.20.2 W1 single channel: the host only EMITS parameter trigger events
   * (typed signature-trigger char or an explicit nonce); the workspace-side
   * ParameterInfoSession owns requests, delays and cancellation.
   */
  onParameterTrigger?: (event: {
    position: LspPosition;
    anchorOffset: number;
    triggerCharacter: string | null;
    origin: "explicit" | "typing";
  }) => void;
  /** Host-reported viewport churn; the session decides dismissal. */
  onParameterInvalidate?: (reason: "doc-changed" | "caret-moved" | "closing-char") => void;
  /** Esc slot in the editor escape stack — true iff this kind consumed it. */
  onParameterEscape?: () => boolean;
  /** Controlled Parameter Info display state published by the session. */
  parameterPopup?: ParameterPopupView | null;
  onSelectionChange?: (selection: EditorSelectionRange) => void;
  onFoldProvenanceChange?: (provenance: RegionFoldingProvenance | null) => void;
  /** ED-PARITY-012 DEC-012-06: host-rendered Go to Line:Column dialog. */
  onGoToLineRequest?: (request: GoToLineRequest) => void;
  /** ED-PARITY-020: completion hit an unavailable provider at a member access. */
  onCompletionUnavailable?: (info: { explicit: boolean }) => void;
  onViewportChange?: (range: LspRange) => void;
  /**
   * ED-IMPROVE-007: one-shot caret/selection/scroll/fold snapshot for this
   * leaf/file, applied when the view mounts. Later user input is never
   * overwritten by a late restore because it is only applied here.
   */
  initialViewState?: PersistedEditorViewState | null;
  /** Reports view-state changes for in-memory capture and debounced persistence. */
  onViewStateChange?: (state: PersistedEditorViewState) => void;
  onExpandSelection?: (selection: EditorSelectionRange) => Promise<LspRange[] | null>;
  onLightbulb?: (line: number) => void;
  onGitChangeClick?: (change: GitLineChange) => void;
  /** ED-PARITY-022 DEC-022-03: run gutter targets backed by real run facts. */
  runGutterTargets?: RunGutterTarget[];
  onRunGutterClick?: (target: RunGutterTarget, anchor: { x: number; y: number }) => void;
  /** Toggle a breakpoint at a 1-based line (breakpoint gutter click). */
  onToggleBreakpoint?: (line: number) => void;
  /** Edit a breakpoint's condition/logpoint at a 1-based line (gutter right-click). */
  onEditBreakpoint?: (line: number, anchor?: DebugGutterAnchor) => void;
  /** IDEA gutter extras: middle-click enable, Alt/Shift+click kinds, empty-line menu. */
  breakpointGutterActions?: BreakpointGutterActions;
  /** Editor-area right-click (symbol / buffer menu). */
  onContextMenu?: (info: EditorContextMenuRequest) => void;
  onCommandPortChange?: (registration: EditorCommandPortRegistration) => void;
  completionTriggers?: string[];
  completionController?: LspCompletionController;
  signatureTriggers?: string[];
  /** Wrap logical lines at the viewport edge (IDEA soft-wrap mode). */
  softWrap?: boolean;
  /** Workspace-scoped Code Workspace editor appearance. */
  appearance?: EditorAppearanceExtensionProfile;
  /** When false, provider documentation is not requested from pointer hover. */
  showHoverDocumentation?: boolean;
  /** Pointer settle time before requesting documentation. */
  hoverDocumentationDelayMs?: number;
  /** Monotonic explicit request from the workspace ActionHost. */
  parameterInfoRequestNonce?: number;
  /** Render all provider overloads instead of only the active signature. */
  parameterInfoShowFullSignatures?: boolean;
  /** Effective code style driving indentUnit, tabSize, and insertSpaces. */
  codeStyle?: EffectiveCodeStyle;
  /** In-place rendered documentation comments for the active source buffer. */
  renderedDocEnabled?: boolean;
  /** Provider/path language identity used by the documentation renderer. */
  renderedDocLanguageId?: string | null;
  /** Returns from a rendered block to the source view without changing text. */
  onToggleRenderedDocRaw?: () => void;
  /** When enabled, a normal mouse drag creates a rectangular selection. */
  columnSelectionMode?: boolean;
  /**
   * §8.18.2: when provided, the editor's business bindings (save / replace /
   * parameter info / extend selection) are registered as explicit `editor.*`
   * actions on this host and resolved through it — the inline spread-keymap
   * entries are not installed. Null keeps isolated-usage legacy bindings.
   */
  workspaceActionHost?: WorkspaceActionHost | null;
}


/** Payload for the editor context menu (coordinates + clipboard helpers). */
export interface EditorContextMenuRequest {
  position: LspPosition;
  selectionStart: LspPosition;
  selectionEnd: LspPosition;
  clientX: number;
  clientY: number;
  hasSelection: boolean;
  selectedText: string;
  cut: () => void;
  copy: () => void;
  paste: () => void;
}


/**
 * Frozen target for host-owned context-menu execution. Captured when the menu
 * opens so a later active-group change cannot redirect the action.
 */
export interface EditorCommandTarget {
  groupId: string;
  fileKey: string;
}


export type EditorCommandId =
  | "cloneCaretAbove"
  | "cloneCaretBelow"
  | "collapseCarets"
  | "completeStatement"
  | "copy"
  | "cut"
  | "foldAll"
  | "foldSelection"
  | "moveStatementDown"
  | "moveStatementUp"
  | "paste"
  | "pasteAsPlainText"
  | "pasteFromHistory"
  | "pasteWithAutoImports"
  | "selectAllOccurrences"
  | "selectNextOccurrence"
  | "surroundWith"
  | "unfoldAll";


/** Options for commands that need arguments beyond the id (§8.19.8). */
export interface EditorCommandOptions {
  surroundKindId?: SurroundKind["id"];
  /** §8.19.5: index into the workspace clipboard history ring. */
  historyIndex?: number;
  /** Applied once the surround transaction dispatches, with its provenance. */
  onSemanticEditApplied?: (result: { applied: boolean; provenance: SemanticEditSource | null }) => void;
  /** ED-IMPORT-001 A4: atomic paste + import payload. */
  pastePayload?: {
    text: string;
    importStatements?: readonly string[];
  };
}


export interface EditorCommandState {
  composing: boolean;
  readOnly: boolean;
  hasSelection: boolean;
  caretCount: number;
  occurrenceSessionActive: boolean;
  completionActive: boolean;
}


export interface EditorCommandPort {
  execute: (commandId: EditorCommandId, options?: EditorCommandOptions) => boolean;
  state: () => EditorCommandState;
  focus?: (options?: { preventScroll?: boolean }) => boolean;
}


export interface EditorCommandPortRegistration {
  fileKey: string;
  token: object;
  port: EditorCommandPort | null;
}


export interface CompositionSession {
  readonly id: string;
  status: "active" | "end_pending" | "finalized";
  readonly owner: WorkspaceDocumentTransactionOwner;
  readonly fileKey: string;
  readonly viewId: string;
  readonly workspaceId?: string | null;
}
