import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { importFoldRange } from "./importFold";
import { TriangleAlert, X } from "lucide-react";
import { Compartment, EditorState, Prec, Transaction, type Extension } from "@codemirror/state";
import { remoteTransactionAnnotation, type DocumentChangeDelta } from "./workspaceDocumentTransactionOwner";
import { EditorView, crosshairCursor, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, rectangularSelection, showTooltip } from "@codemirror/view";
import { type WindowResizeSession } from "./windowResizeSession";
import { history } from "@codemirror/commands";
import type { KeyBinding } from "@codemirror/view";
import { acceptCompletion, setSelectedCompletion, autocompletion, closeBrackets, closeCompletion, completionStatus, startCompletion, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { createLiveTemplateCompletionSource, expandLiveTemplateAt, isProviderTemplateSnippet, liveTemplateLanguageForPath, matchLiveTemplateAbbreviation, plainTemplateAbbreviations, type LiveTemplateLanguage, type LiveTemplateSourceOptions } from "./liveTemplates";
import { bracketMatching, foldEffect, foldGutter, indentOnInput, indentUnit, unfoldEffect } from "@codemirror/language";
import { gotoLine, search, searchPanelOpen } from "@codemirror/search";
import { writeText } from "../../../lib/clipboard";
import { codeViewExtensions } from "../../../lib/codeViewTheme";
import { languageForPath } from "../../git/diffLanguage";
import { useWorkspaceClipboardSession } from "./workspaceClipboardSession";
import { type ClipboardObservationRecord } from "./clipboardObservationContract";
import { createWorkspaceSearchPanel, openWorkspaceReplacePanel, WORKSPACE_SEARCH_STYLE } from "./editorSearchPanel";
import { activeLspSnippetChoices, advanceLspSnippetTabstop, cancelLspSnippetSession, cycleLspSnippetChoice, retreatLspSnippetTabstop, createLspCompletionSource, lspSnippetSessionInvalidator, resetBasicCompletionSession, withCompletionAcceptIntent, type CompletionRequestIdentity, type CompletionResolveGateRequest } from "./lspCompletion";
import { createDiagnosticChrome } from "./lspDiagnosticChrome";
import { createErrorStripe, setErrorStripeSources } from "./errorStripe";
import { createRunGutter, setRunGutter, type RunGutterTarget } from "./runGutter";
import { createLspOverlayChrome, createLspSemanticTokenChrome, LSP_INTELLIGENCE_THEME, updateLspOverlayChrome, updateLspSemanticTokenChrome } from "./lspIntelligenceChrome";
import { createGitEditorChrome, updateGitEditorChrome } from "./gitEditorChrome";
import { createDebugEditorChrome, type DebugBreakpointMarker } from "./debugEditorChrome";
import { createCoverageEditorChrome } from "./coverageEditorChrome";
import { editorAppearanceExtension } from "./editorAppearanceExtension";
import { lspPositionFromOffset, offsetFromLspPosition } from "./lspPositions";
import { cutEditorSelections, editorClipboardPayload, escapeEditorSelections, expandSelectionFromLspRanges, expandSyntaxSelection, occurrenceSessionField, pasteEditorClipboardPayload, createRegionFoldService, detectLineFoldProvenance, selectionHistoryField } from "./workspaceEditorCommands";
import { buildEditorHostActions, buildEditorPrimitiveKeybindings } from "./workspaceCodeMirrorKeymap";
import { EditorActionBridge } from "./workspaceActionHost";
import { RENDERED_DOC_THEME, renderedDocDecorationConfig, renderedDocDecorationField } from "./renderedDocCommentsExtension";
import { treeRevisionField } from "./workspaceSyntaxFacts";
import { desiredVisualColumnField, isEditorGeometryReady, virtualOverflowRestoreField, virtualSpaceClickHandler, virtualSpaceOverflowField, virtualSpaceTypingHandler } from "./workspaceVirtualSpace";
import type { WorkspaceActionHost } from "./workspaceActionHost";
import { EMPTY_DIAGNOSTICS, EMPTY_HIGHLIGHTS, EMPTY_INLAY_HINTS, EMPTY_SEMANTIC_TOKENS, EMPTY_GIT_CHANGES, EMPTY_RUN_GUTTER_TARGETS, EMPTY_DEBUG_BREAKPOINTS, EMPTY_DEBUG_INLINE_VALUES, trimPendingLocalDocumentEchoes, sameEditorAppearance, sameArrayOrBothEmpty, sameInlineValues, areCodeMirrorHostPropsEqual } from "./host/reconciliation";
import { type CodeMirrorHostProps, type CompositionSession, type EditorSelectionRange } from "./host/types";
import { positionCompletionInfo, readOnlyExtension, WORKSPACE_EDITOR_STYLE, LSP_EDITOR_STYLE } from "./host/appearance";
import { captureEditorViewState, importFoldPathByView, applyPersistedEditorViewState } from "./host/viewState";
import { foldHoverProvenanceTooltip, lspHoverExtension, lspNavigationExtensions, cancelActiveHoverResize, signatureTooltipDom } from "./host/intelligence";
import { clipboardOwnerGeneration, rememberEditorClipboardPayload, cutSystemClipboard, payloadForSystemClipboardText, writeEditorSelectionToClipboard, pasteSystemClipboard, bumpClipboardOwnerGeneration, clipboardContextByView } from "./host/clipboard";
import { applyDocumentSnapshotToView, applySharedTransactionToView } from "./host/documentSync";
import { editorLanguageByView, isCompositionNavigationKey, editorCommandPort } from "./host/commands";


// CodeMirror uses this only to ignore the key event that opened a popup. It is
// unrelated to how long completion documentation waits before being shown.
const COMPLETION_INTERACTION_DELAY_MS = 75;


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
  const documentRevisionRef = useRef(documentRevision);
  documentRevisionRef.current = documentRevision;
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
  const languageCompartment = useRef(new Compartment());
  const codeStyleCompartment = useRef(new Compartment());
  const diagnosticsCompartment = useRef(new Compartment());
  const overlayCompartment = useRef(new Compartment());
  const semanticTokensCompartment = useRef(new Compartment());
  const gitCompartment = useRef(new Compartment());
  const coverageCompartment = useRef(new Compartment());
  const debugCompartment = useRef(new Compartment());
  const signatureCompartment = useRef(new Compartment());
  const hoverCompartment = useRef(new Compartment());
  const readOnlyCompartment = useRef(new Compartment());
  const wrappingCompartment = useRef(new Compartment());
  const appearanceCompartment = useRef(new Compartment());
  const completionCompartment = useRef(new Compartment());
  const renderedDocCompartment = useRef(new Compartment());
  const presentResolveGateRef = useRef<((request: CompletionResolveGateRequest) => void) | null>(null);
  const pendingCompletionAcceptanceRef = useRef<(() => void) | null>(null);
  const resolveGateSequenceRef = useRef(0);

  interface ActiveProviderTemplateState {
    workspaceId: string;
    fileKey: string;
    documentRevision: number;
    lspSessionGeneration: number;
    from: number;
    to: number;
    items: Map<string, Completion>;
  }

  /**
   * Plain abbreviations the language provider currently offers: jdtls ships the Eclipse
   * Java editor templates as snippet proposals, and those exact IDs win over
   * the app's live templates when valid for the current revision and caret range.
   * Merged per active result, not permanently suppressed across the whole session.
   */
  const currentProviderTemplatesRef = useRef<ActiveProviderTemplateState | null>(null);
  const pendingTriggerOriginRef = useRef<{ pos: number; char: string; docLength: number } | null>(null);

  const completionPolicyGenerationRef = useRef(0);
  const localRefreshTimerRef = useRef<number | null>(null);
  const lastCollisionFingerprintRef = useRef<string>("");
  const activeQueryCounterRef = useRef(0);
  const lastAppliedQueryIdRef = useRef(0);
  const trackedLspSourceRef = useRef<CompletionSource | null>(null);

  const providerOwnedAbbreviations = useCallback(
    (language: LiveTemplateLanguage): ReadonlySet<string> | undefined => {
      if (language !== "java") return undefined;
      const current = currentProviderTemplatesRef.current;
      if (!current) return undefined;
      const identity = getCompletionIdentityRef.current?.();
      if (!identity) return undefined;
      if (
        current.workspaceId !== identity.workspaceId
        || current.fileKey !== identity.fileKey
        || current.documentRevision !== identity.documentRevision
        || current.lspSessionGeneration !== identity.lspSessionGeneration
      ) {
        return undefined;
      }
      const view = viewRef.current;
      if (view) {
        const pos = view.state.selection.main.head;
        if (pos < current.from || pos > current.to) {
          return undefined;
        }
      }
      return new Set(current.items.keys());
    },
    [],
  );

  const liveTemplateSourceOptions = useMemo<LiveTemplateSourceOptions>(
    () => ({ providerOwnedAbbreviations }),
    [providerOwnedAbbreviations],
  );

  const getValidActiveProviderCandidate = useCallback(
    (
      view: EditorView,
      language: LiveTemplateLanguage,
    ): { completion: Completion; from: number; to: number } | null => {
      if (language !== "java") return null;
      const current = currentProviderTemplatesRef.current;
      if (!current) return null;
      const identity = getCompletionIdentityRef.current?.();
      if (!identity) return null;
      if (
        current.workspaceId !== identity.workspaceId
        || current.fileKey !== identity.fileKey
        || current.documentRevision !== identity.documentRevision
        || current.lspSessionGeneration !== identity.lspSessionGeneration
      ) {
        return null;
      }
      const pos = view.state.selection.main.head;
      if (!view.state.selection.main.empty) return null;
      const plain = matchLiveTemplateAbbreviation(view.state.doc, pos, language);
      if (!plain?.exact) return null;
      if (plain.from !== current.from || plain.to !== current.to) return null;
      const candidate = current.items.get(plain.template.abbreviation);
      if (!candidate) return null;
      return { completion: candidate, from: plain.from, to: plain.to };
    },
    [],
  );

  const buildAutocompletionConfig = useCallback(
    (localSource: CompletionSource, lspSource: CompletionSource) => {
      const policy = completionController?.getPolicy();
      const autoPopup = policy?.autoPopup ?? true;
      const delayMs = policy?.delayMs ?? 100;
      const maxVisibleItems = policy?.maxVisibleItems ?? 100;

      return autocompletion({
        activateOnTyping: autoPopup,
        activateOnTypingDelay: delayMs,
        defaultKeymap: true,
        icons: true,
        maxRenderedOptions: maxVisibleItems,
        interactionDelay: COMPLETION_INTERACTION_DELAY_MS,
        positionInfo: positionCompletionInfo,
        optionClass: (completion) => [
          completion.type ? `cm-completion-type-${completion.type}` : "",
          (completion as Completion & { isLspProvider?: boolean }).isLspProvider ? "cm-lsp-provider-option" : "",
        ].filter(Boolean).join(" "),
        override: [localSource, lspSource],
      });
    },
    [completionController, hoverDocumentationDelayMs],
  );

  const scheduleLocalRefresh = useCallback(
    (scope: CompletionRequestIdentity, policyGen: number) => {
      if (localRefreshTimerRef.current !== null) {
        window.clearTimeout(localRefreshTimerRef.current);
        localRefreshTimerRef.current = null;
      }
      localRefreshTimerRef.current = window.setTimeout(() => {
        localRefreshTimerRef.current = null;
        const view = viewRef.current;
        if (!view) return;
        if (completionStatus(view.state) === null) return;
        if (completionPolicyGenerationRef.current !== policyGen) return;
        const identity = getCompletionIdentityRef.current?.();
        if (
          !identity
          || identity.workspaceId !== scope.workspaceId
          || identity.fileKey !== scope.fileKey
          || identity.documentRevision !== scope.documentRevision
          || identity.lspSessionGeneration !== scope.lspSessionGeneration
        ) {
          return;
        }
        const trackedSource = trackedLspSourceRef.current;
        if (!trackedSource) return;

        const newLocalSource = createLiveTemplateCompletionSource(
          () => pathRef.current,
          liveTemplateSourceOptions,
        );
        view.dispatch({
          effects: completionCompartment.current.reconfigure(
            buildAutocompletionConfig(newLocalSource, trackedSource),
          ),
        });
      }, 0);
    },
    [buildAutocompletionConfig, liveTemplateSourceOptions],
  );

  const handleProviderTemplateClaim = useCallback(
    (
      result: CompletionResult | null,
      contextPos: number,
      capturedIdentity: CompletionRequestIdentity,
      capturedPolicyGen: number,
    ): void => {
      const language = liveTemplateLanguageForPath(pathRef.current);
      if (language !== "java") {
        currentProviderTemplatesRef.current = null;
        return;
      }

      if (!result || result.options.length === 0) {
        currentProviderTemplatesRef.current = null;
        const from = result?.from ?? 0;
        const emptyFingerprint = `${capturedIdentity.workspaceId}:${capturedIdentity.fileKey}:${capturedIdentity.documentRevision}:${capturedIdentity.lspSessionGeneration}:${from}:${contextPos}:`;
        if (lastCollisionFingerprintRef.current !== "" && lastCollisionFingerprintRef.current !== emptyFingerprint) {
          lastCollisionFingerprintRef.current = emptyFingerprint;
          scheduleLocalRefresh(capturedIdentity, capturedPolicyGen);
        }
        return;
      }

      const snippets = new Map<string, Completion>();
      for (const option of result.options) {
        if (isProviderTemplateSnippet(option) && option.label) {
          snippets.set(option.label, option);
        }
      }

      if (snippets.size === 0) {
        currentProviderTemplatesRef.current = null;
        const emptyFingerprint = `${capturedIdentity.workspaceId}:${capturedIdentity.fileKey}:${capturedIdentity.documentRevision}:${capturedIdentity.lspSessionGeneration}:${result.from}:${contextPos}:`;
        if (lastCollisionFingerprintRef.current !== "" && lastCollisionFingerprintRef.current !== emptyFingerprint) {
          lastCollisionFingerprintRef.current = emptyFingerprint;
          scheduleLocalRefresh(capturedIdentity, capturedPolicyGen);
        }
        return;
      }

      currentProviderTemplatesRef.current = {
        workspaceId: capturedIdentity.workspaceId,
        fileKey: capturedIdentity.fileKey,
        documentRevision: capturedIdentity.documentRevision,
        lspSessionGeneration: capturedIdentity.lspSessionGeneration,
        from: result.from,
        to: contextPos,
        items: snippets,
      };

      const appAbbreviations = plainTemplateAbbreviations("java");
      const collidingLabels = [...snippets.keys()]
        .filter((label) => appAbbreviations.has(label))
        .sort();

      const fingerprint = `${capturedIdentity.workspaceId}:${capturedIdentity.fileKey}:${capturedIdentity.documentRevision}:${capturedIdentity.lspSessionGeneration}:${result.from}:${contextPos}:${collidingLabels.join(",")}`;

      if (fingerprint === lastCollisionFingerprintRef.current) {
        return;
      }

      const hadPreviousCollisions = lastCollisionFingerprintRef.current !== "" && !lastCollisionFingerprintRef.current.endsWith(":");
      lastCollisionFingerprintRef.current = fingerprint;

      if (collidingLabels.length === 0 && !hadPreviousCollisions) {
        return;
      }

      scheduleLocalRefresh(capturedIdentity, capturedPolicyGen);
    },
    [scheduleLocalRefresh],
  );

  const getOrCreateTrackedLspSource = useCallback(() => {
    if (trackedLspSourceRef.current) {
      return trackedLspSourceRef.current;
    }
    const lspSource = createLspCompletionSource({
      identity: () => getCompletionIdentityRef.current(),
      fetch: (position, trigger, token, invocation) =>
        onCompleteRef.current?.(position, trigger, token, invocation) ?? Promise.resolve(null),
      resolve: (raw, token) =>
        onCompleteResolveRef.current?.(raw, token) ?? Promise.resolve(null),
      triggerCharacters: () => completionTriggersRef.current,
      getDocumentRevision: () => getCompletionIdentityRef.current()?.documentRevision ?? -1,
      reportDiagnostic: (kind, detail) => onCompletionDiagnosticRef.current(kind, detail),
      onScopeFallback: (state) => onScopeFallbackRef.current?.(state),
      onProviderUnavailable: (info) => onCompletionUnavailableRef.current?.(info),
      onResolveGate: (request) => presentResolveGateRef.current?.(request),
      onAcceptancePending: (cancel) => {
        pendingCompletionAcceptanceRef.current?.();
        pendingCompletionAcceptanceRef.current = cancel;
        resolveGateSequenceRef.current += 1;
        setResolveGateUi(null);
      },
      onAcceptanceSettled: (cancel) => {
        if (pendingCompletionAcceptanceRef.current === cancel) {
          pendingCompletionAcceptanceRef.current = null;
        }
      },
      controller: completionControllerRef.current,
      getView: () => viewRef.current,
      consumeTriggerOrigin: (pos, docLength) => {
        const pending = pendingTriggerOriginRef.current;
        if (!pending) return null;
        pendingTriggerOriginRef.current = null;
        if (pending.pos === pos && pending.docLength === docLength) {
          return pending.char;
        }
        return null;
      },
    });

    const trackedLspSource: CompletionSource = async (context: CompletionContext) => {
      const queryId = ++activeQueryCounterRef.current;
      const queryPos = context.pos;
      const capturedIdentity = getCompletionIdentityRef.current?.();
      const capturedPolicyGen = completionPolicyGenerationRef.current;

      const result = await lspSource(context);

      if (context.aborted) {
        return result;
      }
      const view = viewRef.current;
      if (!view) {
        return result;
      }
      if (completionPolicyGenerationRef.current !== capturedPolicyGen) {
        return result;
      }
      if (queryId < lastAppliedQueryIdRef.current) {
        return result;
      }
      lastAppliedQueryIdRef.current = queryId;

      const currentIdentity = getCompletionIdentityRef.current?.();
      if (
        !capturedIdentity
        || !currentIdentity
        || capturedIdentity.workspaceId !== currentIdentity.workspaceId
        || capturedIdentity.fileKey !== currentIdentity.fileKey
        || capturedIdentity.documentRevision !== currentIdentity.documentRevision
        || capturedIdentity.lspSessionGeneration !== currentIdentity.lspSessionGeneration
      ) {
        return result;
      }

      handleProviderTemplateClaim(result, queryPos, capturedIdentity, capturedPolicyGen);
      return result;
    };

    trackedLspSourceRef.current = trackedLspSource;
    return trackedLspSource;
  }, [handleProviderTemplateClaim]);

  const buildAutocompletionExtension = useCallback(() => {
    const trackedSource = getOrCreateTrackedLspSource();
    const localSource = createLiveTemplateCompletionSource(
      () => pathRef.current,
      liveTemplateSourceOptions,
    );
    return buildAutocompletionConfig(localSource, trackedSource);
  }, [buildAutocompletionConfig, getOrCreateTrackedLspSource, liveTemplateSourceOptions]);
  const lastParameterInfoNonceRef = useRef(parameterInfoRequestNonce);
  const requestParameterInfoRef = useRef<(() => boolean) | null>(null);
  const activeHoverResizeSessionRef = useRef<WindowResizeSession | null>(null);
  /** True while applying a prop-driven doc replace so it is not treated as a user edit. */
  const applyingExternalDocRef = useRef(false);
  /** Mirrors the last full text sent through onChange or applied from props. */
  const lastDocumentTextRef = useRef(doc);
  /** Last controlled prop snapshot; distinguishes stale lag from a real reload. */
  const lastPropDocumentTextRef = useRef(doc);
  /** Local snapshots awaiting a controlled-prop echo, oldest first. */
  const pendingLocalDocumentEchoesRef = useRef<Array<{
    text: string;
    expectedDocumentRevision: number;
  }>>([]);
  const lastLocalDocumentRevisionRef = useRef(documentRevision);
  const rememberLocalDocumentEcho = (text: string): void => {
    const expectedDocumentRevision = Math.max(
      documentRevisionRef.current,
      lastLocalDocumentRevisionRef.current,
    ) + 1;
    lastLocalDocumentRevisionRef.current = expectedDocumentRevision;
    const pendingEchoes = pendingLocalDocumentEchoesRef.current;
    const lastPendingEcho = pendingEchoes[pendingEchoes.length - 1];
    if (
      lastPendingEcho?.text !== text
      || lastPendingEcho.expectedDocumentRevision !== expectedDocumentRevision
    ) {
      pendingEchoes.push({ text, expectedDocumentRevision });
      trimPendingLocalDocumentEchoes(pendingEchoes);
    }
  };
  const lastSelectionRef = useRef<{ from: number; to: number; searchOpen: boolean } | null>(null);
  /** Origin of the latest selection change (DEC-011-07). */
  const selectionOriginRef = useRef<"pointer" | "keyboard" | "other">("other");
  const pointerClickCountRef = useRef(1);
  const shiftExtendKeyRef = useRef(false);
  const selectionKeyTrackerCleanupRef = useRef<(() => void) | null>(null);
  const selectionEmitTimerRef = useRef<number | null>(null);
  const viewportEmitTimerRef = useRef<number | null>(null);
  const renderedDiagnosticsRef = useRef(diagnostics);
  const renderedReadOnlyRef = useRef(readOnly);
  const renderedSoftWrapRef = useRef(softWrap);
  const renderedAppearanceRef = useRef(appearance);
  const renderedHoverRef = useRef({
    enabled: showHoverDocumentation,
    delayMs: hoverDocumentationDelayMs,
  });
  const renderedCodeStyleRef = useRef({
    tabSize: codeStyle?.tabSize ?? 2,
    insertSpaces: codeStyle?.insertSpaces ?? true,
    indentSize: codeStyle?.indentSize || (codeStyle?.tabSize ?? 2),
  });
  const renderedCoverageRef = useRef({ fileCoverage, coverageEnabled });
  const renderedOverlayRef = useRef({ highlights, inlayHints });
  const renderedSemanticTokensRef = useRef(semanticTokens);
  const renderedGitRef = useRef({ changes: gitChanges, blame: gitBlame });
  const pendingGitUpdateFrameRef = useRef<number | null>(null);
  const renderedDebugRef = useRef({
    breakpoints: debugBreakpoints,
    currentLine: debugCurrentLine,
    inlineValues: debugInlineValues,
    evaluating: !!debugEvaluate,
  });
  const renderedDocConfigRef = useRef({
    enabled: !!renderedDocEnabled,
    languageId: renderedDocLanguageId ?? liveTemplateLanguageForPath(path),
  });
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

  useEffect(() => {
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
        Prec.high(keymap.of([
          {
            key: "Tab",
            run: (view) => {
              // ED-AUDIT-011: Tab during IME composition selects the candidate.
              if (view.composing || view.state.readOnly) return false;
              if (withCompletionAcceptIntent(view, "replace", () => acceptCompletion(view))) return true;
              const language = liveTemplateLanguageForPath(pathRef.current);
              const providerCandidate = getValidActiveProviderCandidate(view, language);
              if (providerCandidate) {
                const { completion, from, to } = providerCandidate;
                if (typeof completion.apply === "function") {
                  const apply = completion.apply;
                  withCompletionAcceptIntent(view, "replace", () => apply(view, completion, from, to));
                } else if (typeof completion.apply === "string") {
                  view.dispatch({
                    changes: { from, to, insert: completion.apply },
                    selection: { anchor: from + completion.apply.length },
                    userEvent: "input.complete",
                  });
                } else {
                  view.dispatch({
                    changes: { from, to, insert: completion.label },
                    selection: { anchor: from + completion.label.length },
                    userEvent: "input.complete",
                  });
                }
                return true;
              }
              if (expandLiveTemplateAt(view, language, liveTemplateSourceOptions)) return true;
              if (activeLspSnippetChoices(view)) return cycleLspSnippetChoice(view);
              return advanceLspSnippetTabstop(view);
            },
          },
          {
            key: "Shift-Tab",
            run: (view) => {
              // ED-AUDIT-011: Shift-Tab during composition belongs to the IME.
              if (view.composing || view.state.readOnly) return false;
              return retreatLspSnippetTabstop(view);
            },
          },
        ])),
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
        EditorView.domEventHandlers({
          // WebKitGTK's WebDriver pointer path can deliver the editor mouse
          // event without transferring DOM focus from the body. Keep the
          // production pointer entry equivalent to a user click before
          // CodeMirror resolves its selection position.
          mousedown(_event, view) {
            pointerClickCountRef.current = _event.detail || 1;
            shiftExtendKeyRef.current = false;
            if (!view.hasFocus) view.focus();
            return false;
          },
          copy(event, view) {
            const payload = editorClipboardPayload(view.state);
            if (!payload) return false;
            event.preventDefault();
            if (event.clipboardData) {
              event.clipboardData.setData("text/plain", payload.plainText);
              rememberEditorClipboardPayload(view, payload);
            } else {
              void writeText(payload.plainText).then(() => {
                if (view.dom.isConnected) rememberEditorClipboardPayload(view, payload);
              }).catch(() => {});
            }
            return true;
          },
          cut(event, view) {
            if (view.composing || view.state.readOnly) return false;
            const payload = editorClipboardPayload(view.state);
            if (!payload) return false;
            event.preventDefault();
            if (!event.clipboardData) {
              cutSystemClipboard(view);
              return true;
            }
            event.clipboardData.setData("text/plain", payload.plainText);
            rememberEditorClipboardPayload(view, payload);
            return cutEditorSelections(view);
          },
          paste(event, view) {
            if (view.composing || view.state.readOnly) return false;
            const text = event.clipboardData?.getData("text/plain");
            if (text === undefined) return false;
            event.preventDefault();
            return pasteEditorClipboardPayload(view, payloadForSystemClipboardText(view, text));
          },
          contextmenu(event, view) {
            const handler = onContextMenuRef.current;
            if (!handler) return false;
            const coords = { x: event.clientX, y: event.clientY };
            // posAtCoords can be null in headless/jsdom; fall back to caret.
            const pos = view.posAtCoords(coords) ?? view.state.selection.main.head;
            event.preventDefault();
            const clickedSelection = view.state.selection.ranges.find((range) => (
              pos >= range.from && pos <= range.to
            ));
            // Click outside every selection: place the caret there (IDEA-like).
            if (!clickedSelection) {
              view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
            }
            const selection = view.state.selection.main;
            const selectedRanges = view.state.selection.ranges.filter((range) => !range.empty);
            const selectedText = selectedRanges
              .map((range) => view.state.sliceDoc(range.from, range.to))
              .join(view.state.lineBreak);
            const selectionStart = lspPositionFromOffset(
              view.state.doc,
              Math.min(selection.from, selection.to),
            );
            const selectionEnd = lspPositionFromOffset(
              view.state.doc,
              Math.max(selection.from, selection.to),
            );
            handler({
              position: lspPositionFromOffset(view.state.doc, selection.head),
              selectionStart,
              selectionEnd,
              clientX: event.clientX,
              clientY: event.clientY,
              hasSelection: selectedRanges.length > 0,
              selectedText,
              cut: () => cutSystemClipboard(view),
              copy: () => {
                writeEditorSelectionToClipboard(view);
                view.focus();
              },
              paste: () => pasteSystemClipboard(view),
            });
            return true;
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const isRemote = update.transactions.some((tr) => tr.annotation(remoteTransactionAnnotation));
            if (!applyingExternalDocRef.current && !isRemote) {
              // onChange currently carries a full string, so one conversion is
              // unavoidable. Remember it to avoid a second full conversion in
              // the controlled-doc effect after React reflects the change.
              const nextDoc = update.state.doc.toString();
              lastDocumentTextRef.current = nextDoc;
              if (transactionOwnerRef.current && fileKeyRef.current && viewIdRef.current) {
                const deltas: DocumentChangeDelta[] = [];
                update.changes.iterChanges((fromA, toA, _fromB, _toB, insertedText) => {
                  const deleted = update.startState.doc.sliceString(fromA, toA);
                  deltas.push({
                    from: fromA,
                    to: toA,
                    insert: insertedText.toString(),
                    ...(deleted ? { deleted } : {}),
                  });
                });
                if (deltas.length > 0) {
                  let currentSession = currentCompositionSessionRef.current;
                  const compositionTransaction = update.transactions.some((tr) => tr.isUserEvent("input.type.compose"));
                  if (currentSession?.status === "end_pending" && !compositionTransaction
                    && !compositionActiveRef.current && !update.view.composing) {
                    // Ordinary typing can arrive before the finalize timer.
                    // Only CodeMirror's final compose flush extends the old session.
                    currentSession.owner.finalizeComposition(currentSession.fileKey, currentSession.id);
                    currentSession.status = "finalized";
                    currentCompositionSessionRef.current = null;
                    currentSession = null;
                  }
                  const isSessionComposing = currentSession !== null && (
                    currentSession.status === "active" || currentSession.status === "end_pending"
                  );
                  const composingInput = isSessionComposing
                    || compositionActiveRef.current
                    || update.view.composing
                    || compositionTransaction;
                  const sessionId = isSessionComposing ? currentSession?.id : undefined;
                  const isCompletionEdit = update.transactions.some((tr) => tr.isUserEvent("input.complete"));
                  const sharedTransaction = transactionOwnerRef.current.dispatchTransaction(
                    fileKeyRef.current,
                    viewIdRef.current,
                    deltas,
                    composingInput ? "composition" : isCompletionEdit ? "completion" : "user-input",
                    sessionId,
                    isCompletionEdit && !composingInput
                      ? {
                          before: {
                            anchor: update.startState.selection.main.anchor,
                            head: update.startState.selection.main.head,
                          },
                          after: {
                            anchor: update.state.selection.main.anchor,
                            head: update.state.selection.main.head,
                          },
                        }
                      : undefined,
                  );
                  if (!sharedTransaction) {
                    const rejectedView = update.view;
                    const rejectedText = nextDoc;
                    queueMicrotask(() => {
                      const currentView = viewRef.current;
                      const currentOwner = transactionOwnerRef.current;
                      const currentFileKey = fileKeyRef.current;
                      if (
                        currentView !== rejectedView
                        || !currentOwner
                        || !currentFileKey
                        || currentView.state.doc.toString() !== rejectedText
                      ) return;
                      const canonical = currentOwner.getDocument(currentFileKey);
                      if (canonical === null || canonical === rejectedText) return;
                      applyingExternalDocRef.current = true;
                      try {
                        applyDocumentSnapshotToView(currentView, canonical);
                        lastDocumentTextRef.current = currentView.state.doc.toString();
                      } finally {
                        applyingExternalDocRef.current = false;
                      }
                    });
                    return;
                  }
                }
              }
              rememberLocalDocumentEcho(nextDoc);
              onChangeRef.current(
                nextDoc,
                lspPositionFromOffset(update.state.doc, update.state.selection.main.head),
                update.state.selection.main.head,
              );
            }
            let inserted = "";
            update.changes.iterChanges((_fromA, _toA, _fromB, _toB, text) => {
              inserted = text.toString();
            });
            const lastChar = inserted.slice(-1);
            if (
              !applyingExternalDocRef.current
              && !isRemote
              && lastChar
              && signatureTriggersRef.current.includes(lastChar)
            ) {
              emitParameterTrigger(update.view, lastChar, "typing");
            } else if (lastChar === ")" || inserted.includes("\n")) {
              onParameterInvalidateRef.current?.("closing-char");
            } else {
              // §8.20.2: a document change closes the OLD tooltip; the next
              // trigger character opens a fresh request through the session.
              onParameterInvalidateRef.current?.("doc-changed");
            }
          } else if (update.selectionSet) {
            // A cursor move without an edit (mouse click, jump) dismisses it.
            onParameterInvalidateRef.current?.("caret-moved");
          }
          if (update.selectionSet || update.docChanged || searchPanelOpen(update.startState) !== searchPanelOpen(update.state)) {
            // Cursor state fans out into workspace UI and LSP effects. During
            // a text burst, publish the final cursor after a short idle rather
            // than causing a React render for every keypress.
            scheduleSelectionEmit(update.view, update.docChanged ? 125 : 0);
          }
          // Viewport offsets move with the document even when no scrolling
          // occurs. Publishing them synchronously on each key bypasses the
          // text/caret batching and rerenders the entire workspace. Keep the
          // final live range (including a subsequent CodeMirror measure) for
          // inlay hints, while ordinary scrolling still publishes immediately.
          if (update.docChanged || update.viewportChanged) {
            scheduleViewportEmit(update.view, update.docChanged || viewportEmitTimerRef.current !== null);
          }
          if (!restoringInitialViewStateRef.current && (
            update.selectionSet
            || update.docChanged
            || update.transactions.some((tr) => tr.isUserEvent("select") || tr.isUserEvent("input"))
          )) {
            userInteractedSinceMountRef.current = true;
            pendingDeferredScrollRef.current = null;
          }
          if (
            pendingDeferredScrollRef.current
            && !userInteractedSinceMountRef.current
            && update.view.scrollDOM
          ) {
            const dom = update.view.scrollDOM;
            const target = pendingDeferredScrollRef.current;
            const canScrollVertically = target.scrollTop > 0 && dom.scrollHeight > dom.clientHeight;
            const canScrollHorizontally = target.scrollLeft > 0 && dom.scrollWidth > dom.clientWidth;
            if (canScrollVertically || canScrollHorizontally) {
              if (target.scrollTop > 0 && canScrollVertically) {
                const maxScrollTop = Math.max(0, dom.scrollHeight - dom.clientHeight);
                dom.scrollTop = Math.min(target.scrollTop, maxScrollTop);
                target.scrollTop = 0;
              }
              if (target.scrollLeft > 0 && canScrollHorizontally) {
                const maxScrollLeft = Math.max(0, dom.scrollWidth - dom.clientWidth);
                dom.scrollLeft = Math.min(target.scrollLeft, maxScrollLeft);
                target.scrollLeft = 0;
              }
              if (target.scrollTop === 0 && target.scrollLeft === 0) {
                pendingDeferredScrollRef.current = null;
              }
            }
          }
          // ED-IMPROVE-007: capture caret/selection/scroll/fold changes for
          // this leaf/file; persisted later with the layout snapshot.
          if (
            update.selectionSet
            || update.docChanged
            || update.viewportChanged
            || update.transactions.some((tr) => tr.effects.some(
              (effect) => effect.is(foldEffect) || effect.is(unfoldEffect),
            ))
          ) {
            scheduleViewStateEmit(update.view, update.docChanged ? 250 : 150);
          }
        }),
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
    const compositionNavigationGuard = (event: KeyboardEvent) => {
      if (
        (!view.composing && event.isComposing !== true && !compositionActiveRef.current)
        || !isCompositionNavigationKey(event.key)
      ) return;
      // CodeMirror intentionally ignores key handlers during composition, so
      // this capture listener also has to stop the contenteditable default
      // action from moving the caret before the composition is committed.
      event.preventDefault();
    };
    view.contentDOM.addEventListener("keydown", compositionNavigationGuard, true);
    const clearPendingCompositionFinalize = () => {
      if (compositionEndFinalizeRef.current === null) return;
      window.clearTimeout(compositionEndFinalizeRef.current);
      compositionEndFinalizeRef.current = null;
    };
    const finalizeSession = (session: CompositionSession) => {
      if (session.status === "finalized") return;
      session.status = "finalized";
      try {
        session.owner.finalizeComposition(session.fileKey, session.id);
      } catch {
        // ignore
      }
      if (currentCompositionSessionRef.current === session) {
        currentCompositionSessionRef.current = null;
        compositionActiveRef.current = false;
      }
    };
    const compositionStartGuard = () => {
      clearPendingCompositionFinalize();
      const previousSession = currentCompositionSessionRef.current;
      if (previousSession && previousSession.status !== "finalized") {
        finalizeSession(previousSession);
      }
      compositionActiveRef.current = true;
      const currentOwner = transactionOwnerRef.current;
      const currentFileKey = fileKeyRef.current;
      if (currentOwner && currentFileKey) {
        const nextId = `comp_${++compositionSessionSeqRef.current}_${Date.now()}`;
        const newSession: CompositionSession = {
          id: nextId,
          status: "active",
          owner: currentOwner,
          fileKey: currentFileKey,
          viewId: viewIdRef.current,
          workspaceId: clipboardWorkspaceId ?? null,
        };
        currentCompositionSessionRef.current = newSession;
      }
    };
    const compositionEndGuard = () => {
      compositionActiveRef.current = false;
      const session = currentCompositionSessionRef.current;
      if (!session || session.status === "finalized") {
        clearPendingCompositionFinalize();
        return;
      }
      session.status = "end_pending";
      clearPendingCompositionFinalize();
      // ED-MAIN-006 & ED-REPAIR-007:
      // CodeMirror dispatches the final composition change from
      // `Promise.resolve().then(flush)` after compositionend. Defer finalization
      // to the next macrotask so the flush extends this session's entry first.
      compositionEndFinalizeRef.current = window.setTimeout(() => {
        compositionEndFinalizeRef.current = null;
        if (session.status === "end_pending") {
          finalizeSession(session);
        }
      }, 0);
    };
    const compositionBlurGuard = () => {
      // Blur may precede CodeMirror's final microtask flush just like end.
      // Preserve this session until that flush has joined its undo entry.
      compositionEndGuard();
    };
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
    view.contentDOM.addEventListener("compositionstart", compositionStartGuard, true);
    view.contentDOM.addEventListener("compositionend", compositionEndGuard, true);
    view.contentDOM.addEventListener("blur", compositionBlurGuard, true);
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
      unregisterEditorActions = actionHost.registerActions(buildEditorHostActions({
        openReplacePanel: () => openReplacePanel(view),
        // ED-PARITY-012 DEC-012-06: IDEA "Go to Line:Column" dialog.
        openGoToLine: () => {
          const request = onGoToLineRequestRef.current;
          if (!request) return gotoLine(view);
          const head = view.state.selection.main.head;
          const line = view.state.doc.lineAt(head);
          request({
            current: { line: line.number, column: head - line.from + 1 },
            lineCount: view.state.doc.lines,
            apply: (target) => {
              const targetLine = view.state.doc.line(Math.min(target.line, view.state.doc.lines));
              const pos = Math.min(targetLine.from + target.column - 1, targetLine.to);
              view.dispatch({ selection: { anchor: pos }, scrollIntoView: true, userEvent: "select" });
              view.focus();
            },
            cancel: () => view.focus(),
          });
          return true;
        },
        expandSemanticSelection: () => expandSemanticSelection(view),
        // §8.19.4 explicit Basic Completion. With a popup already open at
        // this caret, close + restart so the second explicit call re-runs the
        // source (ordinal ≥ 2 → requestedScope expanded); the reopen flag
        // stops the popup-close listener from resetting the ordinal between
        // the two halves of the toggle.
        startBasicCompletion: () => {
          if (!viewRef.current) return false;
          pendingCompletionAcceptanceRef.current?.();
          setResolveGateUi(null);
          if (completionStatus(view.state) === null) {
            startCompletion(view);
            return true;
          }
          basicCompletionReopenRef.current = true;
          try {
            closeCompletion(view);
            startCompletion(view);
          } finally {
            basicCompletionReopenRef.current = false;
          }
          return true;
        },
        escapeStack: () =>
          cancelLspSnippetSession(view)
          || escapeEditorSelections(view)
          || (onParameterEscapeRef.current?.() ?? false),
        isEditorGeometryReady: () => isEditorGeometryReady(view),
        runEditorCommand: (command) => command(view),
        undo: () => {
          // ED-AUDIT-008: the workspace-edit journal is the newest
          // user-visible history owner; when it can serve this stroke the
          // document ledger must not act on it.
          const claimed = workspaceHistoryClaimRef.current?.("undo");
          if (claimed !== undefined) return claimed;
          const currentOwner = transactionOwnerRef.current;
          if (!currentOwner) return undefined;
          if (view.state.readOnly || view.composing) return false;
          if (currentOwner.getDocument(fileKeyRef.current) !== view.state.doc.toString()) return false;
          const transaction = currentOwner.undo(fileKeyRef.current, viewIdRef.current);
          if (!transaction || !applySharedTransactionToView(view, transaction)) return false;
          rememberLocalDocumentEcho(view.state.doc.toString());
          onChangeRef.current(
            view.state.doc.toString(),
            lspPositionFromOffset(view.state.doc, view.state.selection.main.head),
            view.state.selection.main.head,
          );
          return true;
        },
        redo: () => {
          const claimed = workspaceHistoryClaimRef.current?.("redo");
          if (claimed !== undefined) return claimed;
          const currentOwner = transactionOwnerRef.current;
          if (!currentOwner) return undefined;
          if (view.state.readOnly || view.composing) return false;
          if (currentOwner.getDocument(fileKeyRef.current) !== view.state.doc.toString()) return false;
          const transaction = currentOwner.redo(fileKeyRef.current, viewIdRef.current);
          if (!transaction || !applySharedTransactionToView(view, transaction)) return false;
          rememberLocalDocumentEcho(view.state.doc.toString());
          onChangeRef.current(
            view.state.doc.toString(),
            lspPositionFromOffset(view.state.doc, view.state.selection.main.head),
            view.state.selection.main.head,
          );
          return true;
        },
      }), { ownerViewId: viewId ?? fileKey });
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
      compositionActiveRef.current = false;
      clearPendingCompositionFinalize();
      if (localRefreshTimerRef.current !== null) {
        window.clearTimeout(localRefreshTimerRef.current);
        localRefreshTimerRef.current = null;
      }
      if (currentCompositionSessionRef.current) {
        finalizeSession(currentCompositionSessionRef.current);
      } else if (transactionOwnerRef.current && fileKeyRef.current) {
        transactionOwnerRef.current.finalizeComposition(fileKeyRef.current);
      }
      view.contentDOM.removeEventListener("keydown", compositionNavigationGuard, true);
      view.contentDOM.removeEventListener("compositionstart", compositionStartGuard, true);
      view.contentDOM.removeEventListener("compositionend", compositionEndGuard, true);
      view.contentDOM.removeEventListener("blur", compositionBlurGuard, true);
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

  useEffect(() => {
    let cancelled = false;
    void languageForPath(path)
      .then((language: Extension | null) => {
        if (cancelled || !viewRef.current) return;
        viewRef.current.dispatch({
          effects: languageCompartment.current.reconfigure(language ?? []),
        });
      })
      .catch(() => {
        if (cancelled || !viewRef.current) return;
        viewRef.current.dispatch({
          effects: languageCompartment.current.reconfigure([]),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const previous = renderedHoverRef.current;
    if (
      previous.enabled === showHoverDocumentation
      && previous.delayMs === hoverDocumentationDelayMs
    ) {
      return;
    }
    renderedHoverRef.current = {
      enabled: showHoverDocumentation,
      delayMs: hoverDocumentationDelayMs,
    };
    cancelActiveHoverResize(activeHoverResizeSessionRef);
    view.dispatch({
      effects: hoverCompartment.current.reconfigure(lspHoverExtension(
        onHoverRef,
        onPinHoverDocRef,
        activeHoverResizeSessionRef,
        showHoverDocumentation,
        hoverDocumentationDelayMs,
      )),
    });
  }, [hoverDocumentationDelayMs, showHoverDocumentation]);

  useEffect(() => {
    if (parameterInfoRequestNonce === lastParameterInfoNonceRef.current) return;
    lastParameterInfoNonceRef.current = parameterInfoRequestNonce;
    requestParameterInfoRef.current?.();
  }, [parameterInfoRequestNonce]);

  // §8.20.2 W1: the Parameter Info tooltip is pure display — it renders the
  // session-published view and nothing else. No request sequence lives here.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (!parameterPopup || parameterPopup.signatures.length === 0) {
      window.queueMicrotask(() => {
        const current = viewRef.current;
        if (!current || current !== view) return;
        current.dispatch({ effects: signatureCompartment.current.reconfigure([]) });
      });
      return;
    }
    const pos = Math.min(Math.max(0, parameterPopup.anchorOffset), view.state.doc.length);
    view.dispatch({
      effects: signatureCompartment.current.reconfigure(
        showTooltip.of({
          pos,
          above: true,
          create: () => ({
            dom: signatureTooltipDom(parameterPopup, parameterInfoShowFullSignaturesRef.current),
          }),
        }),
      ),
    });
  }, [parameterPopup]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (renderedReadOnlyRef.current === readOnly) return;
    renderedReadOnlyRef.current = readOnly;
    view.dispatch({ effects: readOnlyCompartment.current.reconfigure(readOnlyExtension(readOnly)) });
  }, [readOnly]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (sameEditorAppearance(renderedAppearanceRef.current, appearance)) return;
    renderedAppearanceRef.current = appearance;
    view.dispatch({
      effects: appearanceCompartment.current.reconfigure(
        appearance ? editorAppearanceExtension(appearance) : [],
      ),
    });
  }, [appearance]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (renderedSoftWrapRef.current === softWrap) return;
    renderedSoftWrapRef.current = softWrap;
    view.dispatch({
      effects: wrappingCompartment.current.reconfigure(softWrap ? EditorView.lineWrapping : []),
    });
  }, [softWrap]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const languageId = renderedDocLanguageId ?? liveTemplateLanguageForPath(path);
    const enabled = !!renderedDocEnabled;
    const previous = renderedDocConfigRef.current;
    if (previous.enabled === enabled && previous.languageId === languageId) return;
    renderedDocConfigRef.current = { enabled, languageId };
    view.dispatch({
      effects: renderedDocCompartment.current.reconfigure(
        renderedDocDecorationConfig.of({
          languageId,
          enabled,
          onToggleRaw: () => {
            onToggleRenderedDocRawRef.current?.();
            viewRef.current?.focus();
          },
        }),
      ),
    });
  }, [path, renderedDocEnabled, renderedDocLanguageId]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (sameArrayOrBothEmpty(renderedDiagnosticsRef.current, diagnostics)) return;
    renderedDiagnosticsRef.current = diagnostics;
    view.dispatch({
      effects: diagnosticsCompartment.current.reconfigure(createDiagnosticChrome(
        diagnostics,
        (line) => onLightbulbRef.current?.(line),
      )),
    });
  }, [diagnostics]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const previous = renderedOverlayRef.current;
    if (
      sameArrayOrBothEmpty(previous.highlights, highlights)
      && sameArrayOrBothEmpty(previous.inlayHints, inlayHints)
    ) {
      return;
    }
    renderedOverlayRef.current = { highlights, inlayHints };
    view.dispatch({
      effects: updateLspOverlayChrome(highlights, inlayHints),
    });
  }, [highlights, inlayHints]);

  // The stripe is secondary chrome: update it after the frame so document and
  // decoration transactions keep their single synchronous dispatch.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const view = viewRef.current;
      if (!view || !view.dom.isConnected) return;
      view.dispatch({
        effects: setErrorStripeSources.of({ diagnostics, gitChanges, usages: highlights }),
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [diagnostics, gitChanges, highlights]);

  const runGutterClick = useCallback(
    (target: RunGutterTarget, anchor: { x: number; y: number }) => onRunGutterClickRef.current?.(target, anchor),
    [],
  );
  const renderedRunGutterRef = useRef(runGutterTargets);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || renderedRunGutterRef.current === runGutterTargets) return;
    renderedRunGutterRef.current = runGutterTargets;
    view.dispatch({ effects: setRunGutter.of({ targets: runGutterTargets, onClick: runGutterClick }) });
  }, [runGutterClick, runGutterTargets]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const tabSize = codeStyle?.tabSize ?? 2;
    const insertSpaces = codeStyle?.insertSpaces ?? true;
    const indentSize = codeStyle?.indentSize || tabSize;
    const prev = renderedCodeStyleRef.current;
    if (prev.tabSize === tabSize && prev.insertSpaces === insertSpaces && prev.indentSize === indentSize) {
      return;
    }
    renderedCodeStyleRef.current = { tabSize, insertSpaces, indentSize };
    view.dispatch({
      effects: codeStyleCompartment.current.reconfigure([
        EditorState.tabSize.of(tabSize),
        indentUnit.of(insertSpaces ? " ".repeat(indentSize) : "\t"),
      ]),
    });
  }, [codeStyle?.tabSize, codeStyle?.indentSize, codeStyle?.insertSpaces]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (sameArrayOrBothEmpty(renderedSemanticTokensRef.current, semanticTokens)) return;
    renderedSemanticTokensRef.current = semanticTokens;
    view.dispatch({
      effects: updateLspSemanticTokenChrome(semanticTokens),
    });
  }, [semanticTokens]);

  useEffect(() => {
    const previous = renderedGitRef.current;
    if (sameArrayOrBothEmpty(previous.changes, gitChanges) && previous.blame === gitBlame) return;
    const frame = window.requestAnimationFrame(() => {
      if (pendingGitUpdateFrameRef.current !== frame) return;
      pendingGitUpdateFrameRef.current = null;
      const view = viewRef.current;
      if (!view || !view.dom.isConnected) return;
      renderedGitRef.current = { changes: gitChanges, blame: gitBlame };
      view.dispatch({
        effects: updateGitEditorChrome(
          gitChanges,
          gitBlame,
          (change) => onGitChangeClickRef.current?.(change),
        ),
      });
    });
    pendingGitUpdateFrameRef.current = frame;
    return () => {
      if (pendingGitUpdateFrameRef.current !== frame) return;
      window.cancelAnimationFrame(frame);
      pendingGitUpdateFrameRef.current = null;
    };
  }, [gitBlame, gitChanges]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const prev = renderedCoverageRef.current;
    if (prev.fileCoverage === fileCoverage && prev.coverageEnabled === coverageEnabled) {
      return;
    }
    renderedCoverageRef.current = { fileCoverage, coverageEnabled };
    view.dispatch({
      effects: coverageCompartment.current.reconfigure(
        createCoverageEditorChrome(fileCoverage ?? null, coverageEnabled),
      ),
    });
  }, [fileCoverage, coverageEnabled]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const previous = renderedDebugRef.current;
    const evaluating = !!debugEvaluate;
    if (
      sameArrayOrBothEmpty(previous.breakpoints ?? [], debugBreakpoints ?? [])
      && previous.currentLine === debugCurrentLine
      && sameInlineValues(previous.inlineValues, debugInlineValues)
      && previous.evaluating === evaluating
    ) {
      return;
    }
    renderedDebugRef.current = {
      breakpoints: debugBreakpoints,
      currentLine: debugCurrentLine,
      inlineValues: debugInlineValues,
      evaluating,
    };
    view.dispatch({
      effects: debugCompartment.current.reconfigure(buildDebugChrome(
        debugBreakpoints,
        debugCurrentLine,
        debugInlineValues,
        evaluating,
      )),
    });
  }, [buildDebugChrome, debugBreakpoints, debugCurrentLine, debugEvaluate, debugInlineValues]);

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

  useEffect(() => {
    const owner = transactionOwner;
    if (!owner || !fileKey) return;

    return owner.subscribe(fileKey, (transaction) => {
      if (transaction.sourceViewId === editorViewId) return;
      const currentView = viewRef.current;
      if (!currentView || !currentView.dom.isConnected) return;
      if (applySharedTransactionToView(currentView, transaction)) {
        lastDocumentTextRef.current = currentView.state.doc.toString();
      }
    });
  }, [transactionOwner, fileKey, editorViewId]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const previousPropDocument = lastPropDocumentTextRef.current;
    lastPropDocumentTextRef.current = doc;
    const pendingEchoes = pendingLocalDocumentEchoesRef.current;
    lastLocalDocumentRevisionRef.current = Math.max(
      lastLocalDocumentRevisionRef.current,
      documentRevision,
    );
    let localEchoIndex = -1;
    for (let index = pendingEchoes.length - 1; index >= 0; index -= 1) {
      const entry = pendingEchoes[index]!;
      if (
        entry.text === doc
        && entry.expectedDocumentRevision === documentRevision
      ) {
        localEchoIndex = index;
        break;
      }
    }
    if (localEchoIndex >= 0) {
      pendingEchoes.splice(0, localEchoIndex + 1);
      // A recognized echo acknowledges an earlier local transaction. During
      // native character-level input, both the view and shared owner may have
      // advanced again before React delivers this prop. Replacing the live
      // document here can corrupt an in-flight CodeMirror change set; a later
      // non-echo snapshot remains responsible for canonical reconciliation.
      lastDocumentTextRef.current = view.state.doc.toString();
      return;
    }
    while (
      pendingEchoes.length > 0
      && pendingEchoes[0]!.expectedDocumentRevision <= documentRevision
    ) {
      pendingEchoes.shift();
    }

    const owner = transactionOwnerRef.current;
    if (owner && fileKeyRef.current) {
      const canonical = owner.getDocument(fileKeyRef.current);
      if (canonical !== null) {
        const currentText = view.state.doc.toString();
        if (doc === canonical) {
          // The controlled snapshot caught up with the shared owner. If a
          // remote transaction raced this effect, repair only the changed
          // range and preserve the view's selection.
          if (currentText !== canonical) {
            applyingExternalDocRef.current = true;
            try {
              applyDocumentSnapshotToView(view, canonical);
            } finally {
              applyingExternalDocRef.current = false;
            }
          }
          lastDocumentTextRef.current = view.state.doc.toString();
          return;
        }
        if (previousPropDocument !== doc) {
          // A changed prop is an external/store snapshot. Make it one shared
          // transaction so every split sees the same replacement and history
          // remains owned by the canonical document. ED-AUDIT-008: a
          // workspace-history restore is journaled at transaction level, so
          // its reconciliation records no second document-ledger entry —
          // otherwise a follow-up Ctrl+Z would re-apply the undone change.
          const transaction = owner.replaceDocument(
            fileKeyRef.current,
            viewIdRef.current,
            doc,
            historyReplayRef.current ? "undo" : "external-disk",
          );
          if (transaction) {
            applySharedTransactionToView(view, transaction);
            lastDocumentTextRef.current = view.state.doc.toString();
            return;
          }
          // replaceDocument declined (no canonical record, or the record
          // already holds this text). Fall through to the direct snapshot
          // apply below so a programmatic store change still reaches this
          // view instead of being swallowed with a stale document.
        }
        if (currentText === canonical || lastDocumentTextRef.current === canonical) {
          // React may still expose the previous store value while a live
          // editor edit is buffered. The shared owner is authoritative.
          lastDocumentTextRef.current = currentText;
          return;
        }
      }
    }

    if (lastDocumentTextRef.current === doc) {
      return;
    }
    applyingExternalDocRef.current = true;
    try {
      applyDocumentSnapshotToView(view, doc);
      lastDocumentTextRef.current = view.state.doc.toString();
    } finally {
      applyingExternalDocRef.current = false;
    }
  }, [doc, documentRevision]);

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

export { type BreakpointGutterActions, type EditorRevealTarget, type GoToLineRequest, type EditorSelectionRange, type EditorContextMenuRequest, type EditorCommandTarget, type EditorCommandId, type EditorCommandOptions, type EditorCommandState, type EditorCommandPort, type EditorCommandPortRegistration } from "./host/types";

export { documentTextIdentity, captureEditorViewState, type ApplyPersistedEditorViewStateResult, applyPersistedEditorViewState } from "./host/viewState";

export { bumpClipboardOwnerGeneration, watchClipboardRequestFocus } from "./host/clipboard";

export { MAX_PENDING_ECHO_CHARS, MAX_PENDING_ECHO_ENTRIES, trimPendingLocalDocumentEchoes } from "./host/reconciliation";
