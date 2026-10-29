import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useRef, useState } from "react";
import { type ClipboardObservationRecord } from "../clipboardObservationContract";
import { type CompositionSession, type EditorSelectionRange } from "./types";
import { type CompletionResolveGateRequest } from "../lspCompletion";
import type { EditorViewStateLifecycle } from "./editorViewStateLifecycle";
import type { WorkspaceActionHost } from "../workspaceActionHost";
let nextEditorHostViewId = 0;

export interface UseEditorHostRefsContext {
  completionController: import("../lspCompletion").LspCompletionController | undefined;
  viewId: string | undefined;
  fileKey: string;
  transactionOwner: import("../workspaceDocumentTransactionOwner").WorkspaceDocumentTransactionOwner | null;
  onWorkspaceHistoryClaim: ((action: "undo" | "redo") => boolean | undefined) | undefined;
  historyReplay: boolean;
  workspaceActionHost: WorkspaceActionHost | null;
  onClipboardUnavailable: ((message: string) => void) | undefined;
  onClipboardObservation: ((record: ClipboardObservationRecord) => void) | undefined;
  onToggleBreakpoint: ((line: number) => void) | undefined;
  onEditBreakpoint: ((line: number, anchor?: import("../debugEditorChrome").DebugGutterAnchor) => void) | undefined;
  breakpointGutterActions: import("./types").BreakpointGutterActions | undefined;
  onPinHoverDoc: ((content: import("../referenceDocumentation").QuickDocContent) => void) | undefined;
  debugStep: ((action: import("../dapDebugModel").DebugStepAction) => void) | null | undefined;
  debugRunToCursor: ((line: number) => void) | null | undefined;
  debugStop: (() => void) | null | undefined;
  debugEvaluate: ((expression: string) => Promise<{ value: string; type: string | null; } | null>) | null | undefined;
  onChange: (doc: string, caret: import("../../../../lib/editor/lsp").LspPosition, caretOffset: number) => void;
  onSave: () => void;
  onHover: (position: import("../../../../lib/editor/lsp").LspPosition) => Promise<import("../referenceDocumentation").QuickDocContent | null>;
  onDefinition: (position: import("../../../../lib/editor/lsp").LspPosition) => Promise<boolean>;
  onReferences: (position: import("../../../../lib/editor/lsp").LspPosition) => Promise<void>;
  onComplete: ((position: import("../../../../lib/editor/lsp").LspPosition, triggerCharacter: string | null, token: import("../lspCompletion").CompletionRequestToken, invocation?: import("../lspCompletion").CompletionInvocationRequest) => Promise<import("../../../../lib/editor/lsp").LspCompletionResult | null>) | undefined;
  onCompleteResolve: ((raw: unknown, token: import("../lspCompletion").CompletionRequestToken) => Promise<import("../../../../lib/editor/lsp").LspCompletionResolveResult | import("../../../../lib/editor/lsp").LspCompletionItem | null>) | undefined;
  getCompletionIdentity: () => import("../lspCompletion").CompletionRequestIdentity | null;
  onCompletionDiagnostic: (kind: import("../lspCompletion").CompletionAcceptanceDiagnostic, detail?: string) => void;
  onScopeFallback: ((state: import("../completionScopeAdapter").CompletionScopeFactsState) => void) | undefined;
  onParameterTrigger: ((event: { position: import("../../../../lib/editor/lsp").LspPosition; anchorOffset: number; triggerCharacter: string | null; origin: "explicit" | "typing"; }) => void) | undefined;
  onParameterInvalidate: ((reason: "doc-changed" | "caret-moved" | "closing-char") => void) | undefined;
  onParameterEscape: (() => boolean) | undefined;
  onSelectionChange: ((selection: EditorSelectionRange) => void) | undefined;
  onFoldProvenanceChange: ((provenance: import("../workspaceEditorCommands").RegionFoldingProvenance | null) => void) | undefined;
  onGoToLineRequest: ((request: import("./types").GoToLineRequest) => void) | undefined;
  onCompletionUnavailable: ((info: { explicit: boolean; }) => void) | undefined;
  onViewportChange: ((range: import("../../../../lib/editor/lsp").LspRange) => void) | undefined;
  initialViewState: import("../workspaceLayoutPersistence").PersistedEditorViewState | null;
  onViewStateChange: ((state: import("../workspaceLayoutPersistence").PersistedEditorViewState) => void) | undefined;
  visible: boolean;
  active: boolean;
  onExpandSelection: ((selection: EditorSelectionRange) => Promise<import("../../../../lib/editor/lsp").LspRange[] | null>) | undefined;
  onLightbulb: ((line: number) => void) | undefined;
  onGitChangeClick: ((change: import("../gitEditorChrome").GitLineChange) => void) | undefined;
  onRunGutterClick: ((target: import("../runGutter").RunGutterTarget, anchor: { x: number; y: number; }) => void) | undefined;
  onContextMenu: ((info: import("./types").EditorContextMenuRequest) => void) | undefined;
  onToggleRenderedDocRaw: (() => void) | undefined;
  completionTriggers: string[] | undefined;
  signatureTriggers: string[] | undefined;
  columnSelectionMode: boolean;
  parameterInfoShowFullSignatures: boolean;
  path: string;
}

