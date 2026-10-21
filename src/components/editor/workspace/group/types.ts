import { type CSSProperties, type MutableRefObject, type ReactNode } from "react";
import type {
  LspCapabilitySummary,
  LspCompletionItem,
  LspCompletionResolveResult,
  LspCompletionResult,
  LspDiagnostic,
  LspDocumentHighlight,
  LspDocumentSymbol,
  LspInlayHint,
  LspPosition,
  LspRange,
  LspSemanticToken,
} from "../../../../lib/editor/lsp";
import type { GitBlameLine } from "../../../../lib/git";
import type { EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import type { BreakpointGutterActions, GoToLineRequest } from "../CodeMirrorHost";
import { type EditorCommandPortRegistration, type EditorContextMenuRequest, type EditorSelectionRange } from "../CodeMirrorHost";
import type { ClipboardObservationRecord } from "../clipboardObservationContract";
import type { EffectiveCodeStyle } from "../codeStyleModel";
import type { CompletionScopeFactsState } from "../completionScopeAdapter";
import type { FileCoverage } from "../coverageModel";
import type { DebugStepAction } from "../dapDebugModel";
import type { DebugBreakpointMarker } from "../debugEditorChrome";
import type { EditorAppearanceExtensionProfile } from "../editorAppearanceExtension";
import type { EditorBannerItem } from "../editorBannerModel";
import type { OpenFileViewModel } from "../editorGroupTypes";
import type { GitLineChange } from "../gitEditorChrome";
import {
  LspCompletionController,
  type CompletionAcceptanceDiagnostic,
  type CompletionInvocationRequest,
  type CompletionRequestIdentity,
  type CompletionRequestToken,
} from "../lspCompletion";
import type { QuickDocContent } from "../referenceDocumentation";
import type { ParameterPopupView } from "../referenceInfoSession";
import type { RunGutterTarget } from "../runGutter";
import type { WorkspaceActionHost } from "../workspaceActionHost";
import type { WorkspaceDocumentTransactionOwner } from "../workspaceDocumentTransactionOwner";
import type { PersistedEditorViewState } from "../workspaceLayoutPersistence";
import { type WorkspaceTabPolicyV3 } from "../workspaceTabPolicy";

export type MarkdownViewMode = "edit" | "preview" | "split";

export interface EditorRevealTarget {
  focus?: boolean;
  key: string;
  line: number;
  character: number;
  nonce: number;
  /** When set, the reveal selects [line:character, end) (e.g. a Structural Search match). */
  end?: { line: number; character: number; };
}

export interface EmptyEditorHint {
  label: string;
  /** Effective shortcut label from the keymap; omitted when unbound. */
  shortcut?: string;
}

export interface EditorGroupProps {
  /** ED-PARITY-010 DEC-010-03: IDEA empty-editor quick tips. */
  emptyHints?: readonly EmptyEditorHint[];
  /** Clipboard degradation notices forwarded to the workspace status bar. */
  onClipboardUnavailable?: (message: string) => void;
  /** ED-CLIP-004: typed guarded-clipboard observations for the workspace seam. */
  onClipboardObservation?: (record: ClipboardObservationRecord) => void;

  groupId: EditorGroupId;
  workspaceInstanceId: string;
  visible: boolean;
  /**
   * ED-REPAIR-008: whether this editor group is the active editor group in the workspace.
   * When false, the group's editors are considered inactive even if visible.
   */
  isActiveGroup?: boolean;
  /** Temporarily blocks mutations while an external resource edit is committing. */
  readOnly?: boolean;
  tabPolicy?: WorkspaceTabPolicyV3;
  lastUsedByKey?: ReadonlyMap<string, number>;
  openOrder: string[];
  openFiles: Record<string, OpenFileViewModel>;
  activeKey: string | null;
  previewKey: string | null;
  pinnedKeys: string[];
  activeFile: OpenFileViewModel | null;
  activeMarkdownMode: MarkdownViewMode;
  activeDiagnostics: LspDiagnostic[];
  activeHighlights: LspDocumentHighlight[];
  activeInlayHints: LspInlayHint[];
  activeSemanticTokens?: LspSemanticToken[];
  activeGitChanges: GitLineChange[];
  activeGitBlame: GitBlameLine | null;
  /** ED-PARITY-022 DEC-022-02: open HEAD ↔ buffer diff for the active file. */
  onShowGitDiff?: (key: string) => void;
  /** ED-PARITY-022 DEC-022-03: run gutter targets of the active file (real run facts only). */
  activeRunGutterTargets?: RunGutterTarget[];
  onRunGutterClick?: (target: RunGutterTarget, anchor: { x: number; y: number; }) => void;
  /** Active file code coverage. */
  activeCoverage?: FileCoverage | null;
  /** Coverage overlay enabled. */
  coverageEnabled?: boolean;
  /** Effective code style for the active buffer. */
  activeCodeStyle?: EffectiveCodeStyle;
  /** Breakpoints on the active file (M9), for the breakpoint gutter. */
  activeDebugBreakpoints?: DebugBreakpointMarker[];
  /** 1-based current-execution line on the active file (or null). */
  activeDebugCurrentLine?: number | null;
  /** Selected-frame locals rendered as inline values on the active file. */
  activeDebugInlineValues?: Record<string, string>;
  onToggleBreakpoint?: (line: number) => void;
  onEditBreakpoint?: (line: number, anchor?: { x: number; y: number; }) => void;
  breakpointGutterActions?: BreakpointGutterActions;
  /** Debugger keymap actions (F7/F8/F9/Ctrl+F2/Alt+F9); null when idle. */
  debugStep?: ((action: DebugStepAction) => void) | null;
  debugRunToCursor?: ((line: number) => void) | null;
  debugStop?: (() => void) | null;
  /** Hover evaluation on the active file while stopped there. */
  debugEvaluate?: ((expression: string) => Promise<{ value: string; type: string | null; } | null>) | null;
  activeCapabilities: LspCapabilitySummary | null;
  activeLspSyncing: boolean;
  lspStatusPill: ReactNode;
  highlightingWidget?: ReactNode;
  breadcrumbs: ReactNode;
  breadcrumbsPlacement?: "top" | "bottom" | "status-bar";
  editorBanners?: EditorBannerItem[];
  /** ED-PARITY-012 DEC-012-06: host-rendered Go to Line dialog. */
  onGoToLineRequest?: (request: GoToLineRequest) => void;
  /** ED-PARITY-020: member completion reached an unavailable provider. */
  onCompletionUnavailable?: (info: { explicit: boolean; }) => void;
  /** ED-PARITY-011 DEC-011-05: files with error diagnostics (red wavy tab name). */
  filesWithErrors?: ReadonlySet<string>;
  onDismissBanner?: (id: string) => void;
  activeSymbols?: LspDocumentSymbol[];
  stickyLinesEnabled?: boolean;
  onRevealTargetLine?: (line: number) => void;
  revealTarget: EditorRevealTarget | null;
  editorPaneRef: MutableRefObject<HTMLElement | null>;
  editorPaneStyle: CSSProperties;
  softWrap?: boolean;
  appearance?: EditorAppearanceExtensionProfile;
  /** Whether doc comments are replaced with safe rendered blocks for this file. */
  renderedDocEnabled?: boolean;
  /** Language identity used by the rendered documentation extractor. */
  renderedDocLanguageId?: string | null;
  /** Return a rendered documentation block to source mode. */
  onToggleRenderedDocRaw?: () => void;
  columnSelectionMode?: boolean;
  showHoverDocumentation?: boolean;
  hoverDocumentationDelayMs?: number;
  parameterInfoRequestNonce?: number;
  parameterInfoShowFullSignatures?: boolean;
  onActivate: (key: string) => void;
  onActivateGroup: () => void;
  onClose: (key: string) => void;
  onPin: (key: string, pinned: boolean) => void;
  onPromotePreview: (key: string) => void;
  onCloseOthers: (key: string) => void;
  onCloseRight: (key: string) => void;
  onCloseUnmodified: () => void;
  onCloseAll: () => void;
  onSplitRight: (key: string) => void;
  onSplitDown: (key: string) => void;
  /** §8.19.6 move-tab-between-splits; provided only when another leaf exists. */
  onMoveTabToNextSplit?: (key: string) => void;
  onMoveTabToPreviousSplit?: (key: string) => void;
  onCopyPath: (key: string, absolute: boolean) => void;
  onRevealInTree: (key: string) => void;
  onRevealInSystem: (key: string) => void;
  onOpenInTerminal: (key: string) => void;
  onLocalHistory?: (key: string) => void;
  /** Fetch attached sources for a decompiled library buffer (jdtls Java classes). */
  onDownloadSources?: (key: string) => void;
  /** Keys whose sources are currently downloading (drives the banner spinner). */
  downloadingSourcesKeys?: string[];
  onMarkdownModeChange: (mode: MarkdownViewMode) => void;
  onChangeText: (key: string, text: string, caret?: LspPosition, caretOffset?: number) => void;
  onSave: (key: string) => void;
  /** §8.18.2: workspace action host owning the editor.* business actions. */
  workspaceActionHost?: WorkspaceActionHost | null;
  /** §8.26 / ED-MULTIVIEW-002: shared document transaction owner across splits. */
  transactionOwner?: WorkspaceDocumentTransactionOwner | null;
  /**
   * ED-AUDIT-008: claim a Ctrl+Z / Ctrl+Shift+Z stroke for the workspace-edit
   * journal before the document ledger acts. `true` = the journal consumed
   * the stroke, `false` = the journal is busy and the stroke is blocked,
   * `undefined` = the journal has nothing in this direction.
   */
  onWorkspaceHistoryClaim?: (action: "undo" | "redo") => boolean | undefined;
  /** Current buffer revision used to seed the shared document owner. */
  documentRevision?: number;
  onHover: (
    file: OpenFileViewModel,
    position: LspPosition,
  ) => Promise<QuickDocContent | null>;
  onPinHoverDoc?: (content: QuickDocContent) => void;
  onDefinition: (file: OpenFileViewModel, position: LspPosition) => Promise<boolean>;
  onReferences: (file: OpenFileViewModel, position: LspPosition) => Promise<void>;
  onComplete: (
    file: OpenFileViewModel,
    position: LspPosition,
    trigger: string | null,
    token: CompletionRequestToken,
    invocation?: CompletionInvocationRequest,
  ) => Promise<LspCompletionResult | null>;
  onCompleteResolve: (
    file: OpenFileViewModel,
    raw: unknown,
    token: CompletionRequestToken,
  ) => Promise<LspCompletionResolveResult | LspCompletionItem | null>;
  /** Live completion request identity per file (§8.16.2). */
  onCompletionIdentity: (file: OpenFileViewModel) => CompletionRequestIdentity | null;
  onCompletionDiagnostic: (
    kind: CompletionAcceptanceDiagnostic,
    detail?: string,
  ) => void;
  /** ED-COMP-004: explicit completion that falls back for missing scope facts. */
  onScopeFallback?: (state: CompletionScopeFactsState) => void; completionController?: LspCompletionController;
  /** §8.20.2 W1 single channel: file-scoped trigger event into the session. */
  onParameterTrigger?: (
    file: OpenFileViewModel,
    event: {
      position: LspPosition;
      anchorOffset: number;
      triggerCharacter: string | null;
      origin: "explicit" | "typing";
    },
  ) => void;
  onParameterInvalidate?: (reason: "doc-changed" | "caret-moved" | "closing-char") => void;
  onParameterEscape?: () => boolean;
  parameterPopup?: ParameterPopupView | null;
  onSelectionChange: (selection: EditorSelectionRange) => void;
  onViewportChange: (range: LspRange) => void;
  /** ED-IMPROVE-007: this leaf/file's persisted caret/scroll/fold snapshot. */
  initialViewState?: PersistedEditorViewState | null;
  /** ED-IMPROVE-007: reports view-state changes for in-memory capture. */
  onViewStateChange?: (
    groupId: EditorGroupId,
    fileKey: string,
    state: PersistedEditorViewState,
  ) => void;
  onExpandSelection: (file: OpenFileViewModel, selection: EditorSelectionRange) => Promise<LspRange[] | null>;
  onLightbulb: (line: number) => void;
  onEditorContextMenu: (file: OpenFileViewModel, request: EditorContextMenuRequest & { groupId: string; }) => void;
  onEditorCommandPortChange?: (
    groupId: EditorGroupId,
    registration: EditorCommandPortRegistration,
  ) => void;
  onOpenMarkdownHref: (href: string) => boolean;
  formatBytes: (size: number) => string;
  formatMtime: (mtime: number) => string;
  isMarkdownPath: (path: string) => boolean;
  renderMarkdownPreview: (file: OpenFileViewModel, onOpenHref: (href: string) => boolean) => ReactNode;
}
