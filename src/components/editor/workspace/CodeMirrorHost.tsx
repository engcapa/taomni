import { acceptCompletion,closeBrackets,closeCompletion,completionStatus,setSelectedCompletion,startCompletion } from "@codemirror/autocomplete";
import { history } from "@codemirror/commands";
import { bracketMatching,foldEffect,foldGutter,indentOnInput,indentUnit } from "@codemirror/language";
import { search,searchPanelOpen } from "@codemirror/search";
import { Compartment,EditorState,Transaction } from "@codemirror/state";
import type { KeyBinding } from "@codemirror/view";
import { crosshairCursor,drawSelection,EditorView,highlightActiveLine,highlightActiveLineGutter,keymap,lineNumbers,rectangularSelection } from "@codemirror/view";
import { TriangleAlert,X } from "lucide-react";
import { memo,useCallback,useEffect,useRef,useState } from "react";
import { codeViewExtensions } from "../../../lib/codeViewTheme";
import { type ClipboardObservationRecord } from "./clipboardObservationContract";
import { createCoverageEditorChrome } from "./coverageEditorChrome";
import { createDebugEditorChrome,type DebugBreakpointMarker } from "./debugEditorChrome";
import { editorAppearanceExtension } from "./editorAppearanceExtension";
import { createWorkspaceSearchPanel,openWorkspaceReplacePanel,WORKSPACE_SEARCH_STYLE } from "./editorSearchPanel";
import { createErrorStripe } from "./errorStripe";
import { createGitEditorChrome } from "./gitEditorChrome";
import { LSP_EDITOR_STYLE,readOnlyExtension,WORKSPACE_EDITOR_STYLE } from "./host/appearance";
import { bumpClipboardOwnerGeneration,clipboardContextByView,clipboardOwnerGeneration } from "./host/clipboard";
import { editorCommandPort,editorLanguageByView } from "./host/commands";
import { createCompositionLifecycle } from "./host/createCompositionLifecycle";
import { createDocumentUpdateListener } from "./host/createDocumentUpdateListener";
import { createEditorDomHandlers } from "./host/createEditorDomHandlers";
import { createMountedEditorActions } from "./host/createMountedEditorActions";
import { createTemplateKeybindings } from "./host/createTemplateKeybindings";
import { cancelActiveHoverResize,foldHoverProvenanceTooltip,lspHoverExtension,lspNavigationExtensions } from "./host/intelligence";
import { areCodeMirrorHostPropsEqual,EMPTY_DEBUG_BREAKPOINTS,EMPTY_DEBUG_INLINE_VALUES,EMPTY_DIAGNOSTICS,EMPTY_GIT_CHANGES,EMPTY_HIGHLIGHTS,EMPTY_INLAY_HINTS,EMPTY_RUN_GUTTER_TARGETS,EMPTY_SEMANTIC_TOKENS } from "./host/reconciliation";
import { type CodeMirrorHostProps,type CompositionSession,type EditorSelectionRange } from "./host/types";
import { useDocumentReconciliation } from "./host/useDocumentReconciliation";
import { useEditorDecorations } from "./host/useEditorDecorations";
import { useEditorIntelligence } from "./host/useEditorIntelligence";
import { useEditorPresentation } from "./host/useEditorPresentation";
import { useProviderCompletion } from "./host/useProviderCompletion";
import { applyPersistedEditorViewState,captureEditorViewState,importFoldPathByView } from "./host/viewState";
import { importFoldRange } from "./importFold";
import { liveTemplateLanguageForPath } from "./liveTemplates";
import { cancelLspSnippetSession,lspSnippetSessionInvalidator,resetBasicCompletionSession,type CompletionResolveGateRequest } from "./lspCompletion";
import { createDiagnosticChrome } from "./lspDiagnosticChrome";
import { createLspOverlayChrome,createLspSemanticTokenChrome,LSP_INTELLIGENCE_THEME } from "./lspIntelligenceChrome";
import { lspPositionFromOffset,offsetFromLspPosition } from "./lspPositions";
import { RENDERED_DOC_THEME,renderedDocDecorationConfig,renderedDocDecorationField } from "./renderedDocCommentsExtension";
import { createRunGutter } from "./runGutter";
import type { WorkspaceActionHost } from "./workspaceActionHost";
import { EditorActionBridge } from "./workspaceActionHost";
import { useWorkspaceClipboardSession } from "./workspaceClipboardSession";
import { buildEditorPrimitiveKeybindings } from "./workspaceCodeMirrorKeymap";
import { createRegionFoldService,detectLineFoldProvenance,escapeEditorSelections,expandSelectionFromLspRanges,expandSyntaxSelection,occurrenceSessionField,selectionHistoryField } from "./workspaceEditorCommands";
import { treeRevisionField } from "./workspaceSyntaxFacts";
import { desiredVisualColumnField,virtualOverflowRestoreField,virtualSpaceClickHandler,virtualSpaceOverflowField,virtualSpaceTypingHandler } from "./workspaceVirtualSpace";












// CodeMirror uses this only to ignore the key event that opened a popup. It is
// unrelated to how long completion documentation waits before being shown.







let nextEditorHostViewId = 0;












