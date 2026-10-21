import { searchPanelOpen } from "@codemirror/search";
import { EditorView } from "@codemirror/view";
import { memo, useCallback, useEffect } from "react";
import { createDebugEditorChrome, type DebugBreakpointMarker } from "./debugEditorChrome";
import { bumpClipboardOwnerGeneration, clipboardContextByView } from "./host/clipboard";
import { editorCommandPort } from "./host/commands";
import {
  areCodeMirrorHostPropsEqual,
  EMPTY_DEBUG_BREAKPOINTS,
  EMPTY_DEBUG_INLINE_VALUES,
  EMPTY_DIAGNOSTICS,
  EMPTY_GIT_CHANGES,
  EMPTY_HIGHLIGHTS,
  EMPTY_INLAY_HINTS,
  EMPTY_RUN_GUTTER_TARGETS,
  EMPTY_SEMANTIC_TOKENS,
} from "./host/reconciliation";
import { type CodeMirrorHostProps, type EditorSelectionRange } from "./host/types";
import { useDocumentReconciliation } from "./host/useDocumentReconciliation";
import { useEditorDecorations } from "./host/useEditorDecorations";
import { useEditorIntelligence } from "./host/useEditorIntelligence";
import { useEditorPresentation } from "./host/useEditorPresentation";
import { useProviderCompletion } from "./host/useProviderCompletion";
import { captureEditorViewState } from "./host/viewState";
import { lspPositionFromOffset, offsetFromLspPosition } from "./lspPositions";
import { useWorkspaceClipboardSession } from "./workspaceClipboardSession";
import { detectLineFoldProvenance } from "./workspaceEditorCommands";
import { useEditorHostRefs } from "./host/useEditorHostRefs";
import { useEditorViewLifetime } from "./host/useEditorViewLifetime";
import { EditorHostSurface } from "./host/EditorHostSurface";