export function useEditorHostRefs(context: UseEditorHostRefsContext) {
  const {
    completionController,
    viewId,
    fileKey,
    transactionOwner,
    onWorkspaceHistoryClaim,
    historyReplay,
    workspaceActionHost,
    onClipboardUnavailable,
    onClipboardObservation,
    onToggleBreakpoint,
    onEditBreakpoint,
    breakpointGutterActions,
    onPinHoverDoc,
    debugStep,
    debugRunToCursor,
    debugStop,
    debugEvaluate,
    onChange,
    onSave,
    onHover,
    onDefinition,
    onReferences,
    onComplete,
    onCompleteResolve,
    getCompletionIdentity,
    onCompletionDiagnostic,
    onScopeFallback,
    onParameterTrigger,
    onParameterInvalidate,
    onParameterEscape,
    onSelectionChange,
    onFoldProvenanceChange,
    onGoToLineRequest,
    onCompletionUnavailable,
    onViewportChange,
    initialViewState,
    onViewStateChange,
    visible,
    active,
    onExpandSelection,
    onLightbulb,
    onGitChangeClick,
    onRunGutterClick,
    onContextMenu,
    onToggleRenderedDocRaw,
    completionTriggers,
    signatureTriggers,
    columnSelectionMode,
    parameterInfoShowFullSignatures,
    path,
  } = context;
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const completionControllerRef = useRef(completionController);
  completionControllerRef.current = completionController;
  const fallbackViewIdRef = useRef<string | null>(null);
  if (fallbackViewIdRef.current === null) {
    nextEditorHostViewId += 1;
    fallbackViewIdRef.current = `cm-view-${nextEditorHostViewId}`;
  }
  const editorViewId = viewId ?? fallbackViewIdRef.current;
  const viewIdRef = useRef(editorViewId);
  viewIdRef.current = editorViewId;
  const fileKeyRef = useRef(fileKey);
  fileKeyRef.current = fileKey;
  const transactionOwnerRef = useRef(transactionOwner);
  transactionOwnerRef.current = transactionOwner;
  const workspaceHistoryClaimRef = useRef(onWorkspaceHistoryClaim);
  workspaceHistoryClaimRef.current = onWorkspaceHistoryClaim;
  const historyReplayRef = useRef(historyReplay);
  historyReplayRef.current = historyReplay;
  // §8.18.2: the mount-once editor effect reads the live host through a ref so
  // editor.* actions register against the workspace controller's instance.
  const workspaceActionHostRef = useRef<WorkspaceActionHost | null>(workspaceActionHost);
  workspaceActionHostRef.current = workspaceActionHost;
  const onClipboardUnavailableRef = useRef((message: string) => {
    onClipboardUnavailable?.(message);
  });
  onClipboardUnavailableRef.current = (message: string) => {
    onClipboardUnavailable?.(message);
  };
  const onClipboardObservationRef = useRef((record: ClipboardObservationRecord) => {
    onClipboardObservation?.(record);
  });
  onClipboardObservationRef.current = (record: ClipboardObservationRecord) => {
    onClipboardObservation?.(record);
  };
  const overlayCompartment = useRef(new Compartment());
  const semanticTokensCompartment = useRef(new Compartment());
  const gitCompartment = useRef(new Compartment());
  const completionCompartment = useRef(new Compartment());
  const presentResolveGateRef = useRef<((request: CompletionResolveGateRequest) => void) | null>(null);
  const pendingCompletionAcceptanceRef = useRef<(() => void) | null>(null);
  const resolveGateSequenceRef = useRef(0);

  const lastSelectionRef = useRef<{ from: number; to: number; searchOpen: boolean; } | null>(null);
  /** Origin of the latest selection change (DEC-011-07). */
  const selectionOriginRef = useRef<"pointer" | "keyboard" | "other">("other");
  const pointerClickCountRef = useRef(1);
  const shiftExtendKeyRef = useRef(false);
  const selectionKeyTrackerCleanupRef = useRef<(() => void) | null>(null);
  const selectionEmitTimerRef = useRef<number | null>(null);
  const viewportEmitTimerRef = useRef<number | null>(null);
  const renderedCompletionPolicyRef = useRef<{
    autoPopup: boolean;
    delayMs: number;
    maxVisibleItems: number;
    docDelayMs: number;
  } | null>(null);
  const onToggleBreakpointRef = useRef(onToggleBreakpoint);
  const onEditBreakpointRef = useRef(onEditBreakpoint);
  const breakpointGutterActionsRef = useRef(breakpointGutterActions);
  const onPinHoverDocRef = useRef(onPinHoverDoc);
  onPinHoverDocRef.current = onPinHoverDoc;
  // Debug actions go through refs so a new session (or a step landing) does not
  // force the whole editor extension set to be rebuilt.
  const debugStepRef = useRef(debugStep);
  const debugRunToCursorRef = useRef(debugRunToCursor);
  const debugStopRef = useRef(debugStop);
  const debugEvaluateRef = useRef(debugEvaluate);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onHoverRef = useRef(onHover);
  const onDefinitionRef = useRef(onDefinition);
  const onReferencesRef = useRef(onReferences);
  const onCompleteRef = useRef(onComplete);
  const onCompleteResolveRef = useRef(onCompleteResolve);
  const getCompletionIdentityRef = useRef(getCompletionIdentity);
  const onCompletionDiagnosticRef = useRef(onCompletionDiagnostic);
  const onScopeFallbackRef = useRef(onScopeFallback);
  const onParameterTriggerRef = useRef(onParameterTrigger);
  const onParameterInvalidateRef = useRef(onParameterInvalidate);
  const onParameterEscapeRef = useRef(onParameterEscape);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onFoldProvenanceChangeRef = useRef(onFoldProvenanceChange);
  const onGoToLineRequestRef = useRef(onGoToLineRequest);
  const onCompletionUnavailableRef = useRef(onCompletionUnavailable);
  const onViewportChangeRef = useRef(onViewportChange);
  // ED-IMPROVE-007: the initial snapshot is read once at view creation; later
  // prop changes never re-apply it over the user's live caret/scroll.
  const initialViewStateRef = useRef(initialViewState);
  initialViewStateRef.current = initialViewState;
  const onViewStateChangeRef = useRef(onViewStateChange);
  onViewStateChangeRef.current = onViewStateChange;
  const lastEmittedViewStateRef = useRef<string | null>(null);
  const viewStateLifecycleRef = useRef<EditorViewStateLifecycle | null>(null);
  const pendingDeferredScrollRef = useRef<{ scrollTop: number; scrollLeft: number; } | null>(null);
  const userInteractedSinceMountRef = useRef(false);
  const restoringInitialViewStateRef = useRef(false);
  // ED-IMPROVE-008 & ED-REPAIR-007: IME composition ownership and session lifecycle.
  const compositionActiveRef = useRef(false);
  const compositionSessionSeqRef = useRef(0);
  const currentCompositionSessionRef = useRef<CompositionSession | null>(null);
  const compositionEndFinalizeRef = useRef<number | null>(null);
  // ED-MAIN-007 / ED-REPAIR-008: latest visible/active-leaf state for the async clipboard owner.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const activeRef = useRef(active);
  activeRef.current = active;
  const onExpandSelectionRef = useRef(onExpandSelection);
  const onLightbulbRef = useRef(onLightbulb);
  const onGitChangeClickRef = useRef(onGitChangeClick);
  const onRunGutterClickRef = useRef(onRunGutterClick);
  const onContextMenuRef = useRef(onContextMenu);
  const onToggleRenderedDocRawRef = useRef(onToggleRenderedDocRaw);
  const completionTriggersRef = useRef(completionTriggers ?? []);
  const signatureTriggersRef = useRef(signatureTriggers ?? []);
  const columnSelectionModeRef = useRef(columnSelectionMode);
  const parameterInfoShowFullSignaturesRef = useRef(parameterInfoShowFullSignatures);
  const pathRef = useRef(path);
  // §8.19.4: set around the editor.basicCompletion close+reopen toggle so the
  // popup-close listener does not reset the repeated-call ordinal mid-toggle.
  const basicCompletionReopenRef = useRef(false);
  // §8.19.4 resolve gate banner state; the closures inside the request guard
  // staleness themselves, this only drives presentation.
  const [resolveGateUi, setResolveGateUi] = useState<{
    id: number;
    label: string;
    message: string;
    failed: boolean;
    retrying: boolean;
    top: number;
    left: number;
    retry: () => Promise<"committed" | "unavailable">;
    insertWithoutImport: () => boolean;
    dismiss: () => void;
  } | null>(null);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onHoverRef.current = onHover;
  onDefinitionRef.current = onDefinition;
  onReferencesRef.current = onReferences;
  onCompleteRef.current = onComplete;
  onCompleteResolveRef.current = onCompleteResolve;
  getCompletionIdentityRef.current = getCompletionIdentity;
  onCompletionDiagnosticRef.current = onCompletionDiagnostic;
  onScopeFallbackRef.current = onScopeFallback;
  onParameterTriggerRef.current = onParameterTrigger;
  onParameterInvalidateRef.current = onParameterInvalidate;
  onParameterEscapeRef.current = onParameterEscape;
  onSelectionChangeRef.current = onSelectionChange;
  onFoldProvenanceChangeRef.current = onFoldProvenanceChange;
  onGoToLineRequestRef.current = onGoToLineRequest;
  onCompletionUnavailableRef.current = onCompletionUnavailable;
  onViewportChangeRef.current = onViewportChange;
  onExpandSelectionRef.current = onExpandSelection;
  onLightbulbRef.current = onLightbulb;
  onGitChangeClickRef.current = onGitChangeClick;
  onRunGutterClickRef.current = onRunGutterClick;
  onToggleBreakpointRef.current = onToggleBreakpoint;
  onEditBreakpointRef.current = onEditBreakpoint;
  breakpointGutterActionsRef.current = breakpointGutterActions;
  debugStepRef.current = debugStep;
  debugRunToCursorRef.current = debugRunToCursor;
  debugStopRef.current = debugStop;
  debugEvaluateRef.current = debugEvaluate;
  onContextMenuRef.current = onContextMenu;
  onToggleRenderedDocRawRef.current = onToggleRenderedDocRaw;
  return { getCompletionIdentityRef, viewRef, pathRef, completionCompartment, onCompleteRef, onCompleteResolveRef, completionTriggersRef, onCompletionDiagnosticRef, onScopeFallbackRef, onCompletionUnavailableRef, presentResolveGateRef, pendingCompletionAcceptanceRef, resolveGateSequenceRef, setResolveGateUi, completionControllerRef, onToggleBreakpointRef, onEditBreakpointRef, breakpointGutterActionsRef, debugStepRef, debugRunToCursorRef, debugStopRef, debugEvaluateRef, signatureTriggersRef, columnSelectionModeRef, parameterInfoShowFullSignaturesRef, onSelectionChangeRef, onFoldProvenanceChangeRef, lastSelectionRef, selectionOriginRef, onViewportChangeRef, hostRef, transactionOwnerRef, fileKeyRef, viewIdRef, selectionEmitTimerRef, viewportEmitTimerRef, onViewStateChangeRef, viewStateLifecycleRef, lastEmittedViewStateRef, onSaveRef, onParameterTriggerRef, onExpandSelectionRef, pointerClickCountRef, shiftExtendKeyRef, basicCompletionReopenRef, visibleRef, activeRef, onLightbulbRef, overlayCompartment, semanticTokensCompartment, onRunGutterClickRef, gitCompartment, onGitChangeClickRef, onHoverRef, onPinHoverDocRef, onToggleRenderedDocRawRef, onDefinitionRef, onReferencesRef, workspaceActionHostRef, onParameterEscapeRef, onContextMenuRef, currentCompositionSessionRef, compositionActiveRef, onChangeRef, onParameterInvalidateRef, restoringInitialViewStateRef, userInteractedSinceMountRef, pendingDeferredScrollRef, selectionKeyTrackerCleanupRef, initialViewStateRef, compositionEndFinalizeRef, compositionSessionSeqRef, onGoToLineRequestRef, workspaceHistoryClaimRef, onClipboardUnavailableRef, onClipboardObservationRef, renderedCompletionPolicyRef, editorViewId, historyReplayRef, resolveGateUi };
}