export const CodeMirrorHost = memo(function CodeMirrorHost({
  path,
  fileKey = path,
  viewId,
  transactionOwner = null,
  onWorkspaceHistoryClaim,
  historyReplay = false,
  documentRevision = 0,
  doc,
  visible,
  active = true,
  diagnostics = EMPTY_DIAGNOSTICS,
  highlights = EMPTY_HIGHLIGHTS,
  inlayHints = EMPTY_INLAY_HINTS,
  semanticTokens = EMPTY_SEMANTIC_TOKENS,
  gitChanges = EMPTY_GIT_CHANGES,
  gitBlame = null,
  reveal,
  readOnly = false,
  onChange,
  onSave,
  onHover,
  onPinHoverDoc,
  onDefinition,
  onReferences,
  clipboardWorkspaceId,
  clipboardHandle,
  onClipboardUnavailable,
  onClipboardObservation,
  onComplete,
  onCompleteResolve,
  getCompletionIdentity,
  onCompletionDiagnostic,
  onScopeFallback,
  onParameterTrigger,
  onParameterInvalidate,
  onParameterEscape,
  parameterPopup = null,
  onSelectionChange,
  onFoldProvenanceChange,
  onGoToLineRequest,
  onCompletionUnavailable,
  onViewportChange,
  initialViewState = null,
  onViewStateChange,
  onExpandSelection,
  onLightbulb,
  onGitChangeClick,
  runGutterTargets = EMPTY_RUN_GUTTER_TARGETS,
  onRunGutterClick,
  onToggleBreakpoint,
  onEditBreakpoint,
  breakpointGutterActions,
  onContextMenu,
  onCommandPortChange,
  completionTriggers,
  completionController,
  signatureTriggers,
  showHoverDocumentation = true,
  hoverDocumentationDelayMs = 300,
  parameterInfoRequestNonce = 0,
  parameterInfoShowFullSignatures = false,
  softWrap = false,
  appearance,
  columnSelectionMode = false,
  debugBreakpoints = EMPTY_DEBUG_BREAKPOINTS,
  debugCurrentLine,
  debugInlineValues = EMPTY_DEBUG_INLINE_VALUES,
  debugStep,
  debugRunToCursor,
  debugStop,
  debugEvaluate,
  fileCoverage,
  coverageEnabled = true,
  codeStyle,
  renderedDocEnabled = false,
  renderedDocLanguageId,
  onToggleRenderedDocRaw,
  workspaceActionHost = null,
}: CodeMirrorHostProps) {
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

  const lastSelectionRef = useRef<{ from: number; to: number; searchOpen: boolean } | null>(null);
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
  const viewStateEmitTimerRef = useRef<number | null>(null);
  const pendingDeferredScrollRef = useRef<{ scrollTop: number; scrollLeft: number } | null>(null);
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

  /**
   * Build the debug compartment's extensions. Actions read through refs so the
   * extension only has to be rebuilt when what is *rendered* changes; `evaluating`
   * is a flag rather than the callback so a new function identity per render
   * does not churn the editor.
   */
  const { buildAutocompletionExtension, pendingTriggerOriginRef, localRefreshTimerRef, getValidActiveProviderCandidate, liveTemplateSourceOptions, completionPolicyGenerationRef, lastCollisionFingerprintRef } = useProviderCompletion({
    getCompletionIdentityRef,
    viewRef,
    completionController,
    hoverDocumentationDelayMs,
    pathRef,
    completionCompartment,
    onCompleteRef,
    onCompleteResolveRef,
    completionTriggersRef,
    onCompletionDiagnosticRef,
    onScopeFallbackRef,
    onCompletionUnavailableRef,
    presentResolveGateRef,
    pendingCompletionAcceptanceRef,
    resolveGateSequenceRef,
    setResolveGateUi,
    completionControllerRef,
  });
  const buildDebugChrome = useCallback((
    markers: DebugBreakpointMarker[] | undefined,
    currentLine: number | null | undefined,
    inlineValues: Record<string, string> | undefined,
    evaluating: boolean,
  ) => createDebugEditorChrome({
    markers: markers ?? [],
    currentLine: currentLine ?? null,
    inlineValues,
    actions: {
      toggleBreakpoint: (line) => onToggleBreakpointRef.current?.(line),
      editBreakpoint: (line, anchor) => onEditBreakpointRef.current?.(line, anchor),
      toggleBreakpointEnabled: (line) => breakpointGutterActionsRef.current?.toggleEnabled?.(line),
      addBreakpoint: (line, kind, anchor) => {
        const add = breakpointGutterActionsRef.current?.add;
        if (add) add(line, kind, anchor);
        else onToggleBreakpointRef.current?.(line);
      },
      openGutterMenu: (line, anchor) => {
        const open = breakpointGutterActionsRef.current?.openMenu;
        if (open) open(line, anchor);
        else onEditBreakpointRef.current?.(line, anchor);
      },
      step: (action) => {
        const step = debugStepRef.current;
        if (!step) return false;
        step(action);
        return true;
      },
      runToCursor: (line) => {
        const run = debugRunToCursorRef.current;
        if (!run) return false;
        run(line);
        return true;
      },
      stop: () => {
        const stop = debugStopRef.current;
        if (!stop) return false;
        stop();
        return true;
      },
    },
    evaluate: evaluating ? (expression) => debugEvaluateRef.current?.(expression) ?? Promise.resolve(null) : null,
  }), []);
  completionTriggersRef.current = completionTriggers ?? [];
  signatureTriggersRef.current = signatureTriggers ?? [];
  columnSelectionModeRef.current = columnSelectionMode;
  parameterInfoShowFullSignaturesRef.current = parameterInfoShowFullSignatures;
  pathRef.current = path;

  const emitSelection = (view: EditorView) => {
    const handler = onSelectionChangeRef.current;
    const foldHandler = onFoldProvenanceChangeRef.current;
    if (!handler && !foldHandler) return;
    const main = view.state.selection.main;
    const from = Math.min(main.from, main.to);
    const to = Math.max(main.from, main.to);
    const previous = lastSelectionRef.current;
    const searchOpen = searchPanelOpen(view.state);
    if (previous?.from === from && previous.to === to && previous.searchOpen === searchOpen) return;
    lastSelectionRef.current = { from, to, searchOpen };
    if (handler) {
      let rect: EditorSelectionRange["rect"] = null;
      // Search owns its own controls. Keep semantic selection consumers current
      // without anchoring the floating selection toolbar over the Find row.
      if (!main.empty && !searchOpen) {
        const startCoords = view.coordsAtPos(from);
        const endCoords = view.coordsAtPos(to);
        if (startCoords && endCoords) {
          rect = {
            top: Math.min(startCoords.top, endCoords.top),
            left: Math.min(startCoords.left, endCoords.left),
            right: Math.max(startCoords.right, endCoords.right),
            bottom: Math.max(startCoords.bottom, endCoords.bottom),
          };
        }
      }
      handler({
        start: lspPositionFromOffset(view.state.doc, from),
        end: lspPositionFromOffset(view.state.doc, to),
        empty: main.empty,
        text: main.empty ? "" : view.state.doc.sliceString(from, to),
        rect,
        userSelected: selectionOriginRef.current !== "other",
      });
    }
    if (foldHandler) {
      const line = view.state.doc.lineAt(from);
      const provenance = detectLineFoldProvenance(view.state, line.number, pathRef.current);
      foldHandler(provenance);
    }
  };

  const emitViewport = (view: EditorView) => {
    onViewportChangeRef.current?.({
      start: lspPositionFromOffset(view.state.doc, view.viewport.from),
      end: lspPositionFromOffset(view.state.doc, view.viewport.to),
    });
  };

  useEffect(function mountEditorHost() {
    if (!hostRef.current) return;
    const owner = transactionOwnerRef.current;
    const sharedFileKey = fileKeyRef.current;
    const sharedViewId = viewIdRef.current;
    const initialDocumentText = owner && sharedFileKey
      ? owner.acquireView(sharedFileKey, sharedViewId, doc, documentRevision)
      : doc;
    lastDocumentTextRef.current = initialDocumentText;
    const initialDoc = EditorState.create({ doc: initialDocumentText }).doc;
    // §8.19.4 resolve gate banner: anchored to the caret at presentation time.
    // The gate request's own closures re-verify identity/doc before acting, so
    // a stale banner is inert — this only decides where it shows.
    const presentResolveGate = (request: CompletionResolveGateRequest) => {
      const view = viewRef.current;
      const coords = view?.coordsAtPos(request.range.from);
      const container = hostRef.current?.getBoundingClientRect();
      if (view && completionStatus(view.state) !== null) closeCompletion(view);
      const id = ++resolveGateSequenceRef.current;
      const gateWidth = Math.min(460, Math.max(0, (container?.width ?? 476) - 16));
      const left = coords && container
        ? Math.max(8, Math.min(coords.left - container.left, container.width - gateWidth - 8))
        : 8;
      const below = coords && container ? coords.bottom - container.top + 4 : 28;
      const top = container && below + 88 > container.height && coords
        ? Math.max(8, coords.top - container.top - 88)
        : below;
      setResolveGateUi({
        id,
        label: request.item.label,
        message: request.message,
        failed: false,
        retrying: false,
        top,
        left,
        retry: request.retry,
        insertWithoutImport: request.insertWithoutImport,
        dismiss: () => {
          request.dismiss();
          setResolveGateUi((gate) => gate?.id === id ? null : gate);
          viewRef.current?.focus();
        },
      });
    };
    presentResolveGateRef.current = presentResolveGate;
    const clearPendingSelectionEmit = () => {
      if (selectionEmitTimerRef.current === null) return;
      window.clearTimeout(selectionEmitTimerRef.current);
      selectionEmitTimerRef.current = null;
    };
    const scheduleSelectionEmit = (view: EditorView, delay = 0) => {
      clearPendingSelectionEmit();
      if (delay === 0) {
        emitSelection(view);
        return;
      }
      selectionEmitTimerRef.current = window.setTimeout(() => {
        selectionEmitTimerRef.current = null;
        if (viewRef.current === view) emitSelection(view);
      }, delay);
    };
    const clearPendingViewportEmit = () => {
      if (viewportEmitTimerRef.current === null) return;
      window.clearTimeout(viewportEmitTimerRef.current);
      viewportEmitTimerRef.current = null;
    };
    const scheduleViewportEmit = (view: EditorView, defer: boolean) => {
      clearPendingViewportEmit();
      if (!defer) {
        emitViewport(view);
        return;
      }
      viewportEmitTimerRef.current = window.setTimeout(() => {
        viewportEmitTimerRef.current = null;
        if (viewRef.current === view) emitViewport(view);
      }, 125);
    };
    // ED-IMPROVE-007: capture is cheap and stays in memory; identical
    // snapshots are dropped so a scroll or caret move does not schedule a
    // persistence write per event.
    const scheduleViewStateEmit = (view: EditorView, delay = 150) => {
      if (!onViewStateChangeRef.current) return;
      if (viewStateEmitTimerRef.current !== null) {
        window.clearTimeout(viewStateEmitTimerRef.current);
      }
      viewStateEmitTimerRef.current = window.setTimeout(() => {
        viewStateEmitTimerRef.current = null;
        if (viewRef.current !== view) return;
        const handler = onViewStateChangeRef.current;
        if (!handler) return;
        const captured = captureEditorViewState(view);
        const serialized = JSON.stringify(captured);
        if (serialized === lastEmittedViewStateRef.current) return;
        lastEmittedViewStateRef.current = serialized;
        handler(captured);
      }, delay);
    };
    const saveHandler = () => {
      onSaveRef.current();
      return true;
    };
    // §8.20.2 W1 single channel: the host only REPORTS trigger events. All
    // request sequencing, delays, supersede and cancellation live in the
    // workspace-side ParameterInfoSession; rendering follows the controlled
    // `parameterPopup` prop via the effect below.
    const emitParameterTrigger = (
      view: EditorView,
      triggerCharacter: string | null,
      origin: "explicit" | "typing",
    ) => {
      const handler = onParameterTriggerRef.current;
      if (!handler) return false;
      const head = view.state.selection.main.head;
      handler({
        position: lspPositionFromOffset(view.state.doc, head),
        anchorOffset: head,
        triggerCharacter,
        origin,
      });
      return true;
    };
    requestParameterInfoRef.current = () => {
      const current = viewRef.current;
      return current ? emitParameterTrigger(current, null, "explicit") : false;
    };
    const openReplacePanel = openWorkspaceReplacePanel;
    const expandSemanticSelection = (view: EditorView) => {
      const handler = onExpandSelectionRef.current;
      if (!handler) return expandSyntaxSelection(view);
      const main = view.state.selection.main;
      const selection: EditorSelectionRange = {
        start: lspPositionFromOffset(view.state.doc, main.from),
        end: lspPositionFromOffset(view.state.doc, main.to),
        empty: main.empty,
        text: main.empty ? "" : view.state.doc.sliceString(main.from, main.to),
        rect: null,
      };
      void handler(selection).then((ranges) => {
        const current = viewRef.current;
        if (!current || current !== view) return;
        if (!ranges || !expandSelectionFromLspRanges(current, ranges)) {
          expandSyntaxSelection(current);
        }
      }).catch(() => {
        const current = viewRef.current;
        if (current === view) expandSyntaxSelection(current);
      });
      return true;
    };
    const state = EditorState.create({
      doc: initialDoc,
      extensions: [
        lineNumbers(),
        foldGutter(),
        // Language-aware region grammar; unknown languages never fold.
        createRegionFoldService(() => pathRef.current),
        foldHoverProvenanceTooltip(() => pathRef.current),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        EditorState.allowMultipleSelections.of(true),
        drawSelection(),
        rectangularSelection({
          eventFilter: (event) =>
            event.button === 0 && (
              columnSelectionModeRef.current
              || event.altKey
              || (event.ctrlKey && event.shiftKey)
            ),
        }),
        crosshairCursor(),
        ...(owner && sharedFileKey ? [] : [history()]),
        // §8.19.8 treeRevision source for semantic-edit evidence envelopes.
        treeRevisionField,
        // §8.19.5 / §8.21.3 Virtual Space: overflow tracking, typing materialization,
        // vertical desired column preservation, and click-past-EOL. The restore
        // field must precede the overflow field (ED-AUDIT-002 undo restore).
        virtualOverflowRestoreField,
        virtualSpaceOverflowField,
        desiredVisualColumnField,
        virtualSpaceTypingHandler,
        virtualSpaceClickHandler,
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        completionCompartment.current.of(buildAutocompletionExtension()),
        // IDEA: typing `.` / `:` (or server trigger chars) opens the popup
        // immediately instead of waiting for activateOnTypingDelay.
        EditorView.updateListener.of((update) => {
          for (const tr of update.transactions) {
            if (!tr.selection) continue;
            selectionOriginRef.current = tr.isUserEvent("select.pointer")
              ? (pointerClickCountRef.current > 1 ? "other" : "pointer")
              // Workspace keyboard actions (virtual-space moves) dispatch without
              // a userEvent; a Shift+navigation keydown marks them as user-made.
              : shiftExtendKeyRef.current && (tr.isUserEvent("select") || !tr.annotation(Transaction.userEvent))
                ? "keyboard"
                : "other";
          }
        }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || update.transactions.every((tr) => !tr.isUserEvent("input.type"))) {
            return;
          }
          if (completionControllerRef.current && !completionControllerRef.current.shouldAutoTrigger(0, false, "trigger")) {
            return;
          }
          const triggers = completionTriggersRef.current;
          if (!triggers.length) return;
          let typedTrigger = false;
          let lastTriggerChar = "";
          update.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
            if (typedTrigger) return;
            const text = inserted.toString();
            if (!text) return;
            const last = text[text.length - 1];
            if (last && triggers.includes(last)) {
              typedTrigger = true;
              lastTriggerChar = last;
            }
          });
          if (typedTrigger) {
            pendingTriggerOriginRef.current = {
              pos: update.view.state.selection.main.head,
              char: lastTriggerChar,
              docLength: update.view.state.doc.length,
            };
            startCompletion(update.view);
          }
        }),
        // §8.19.4: closing the completion popup ends the repeated-Basic-call
        // sequence, so the next explicit invocation is a fresh ordinal-1
        // request. The editor.basicCompletion toggle suppresses this once.
        EditorView.updateListener.of((update) => {
          if (update.docChanged && localRefreshTimerRef.current !== null) {
            window.clearTimeout(localRefreshTimerRef.current);
            localRefreshTimerRef.current = null;
          }
          const previous = completionStatus(update.startState);
          const current = completionStatus(update.state);
          if (previous === current || previous === null || current !== null) return;
          if (localRefreshTimerRef.current !== null) {
            window.clearTimeout(localRefreshTimerRef.current);
            localRefreshTimerRef.current = null;
          }
          pendingTriggerOriginRef.current = null;
          if (basicCompletionReopenRef.current) return;
          const identity = getCompletionIdentityRef.current();
          if (identity) resetBasicCompletionSession(identity.workspaceId, identity.fileKey);
        }),
        search({ top: true, createPanel: (view) => createWorkspaceSearchPanel(view, () => (
          visibleRef.current && activeRef.current !== false ? clipboardOwnerGeneration(view) : null
        )) }),
        selectionHistoryField,
        occurrenceSessionField,
        // Drop pending LSP snippet tabstop sessions on any unrelated edit.
        lspSnippetSessionInvalidator(),
        codeStyleCompartment.current.of([
          EditorState.tabSize.of(codeStyle?.tabSize ?? 2),
          indentUnit.of(codeStyle?.insertSpaces ? " ".repeat(codeStyle?.indentSize || codeStyle?.tabSize || 2) : "\t"),
        ]),
        languageCompartment.current.of([]),
        diagnosticsCompartment.current.of(createDiagnosticChrome(
          diagnostics,
          (line) => onLightbulbRef.current?.(line),
        )),
        overlayCompartment.current.of(createLspOverlayChrome(
          initialDoc,
          highlights,
          inlayHints,
        )),
        semanticTokensCompartment.current.of(createLspSemanticTokenChrome(
          initialDoc,
          semanticTokens,
        )),
        LSP_INTELLIGENCE_THEME,
        // ED-PARITY-022 DEC-022-01: right-edge error stripe (read-only marks).
        createErrorStripe({ diagnostics, gitChanges, usages: highlights }),
        createRunGutter({
          targets: runGutterTargets,
          onClick: (target, anchor) => onRunGutterClickRef.current?.(target, anchor),
        }),
        gitCompartment.current.of(createGitEditorChrome(
          gitChanges,
          gitBlame,
          (change) => onGitChangeClickRef.current?.(change),
        )),
        coverageCompartment.current.of(createCoverageEditorChrome(
          fileCoverage ?? null,
          coverageEnabled,
        )),
        debugCompartment.current.of(buildDebugChrome(
          debugBreakpoints,
          debugCurrentLine,
          debugInlineValues,
          !!debugEvaluate,
        )),
        signatureCompartment.current.of([]),
        hoverCompartment.current.of(lspHoverExtension(
          onHoverRef,
          onPinHoverDocRef,
          activeHoverResizeSessionRef,
          showHoverDocumentation,
          hoverDocumentationDelayMs,
        )),
        readOnlyCompartment.current.of(readOnlyExtension(readOnly)),
        wrappingCompartment.current.of(softWrap ? EditorView.lineWrapping : []),
        appearanceCompartment.current.of(
          appearance ? editorAppearanceExtension(appearance) : [],
        ),
        renderedDocDecorationField,
        renderedDocCompartment.current.of(renderedDocDecorationConfig.of({
          languageId: renderedDocLanguageId ?? liveTemplateLanguageForPath(pathRef.current),
          enabled: renderedDocEnabled,
          onToggleRaw: () => {
            onToggleRenderedDocRawRef.current?.();
            viewRef.current?.focus();
          },
        })),
        ...lspNavigationExtensions(
          onDefinitionRef,
          onReferencesRef,
          () => !!workspaceActionHostRef.current && !workspaceActionHostRef.current.isDisposed(),
        ),
        ...codeViewExtensions(),
        WORKSPACE_EDITOR_STYLE,
        LSP_EDITOR_STYLE,
        WORKSPACE_SEARCH_STYLE,
        RENDERED_DOC_THEME,
        // IDEA-style Tab:
        // 1) Accept the active completion (often a live template).
        // 2) Else expand an exact live/postfix template under the caret
        //    even when the popup is closed (sout + Tab without waiting).
        // 3) Else cycle a choice placeholder's options (§8.18.3 interactive
        //    choice session), else plain LSP snippet tabstops (all snippet
        //    acceptances commit in one transaction and own their session).
        // 4) Else fall through to indentWithTab. The final tabstop exits
        //    with a caret-only move (never an undoable indent), and
        //    Shift-Tab walks back through the stops while the session lives.
        createTemplateKeybindings({ pathRef, getValidActiveProviderCandidate, liveTemplateSourceOptions }),
        keymap.of([
          // §8.19.2 retained primitives: with a host, ONLY the allowlisted
          // set remains here (Escape panel-close stack, closeBrackets typing,
          // defaultKeymap cursor/selection, indentWithTab); every user-visible
          // business binding resolves through the workspace action host.
          ...(buildEditorPrimitiveKeybindings(!!workspaceActionHost) as KeyBinding[]),
          ...(workspaceActionHost
            ? [
                // Esc stays an editor-local primitive stack: completion's own
                // high-precedence binding closes the popup FIRST, then snippet
                // cancel → selection collapse → §8.20.2 parameter kind. The
                // last slot consults the session via ref and returns false
                // when nothing of this kind is open, so Esc never claims a
                // keystroke it did not consume.
                // ED-AUDIT-011: Escape during IME composition cancels the
                // candidate window; workspace snippet/selection/parameter
                // owners must not consume it (callee guards also return false).
                { key: "Escape", run: (view: EditorView) => cancelLspSnippetSession(view) },
                { key: "Escape", run: escapeEditorSelections },
                {
                  key: "Escape",
                  run: (view: EditorView) => {
                    if (view.composing) return false;
                    return onParameterEscapeRef.current?.() ?? false;
                  },
                },
              ]
            : [
                // Transitional unhosted fallback: standalone embedders/tests
                // without an action host keep the pre-R1 inline bindings.
                // Must never grow new entries (see LEGACY_UNHOSTED_SPREAD).
                // Parameter Info is NOT available here — §8.20.2 requires the
                // single controller-owned channel, which needs a session.
                { key: "Mod-s", run: saveHandler },
                { key: "Mod-r", run: openReplacePanel },
                { key: "Mod-w", run: expandSemanticSelection },
              ]),
        ]),
        createEditorDomHandlers({ pointerClickCountRef, shiftExtendKeyRef, onContextMenuRef }),
        createDocumentUpdateListener({ applyingExternalDocRef, lastDocumentTextRef, transactionOwnerRef, fileKeyRef, viewIdRef, currentCompositionSessionRef, compositionActiveRef, viewRef, rememberLocalDocumentEcho, onChangeRef, signatureTriggersRef, emitParameterTrigger, onParameterInvalidateRef, scheduleSelectionEmit, scheduleViewportEmit, viewportEmitTimerRef, restoringInitialViewStateRef, userInteractedSinceMountRef, pendingDeferredScrollRef, scheduleViewStateEmit }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    editorLanguageByView.set(view, liveTemplateLanguageForPath(pathRef.current));
    viewRef.current = view;
    // ED-PARITY-011 DEC-011-07: remember whether the latest key in this view
    // was a Shift+navigation extend. Window capture sees it even when the
    // workspace dispatcher consumes the key before CodeMirror.
    const trackSelectionKey = (event: KeyboardEvent) => {
      if (!(event.target instanceof Node) || !view.dom.contains(event.target)) return;
      if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
      shiftExtendKeyRef.current = event.shiftKey && !event.ctrlKey && !event.metaKey
        && /^(Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown)$/.test(event.key);
    };
    window.addEventListener("keydown", trackSelectionKey, true);
    selectionKeyTrackerCleanupRef.current = () => window.removeEventListener("keydown", trackSelectionKey, true);
    // ED-PARITY-011 DEC-011-06: IDEA folds the import block by default.
    // Imports the user expanded in this leaf stay expanded when it remounts.
    const importFold = importFoldRange(pathRef.current, view.state.doc.toString());
    if (importFold && importFold.to <= view.state.doc.length) {
      importFoldPathByView.set(view, pathRef.current);
      if (initialViewStateRef.current?.importsExpanded !== true) {
        view.dispatch({ effects: foldEffect.of(importFold) });
      }
    }
    const providerRowForEvent = (event: MouseEvent): { row: HTMLLIElement; index: number } | null => {
      if (!pathRef.current.toLowerCase().endsWith(".java") || viewRef.current !== view) return null;
      const row = (event.target as HTMLElement).closest<HTMLLIElement>(
        ".cm-tooltip-autocomplete li.cm-lsp-provider-option[role='option']",
      );
      const list = row?.closest<HTMLUListElement>("ul[role='listbox']");
      if (!row || !list || list.id !== view.contentDOM.getAttribute("aria-controls")) return null;
      const index = [...list.querySelectorAll<HTMLLIElement>("li[role='option']")].indexOf(row);
      return index < 0 ? null : { row, index };
    };
    const selectProviderRow = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const target = providerRowForEvent(event);
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ effects: setSelectedCompletion(target.index) });
      view.focus();
    };
    const acceptProviderRow = (event: MouseEvent) => {
      if (!providerRowForEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      acceptCompletion(view);
    };
    document.addEventListener("mousedown", selectProviderRow, true);
    document.addEventListener("dblclick", acceptProviderRow, true);
    // ED-IMPROVE-007: one-shot restore of this leaf/file's own caret,
    // selection, scroll and folds. Applied before any user input and never
    // re-applied on prop changes, so late updates cannot overwrite typing.
    const initialViewState = initialViewStateRef.current;
    if (initialViewState) {
      restoringInitialViewStateRef.current = true;
      try {
        const restoreResult = applyPersistedEditorViewState(view, initialViewState);
        pendingDeferredScrollRef.current = restoreResult.deferredScroll;
      } finally {
        restoringInitialViewStateRef.current = false;
      }
      view.requestMeasure();
    }
    const cancelDeferredScroll = () => {
      userInteractedSinceMountRef.current = true;
      pendingDeferredScrollRef.current = null;
    };
    view.scrollDOM?.addEventListener("wheel", cancelDeferredScroll, { passive: true });
    view.scrollDOM?.addEventListener("pointerdown", cancelDeferredScroll, { passive: true });
  const disposeComposition = createCompositionLifecycle({
    view,
    compositionActiveRef,
    compositionEndFinalizeRef,
    currentCompositionSessionRef,
    transactionOwnerRef,
    fileKeyRef,
    compositionSessionSeqRef,
    viewIdRef,
    clipboardWorkspaceId,
  });
    // ED-MAIN-007: any focus loss that leaves this view bumps the clipboard
    // owner generation, so an in-flight result can detect that another surface
    // (search box, sibling leaf, other window) claimed focus.
    const clipboardFocusOutGuard = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (
        next && (
          view.contentDOM.contains(next)
          || (next instanceof Element && (next.hasAttribute("data-clipboard-internal-fallback") || (next as HTMLElement).style?.left === "-9999px"))
        )
      ) return;
      bumpClipboardOwnerGeneration(view);
    };
    view.contentDOM.addEventListener("focusout", clipboardFocusOutGuard, true);
    emitSelection(view);
    emitViewport(view);

    // §8.18.2 单一 catalog: with a workspace action host present, the editor's
    // business bindings live as explicit editor.* actions (conflict graph,
    // Search Everywhere and Keymap settings all see them). Without one
    // (isolated usage), the legacy inline bindings below stay active.
    const actionHost = workspaceActionHostRef.current;
    let unregisterEditorActions: (() => void) | null = null;
    let bridgeRegistration: { dispose(): void } | null = null;
    let legacyBridgeRegistration: { dispose(): void } | null = null;
    if (actionHost && !actionHost.isDisposed()) {
      // Handlers close over this mount's view instance; the registration is
      // removed in cleanup so a remount re-binds against the fresh view.
      unregisterEditorActions = actionHost.registerActions(createMountedEditorActions({ openReplacePanel, view, onGoToLineRequestRef, expandSemanticSelection, viewRef, pendingCompletionAcceptanceRef, setResolveGateUi, basicCompletionReopenRef, onParameterEscapeRef, workspaceHistoryClaimRef, transactionOwnerRef, fileKeyRef, viewIdRef, rememberLocalDocumentEcho, onChangeRef }), { ownerViewId: viewId ?? fileKey });
      // §8.19.2 EditorActionBridge: register this mounted view so keyboard
      // dispatch knows the live view set; unmount releases it.
      bridgeRegistration = new EditorActionBridge(actionHost).registerView(sharedViewId);
      // Standalone consumers historically passed fileKey as their dispatch
      // target without a viewId. Keep that alias outside the shared-owner
      // identity path while production split views use the unique id above.
      if (!viewId && fileKey !== sharedViewId) {
        legacyBridgeRegistration = new EditorActionBridge(actionHost).registerView(fileKey);
      }
    }

    return () => {
      document.removeEventListener("mousedown", selectProviderRow, true);
      document.removeEventListener("dblclick", acceptProviderRow, true);
      legacyBridgeRegistration?.dispose();
      bridgeRegistration?.dispose();
      unregisterEditorActions?.();
      clearPendingSelectionEmit();
      clearPendingViewportEmit();
      if (viewStateEmitTimerRef.current !== null) {
        window.clearTimeout(viewStateEmitTimerRef.current);
        viewStateEmitTimerRef.current = null;
      }
      // ED-REPAIR-009: Tail capture on unmount / teardown
      if (viewRef.current === view && onViewStateChangeRef.current) {
        try {
          const captured = captureEditorViewState(view);
          const serialized = JSON.stringify(captured);
          if (serialized !== lastEmittedViewStateRef.current) {
            lastEmittedViewStateRef.current = serialized;
            onViewStateChangeRef.current(captured);
          }
        } catch {
          // view may be in teardown
        }
      }
      view.scrollDOM?.removeEventListener("wheel", cancelDeferredScroll);
      view.scrollDOM?.removeEventListener("pointerdown", cancelDeferredScroll);
      requestParameterInfoRef.current = null;
      cancelActiveHoverResize(activeHoverResizeSessionRef);
      clipboardContextByView.delete(view);
      if (localRefreshTimerRef.current !== null) {
        window.clearTimeout(localRefreshTimerRef.current);
        localRefreshTimerRef.current = null;
      }
      disposeComposition();
      view.contentDOM.removeEventListener("focusout", clipboardFocusOutGuard, true);
      pendingCompletionAcceptanceRef.current?.();
      pendingCompletionAcceptanceRef.current = null;
      selectionKeyTrackerCleanupRef.current?.();
      selectionKeyTrackerCleanupRef.current = null;
      view.destroy();
      viewRef.current = null;
      if (owner && sharedFileKey) owner.releaseView(sharedFileKey, sharedViewId);
    };
  }, []);

  // ED-REPAIR-009: Flush view-state on window unload
  useEffect(() => {
    const handleBeforeUnload = () => {
      const view = viewRef.current;
      if (!view || !onViewStateChangeRef.current) return;
      try {
        const captured = captureEditorViewState(view);
        onViewStateChangeRef.current(captured);
      } catch {
        // ignore
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  const contextClipboardHandle = useWorkspaceClipboardSession();
  const effectiveClipboardHandle = clipboardHandle ?? contextClipboardHandle;

  // §8.17.6/§8.18.4/§8.26.2 AA1: clipboard helpers read the owning workspace
  // handle + unavailable callback through this registry so copy/paste works
  // across split views. The host attaches as a consumer with a lease.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const consumerId = `cm-${fileKey || Math.random().toString(36).slice(2, 9)}`;
    const lease = effectiveClipboardHandle?.attachConsumer(consumerId, "codemirror-host");
    clipboardContextByView.set(view, {
      workspaceId: effectiveClipboardHandle?.workspaceId ?? clipboardWorkspaceId ?? null,
      onUnavailable: (message) => onClipboardUnavailableRef.current(message),
      onObservation: (record) => onClipboardObservationRef.current(record),
      handle: effectiveClipboardHandle ?? null,
      isActive: () => visibleRef.current && (activeRef.current !== false),
    });
    return () => {
      lease?.detach();
      clipboardContextByView.set(view, {
        workspaceId: null,
        onUnavailable: () => {},
        handle: null,
        isActive: () => false,
      });
    };
  }, [effectiveClipboardHandle, clipboardWorkspaceId, fileKey]);

  // ED-MAIN-007 / ED-REPAIR-008: hiding a leaf or switching active group
  // invalidates any in-flight clipboard request owned by it.
  useEffect(() => {
    const view = viewRef.current;
    if (view && (!visible || active === false)) bumpClipboardOwnerGeneration(view);
  }, [visible, active]);

  useEffect(() => {
    if (visible && active !== false) return;
    pendingCompletionAcceptanceRef.current?.();
    setResolveGateUi(null);
  }, [visible, active]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !onCommandPortChange) return;
    const token = {};
    onCommandPortChange({ fileKey, token, port: editorCommandPort(view, () => compositionActiveRef.current) });
    return () => onCommandPortChange({ fileKey, token, port: null });
  }, [fileKey, onCommandPortChange]);

  // ED-REPAIR-007: switching files finalizes any composition belonging to the old fileKey.
  useEffect(() => {
    const session = currentCompositionSessionRef.current;
    if (session && session.fileKey !== fileKey) {
      if (compositionEndFinalizeRef.current !== null) {
        window.clearTimeout(compositionEndFinalizeRef.current);
        compositionEndFinalizeRef.current = null;
      }
      session.status = "finalized";
      try {
        session.owner.finalizeComposition(session.fileKey, session.id);
      } catch {
        // ignore
      }
      currentCompositionSessionRef.current = null;
      compositionActiveRef.current = false;
    }
  }, [fileKey]);
  // §8.19.4: a resolve gate belongs to one buffer identity; switching files
  // drops the banner (the request closures would refuse to act anyway).
  useEffect(() => {
    setResolveGateUi(null);
  }, [fileKey]);

  const { languageCompartment, signatureCompartment, hoverCompartment, requestParameterInfoRef, activeHoverResizeSessionRef } = useEditorIntelligence({
    path,
    viewRef,
    showHoverDocumentation,
    hoverDocumentationDelayMs,
    onHoverRef,
    onPinHoverDocRef,
    parameterInfoRequestNonce,
    parameterPopup,
    parameterInfoShowFullSignaturesRef,
  });
  const { readOnlyCompartment, wrappingCompartment, appearanceCompartment, renderedDocCompartment } = useEditorPresentation({
    viewRef,
    readOnly,
    appearance,
    softWrap,
    renderedDocLanguageId,
    path,
    renderedDocEnabled,
    onToggleRenderedDocRawRef,
  });
  const { codeStyleCompartment, diagnosticsCompartment, coverageCompartment, debugCompartment } = useEditorDecorations({
    viewRef,
    diagnostics,
    onLightbulbRef,
    highlights,
    inlayHints,
    gitChanges,
    onRunGutterClickRef,
    runGutterTargets,
    codeStyle,
    semanticTokens,
    gitBlame,
    onGitChangeClickRef,
    fileCoverage,
    coverageEnabled,
    debugEvaluate,
    debugBreakpoints,
    debugCurrentLine,
    debugInlineValues,
    buildDebugChrome,
  });

  const reconfigureAutocompletion = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const policy = completionControllerRef.current?.getPolicy();
    const autoPopup = policy?.autoPopup ?? true;
    const delayMs = policy?.delayMs ?? 100;
    const maxVisibleItems = policy?.maxVisibleItems ?? 100;
    const docDelayMs = policy?.documentation?.delayMs ?? hoverDocumentationDelayMs ?? 75;

    const prev = renderedCompletionPolicyRef.current;
    if (
      prev &&
      prev.autoPopup === autoPopup &&
      prev.delayMs === delayMs &&
      prev.maxVisibleItems === maxVisibleItems &&
      prev.docDelayMs === docDelayMs
    ) {
      return;
    }
    if (localRefreshTimerRef.current !== null) {
      window.clearTimeout(localRefreshTimerRef.current);
      localRefreshTimerRef.current = null;
    }
    completionPolicyGenerationRef.current += 1;
    lastCollisionFingerprintRef.current = "";
    renderedCompletionPolicyRef.current = { autoPopup, delayMs, maxVisibleItems, docDelayMs };
    view.dispatch({
      effects: completionCompartment.current.reconfigure(buildAutocompletionExtension()),
    });
  }, [buildAutocompletionExtension, hoverDocumentationDelayMs]);

  useEffect(() => {
    reconfigureAutocompletion();
  }, [reconfigureAutocompletion]);

  useEffect(() => {
    if (!completionController) return;
    return completionController.subscribe(() => {
      reconfigureAutocompletion();
    });
  }, [completionController, reconfigureAutocompletion]);
  const { applyingExternalDocRef, lastDocumentTextRef, rememberLocalDocumentEcho } = useDocumentReconciliation({
    transactionOwner,
    fileKey,
    editorViewId,
    viewRef,
    doc,
    documentRevision,
    transactionOwnerRef,
    fileKeyRef,
    viewIdRef,
    historyReplayRef,
  });

  useEffect(() => {
    if (!visible) return;
    viewRef.current?.requestMeasure();
  }, [visible]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !reveal) return;
    const pos = offsetFromLspPosition(view.state.doc, reveal);
    const head = reveal.end ? offsetFromLspPosition(view.state.doc, reveal.end) : pos;
    view.dispatch({
      selection: { anchor: pos, head },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    if (reveal.focus !== false) view.focus();
  }, [reveal]);

  return (
    <div
      ref={hostRef}
      data-soft-wrap={softWrap || undefined}
      data-column-selection={columnSelectionMode || undefined}
      className="relative h-full w-full"
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape") return;
        if (resolveGateUi) {
          event.preventDefault();
          event.stopPropagation();
          resolveGateUi.dismiss();
        } else if (pendingCompletionAcceptanceRef.current) {
          event.preventDefault();
          event.stopPropagation();
          pendingCompletionAcceptanceRef.current();
          viewRef.current?.focus();
        }
      }}
    >
      {resolveGateUi && (
        <div
          data-testid="completion-resolve-gate"
          role="alert"
          className="cm-lsp-resolve-gate absolute z-50 flex max-w-[calc(100%-16px)] flex-wrap items-center gap-2 rounded border border-amber-500/70 bg-[var(--taomni-bg-elevated,#1f2228)] px-2 py-1.5 text-xs shadow-lg"
          style={{ top: resolveGateUi.top, left: resolveGateUi.left, width: "min(460px, calc(100% - 16px))" }}
        >
          <TriangleAlert aria-hidden="true" size={14} className="shrink-0 text-amber-400" />
          <span className="min-w-0 flex-1 break-words" title={`${resolveGateUi.label} - ${resolveGateUi.message}`}>
            <strong className="font-medium">{resolveGateUi.label}</strong>
            {" - "}
            {resolveGateUi.message}
          </span>
          <button
            type="button"
            data-testid="completion-resolve-gate-retry"
            disabled={resolveGateUi.retrying}
            className="shrink-0 rounded border border-[var(--taomni-border,#3a3f4b)] px-1.5 py-0.5 hover:bg-[var(--taomni-hover,#2a2e36)] disabled:opacity-50"
            onClick={() => {
              const id = resolveGateUi.id;
              setResolveGateUi((gate) => gate?.id === id ? { ...gate, retrying: true, failed: false } : gate);
              void resolveGateUi.retry().then((outcome) => {
                if (outcome === "committed") {
                  setResolveGateUi((gate) => gate?.id === id ? null : gate);
                  viewRef.current?.focus();
                  return;
                }
                // Retry also failed: keep the item visible with its choices.
                setResolveGateUi((gate) => gate?.id === id ? { ...gate, retrying: false, failed: true } : gate);
              });
            }}
          >
            Retry
          </button>
          <button
            type="button"
            data-testid="completion-resolve-gate-insert-without-import"
            disabled={resolveGateUi.retrying}
            className="shrink-0 rounded border border-[var(--taomni-border,#3a3f4b)] px-1.5 py-0.5 hover:bg-[var(--taomni-hover,#2a2e36)] disabled:opacity-50"
            onClick={() => {
              const inserted = resolveGateUi.insertWithoutImport();
              if (inserted) {
                const id = resolveGateUi.id;
                setResolveGateUi((gate) => gate?.id === id ? null : gate);
                viewRef.current?.focus();
              }
            }}
          >
            Insert without import
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            title="Dismiss"
            data-testid="completion-resolve-gate-dismiss"
            className="shrink-0 px-1 text-[var(--taomni-text-secondary,#9aa0aa)] hover:text-[var(--taomni-text,#e6e6e6)]"
            onClick={resolveGateUi.dismiss}
          >
            <X aria-hidden="true" size={14} />
          </button>
          {resolveGateUi.failed && (
            <span className="shrink-0 text-red-400" data-testid="completion-resolve-gate-failed-note">
              retry failed
            </span>
          )}
        </div>
      )}
    </div>
  );
}, areCodeMirrorHostPropsEqual);











export { type BreakpointGutterActions,type EditorCommandId,type EditorCommandOptions,type EditorCommandPort,type EditorCommandPortRegistration,type EditorCommandState,type EditorCommandTarget,type EditorContextMenuRequest,type EditorRevealTarget,type EditorSelectionRange,type GoToLineRequest } from "./host/types";











export { applyPersistedEditorViewState,captureEditorViewState,documentTextIdentity,type ApplyPersistedEditorViewStateResult } from "./host/viewState";











export { bumpClipboardOwnerGeneration,watchClipboardRequestFocus } from "./host/clipboard";











export { MAX_PENDING_ECHO_CHARS,MAX_PENDING_ECHO_ENTRIES,trimPendingLocalDocumentEchoes } from "./host/reconciliation";