// CodeMirror uses this only to ignore the key event that opened a popup. It is
// unrelated to how long completion documentation waits before being shown.

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
  const editor = useEditorHostRefs({
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
  });

  /**
   * Build the debug compartment's extensions. Actions read through refs so the
   * extension only has to be rebuilt when what is *rendered* changes; `evaluating`
   * is a flag rather than the callback so a new function identity per render
   * does not churn the editor.
   */
  const {
    buildAutocompletionExtension,
    pendingTriggerOriginRef,
    localRefreshTimerRef,
    getValidActiveProviderCandidate,
    liveTemplateSourceOptions,
    completionPolicyGenerationRef,
    lastCollisionFingerprintRef,
  } = useProviderCompletion({
    getCompletionIdentityRef: editor.getCompletionIdentityRef,
    viewRef: editor.viewRef,
    completionController,
    hoverDocumentationDelayMs,
    pathRef: editor.pathRef,
    completionCompartment: editor.completionCompartment,
    onCompleteRef: editor.onCompleteRef,
    onCompleteResolveRef: editor.onCompleteResolveRef,
    completionTriggersRef: editor.completionTriggersRef,
    onCompletionDiagnosticRef: editor.onCompletionDiagnosticRef,
    onScopeFallbackRef: editor.onScopeFallbackRef,
    onCompletionUnavailableRef: editor.onCompletionUnavailableRef,
    presentResolveGateRef: editor.presentResolveGateRef,
    pendingCompletionAcceptanceRef: editor.pendingCompletionAcceptanceRef,
    resolveGateSequenceRef: editor.resolveGateSequenceRef,
    setResolveGateUi: editor.setResolveGateUi,
    completionControllerRef: editor.completionControllerRef,
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
      toggleBreakpoint: (line) => editor.onToggleBreakpointRef.current?.(line),
      editBreakpoint: (line, anchor) => editor.onEditBreakpointRef.current?.(line, anchor),
      toggleBreakpointEnabled: (line) => editor.breakpointGutterActionsRef.current?.toggleEnabled?.(line),
      addBreakpoint: (line, kind, anchor) => {
        const add = editor.breakpointGutterActionsRef.current?.add;
        if (add) add(line, kind, anchor);
        else editor.onToggleBreakpointRef.current?.(line);
      },
      openGutterMenu: (line, anchor) => {
        const open = editor.breakpointGutterActionsRef.current?.openMenu;
        if (open) open(line, anchor);
        else editor.onEditBreakpointRef.current?.(line, anchor);
      },
      step: (action) => {
        const step = editor.debugStepRef.current;
        if (!step) return false;
        step(action);
        return true;
      },
      runToCursor: (line) => {
        const run = editor.debugRunToCursorRef.current;
        if (!run) return false;
        run(line);
        return true;
      },
      stop: () => {
        const stop = editor.debugStopRef.current;
        if (!stop) return false;
        stop();
        return true;
      },
    },
    evaluate: evaluating ? (expression) => editor.debugEvaluateRef.current?.(expression) ?? Promise.resolve(null) : null,
  }), []);
  editor.completionTriggersRef.current = completionTriggers ?? [];
  editor.signatureTriggersRef.current = signatureTriggers ?? [];
  editor.columnSelectionModeRef.current = columnSelectionMode;
  editor.parameterInfoShowFullSignaturesRef.current = parameterInfoShowFullSignatures;
  editor.pathRef.current = path;

  const emitSelection = (view: EditorView) => {
    const handler = editor.onSelectionChangeRef.current;
    const foldHandler = editor.onFoldProvenanceChangeRef.current;
    if (!handler && !foldHandler) return;
    const main = view.state.selection.main;
    const from = Math.min(main.from, main.to);
    const to = Math.max(main.from, main.to);
    const previous = editor.lastSelectionRef.current;
    const searchOpen = searchPanelOpen(view.state);
    if (previous?.from === from && previous.to === to && previous.searchOpen === searchOpen) return;
    editor.lastSelectionRef.current = { from, to, searchOpen };
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
        userSelected: editor.selectionOriginRef.current !== "other",
      });
    }
    if (foldHandler) {
      const line = view.state.doc.lineAt(from);
      const provenance = detectLineFoldProvenance(view.state, line.number, editor.pathRef.current);
      foldHandler(provenance);
    }
  };

  const emitViewport = (view: EditorView) => {
    editor.onViewportChangeRef.current?.({
      start: lspPositionFromOffset(view.state.doc, view.viewport.from),
      end: lspPositionFromOffset(view.state.doc, view.viewport.to),
    });
  };
  useEditorViewLifetime({
    editor,
    doc,
    documentRevision,
    get lastDocumentTextRef() { return lastDocumentTextRef; },
    emitSelection,
    emitViewport,
    get requestParameterInfoRef() { return requestParameterInfoRef; },
    buildAutocompletionExtension,
    pendingTriggerOriginRef,
    localRefreshTimerRef,
    get codeStyleCompartment() { return codeStyleCompartment; },
    codeStyle,
    get languageCompartment() { return languageCompartment; },
    get diagnosticsCompartment() { return diagnosticsCompartment; },
    diagnostics,
    highlights,
    inlayHints,
    semanticTokens,
    gitChanges,
    runGutterTargets,
    gitBlame,
    get coverageCompartment() { return coverageCompartment; },
    fileCoverage,
    coverageEnabled,
    get debugCompartment() { return debugCompartment; },
    buildDebugChrome,
    debugBreakpoints,
    debugCurrentLine,
    debugInlineValues,
    debugEvaluate,
    get signatureCompartment() { return signatureCompartment; },
    get hoverCompartment() { return hoverCompartment; },
    get activeHoverResizeSessionRef() { return activeHoverResizeSessionRef; },
    showHoverDocumentation,
    hoverDocumentationDelayMs,
    get readOnlyCompartment() { return readOnlyCompartment; },
    readOnly,
    get wrappingCompartment() { return wrappingCompartment; },
    softWrap,
    get appearanceCompartment() { return appearanceCompartment; },
    appearance,
    get renderedDocCompartment() { return renderedDocCompartment; },
    renderedDocLanguageId,
    renderedDocEnabled,
    getValidActiveProviderCandidate,
    liveTemplateSourceOptions,
    workspaceActionHost,
    get applyingExternalDocRef() { return applyingExternalDocRef; },
    get rememberLocalDocumentEcho() { return rememberLocalDocumentEcho; },
    clipboardWorkspaceId,
    viewId,
    fileKey,
  });

  // ED-REPAIR-009: Flush view-state on window unload
  useEffect(() => {
    const handleBeforeUnload = () => {
      const view = editor.viewRef.current;
      if (!view || !editor.onViewStateChangeRef.current) return;
      try {
        const captured = captureEditorViewState(view);
        editor.onViewStateChangeRef.current(captured);
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
    const view = editor.viewRef.current;
    if (!view) return;
    const consumerId = `cm-${fileKey || Math.random().toString(36).slice(2, 9)}`;
    const lease = effectiveClipboardHandle?.attachConsumer(consumerId, "codemirror-host");
    clipboardContextByView.set(view, {
      workspaceId: effectiveClipboardHandle?.workspaceId ?? clipboardWorkspaceId ?? null,
      onUnavailable: (message) => editor.onClipboardUnavailableRef.current(message),
      onObservation: (record) => editor.onClipboardObservationRef.current(record),
      handle: effectiveClipboardHandle ?? null,
      isActive: () => editor.visibleRef.current && (editor.activeRef.current !== false),
    });
    return () => {
      lease?.detach();
      clipboardContextByView.set(view, {
        workspaceId: null,
        onUnavailable: () => { },
        handle: null,
        isActive: () => false,
      });
    };
  }, [effectiveClipboardHandle, clipboardWorkspaceId, fileKey]);

  // ED-MAIN-007 / ED-REPAIR-008: hiding a leaf or switching active group
  // invalidates any in-flight clipboard request owned by it.
  useEffect(() => {
    const view = editor.viewRef.current;
    if (view && (!visible || active === false)) bumpClipboardOwnerGeneration(view);
  }, [visible, active]);

  useEffect(() => {
    if (visible && active !== false) return;
    editor.pendingCompletionAcceptanceRef.current?.();
    editor.setResolveGateUi(null);
  }, [visible, active]);

  useEffect(() => {
    const view = editor.viewRef.current;
    if (!view || !onCommandPortChange) return;
    const token = {};
    onCommandPortChange({ fileKey, token, port: editorCommandPort(view, () => editor.compositionActiveRef.current) });
    return () => onCommandPortChange({ fileKey, token, port: null });
  }, [fileKey, onCommandPortChange]);

  // ED-REPAIR-007: switching files finalizes any composition belonging to the old fileKey.
  useEffect(() => {
    const session = editor.currentCompositionSessionRef.current;
    if (session && session.fileKey !== fileKey) {
      if (editor.compositionEndFinalizeRef.current !== null) {
        window.clearTimeout(editor.compositionEndFinalizeRef.current);
        editor.compositionEndFinalizeRef.current = null;
      }
      session.status = "finalized";
      try {
        session.owner.finalizeComposition(session.fileKey, session.id);
      } catch {
        // ignore
      }
      editor.currentCompositionSessionRef.current = null;
      editor.compositionActiveRef.current = false;
    }
  }, [fileKey]);
  // §8.19.4: a resolve gate belongs to one buffer identity; switching files
  // drops the banner (the request closures would refuse to act anyway).
  useEffect(() => {
    editor.setResolveGateUi(null);
  }, [fileKey]);

  const { languageCompartment, signatureCompartment, hoverCompartment, requestParameterInfoRef, activeHoverResizeSessionRef } = useEditorIntelligence({
    path,
    viewRef: editor.viewRef,
    showHoverDocumentation,
    hoverDocumentationDelayMs,
    onHoverRef: editor.onHoverRef,
    onPinHoverDocRef: editor.onPinHoverDocRef,
    parameterInfoRequestNonce,
    parameterPopup,
    parameterInfoShowFullSignaturesRef: editor.parameterInfoShowFullSignaturesRef,
  });
  const { readOnlyCompartment, wrappingCompartment, appearanceCompartment, renderedDocCompartment } = useEditorPresentation({
    viewRef: editor.viewRef,
    readOnly,
    appearance,
    softWrap,
    renderedDocLanguageId,
    path,
    renderedDocEnabled,
    onToggleRenderedDocRawRef: editor.onToggleRenderedDocRawRef,
  });
  const { codeStyleCompartment, diagnosticsCompartment, coverageCompartment, debugCompartment } = useEditorDecorations({
    viewRef: editor.viewRef,
    diagnostics,
    onLightbulbRef: editor.onLightbulbRef,
    highlights,
    inlayHints,
    gitChanges,
    onRunGutterClickRef: editor.onRunGutterClickRef,
    runGutterTargets,
    codeStyle,
    semanticTokens,
    gitBlame,
    onGitChangeClickRef: editor.onGitChangeClickRef,
    fileCoverage,
    coverageEnabled,
    debugEvaluate,
    debugBreakpoints,
    debugCurrentLine,
    debugInlineValues,
    buildDebugChrome,
  });

  const reconfigureAutocompletion = useCallback(() => {
    const view = editor.viewRef.current;
    if (!view) return;
    const policy = editor.completionControllerRef.current?.getPolicy();
    const autoPopup = policy?.autoPopup ?? true;
    const delayMs = policy?.delayMs ?? 100;
    const maxVisibleItems = policy?.maxVisibleItems ?? 100;
    const docDelayMs = policy?.documentation?.delayMs ?? hoverDocumentationDelayMs ?? 75;

    const prev = editor.renderedCompletionPolicyRef.current;
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
    editor.renderedCompletionPolicyRef.current = { autoPopup, delayMs, maxVisibleItems, docDelayMs };
    view.dispatch({
      effects: editor.completionCompartment.current.reconfigure(buildAutocompletionExtension()),
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
    editorViewId: editor.editorViewId,
    viewRef: editor.viewRef,
    doc,
    documentRevision,
    transactionOwnerRef: editor.transactionOwnerRef,
    fileKeyRef: editor.fileKeyRef,
    viewIdRef: editor.viewIdRef,
    historyReplayRef: editor.historyReplayRef,
  });

  useEffect(() => {
    if (!visible) return;
    editor.viewRef.current?.requestMeasure();
  }, [visible]);

  useEffect(() => {
    const view = editor.viewRef.current;
    if (!view || !reveal) return;
    const pos = offsetFromLspPosition(view.state.doc, reveal);
    const head = reveal.end ? offsetFromLspPosition(view.state.doc, reveal.end) : pos;
    view.dispatch({
      selection: { anchor: pos, head },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    if (reveal.focus !== false) view.focus();
  }, [reveal]);

  return <EditorHostSurface
    editor={editor}
    softWrap={softWrap}
    columnSelectionMode={columnSelectionMode}
  />;
}, areCodeMirrorHostPropsEqual);

export {
  type BreakpointGutterActions,
  type EditorCommandId,
  type EditorCommandOptions,
  type EditorCommandPort,
  type EditorCommandPortRegistration,
  type EditorCommandState,
  type EditorCommandTarget,
  type EditorContextMenuRequest,
  type EditorRevealTarget,
  type EditorSelectionRange,
  type GoToLineRequest,
} from "./host/types";

export { applyPersistedEditorViewState, captureEditorViewState, documentTextIdentity, type ApplyPersistedEditorViewStateResult } from "./host/viewState";

export { bumpClipboardOwnerGeneration, watchClipboardRequestFocus } from "./host/clipboard";

export { MAX_PENDING_ECHO_CHARS, MAX_PENDING_ECHO_ENTRIES, trimPendingLocalDocumentEchoes } from "./host/reconciliation";
