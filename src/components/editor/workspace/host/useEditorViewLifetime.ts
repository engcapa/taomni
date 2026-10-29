import { acceptCompletion, closeBrackets, closeCompletion, completionStatus, setSelectedCompletion, startCompletion } from "@codemirror/autocomplete";
import { history } from "@codemirror/commands";
import { bracketMatching, foldEffect, foldGutter, indentOnInput, indentUnit } from "@codemirror/language";
import { search } from "@codemirror/search";
import { EditorState, Text, Transaction } from "@codemirror/state";
import type { KeyBinding } from "@codemirror/view";
import { crosshairCursor, drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, rectangularSelection } from "@codemirror/view";
import { useEffect } from "react";
import { codeViewExtensions } from "../../../../lib/codeViewTheme";
import { createCoverageEditorChrome } from "../coverageEditorChrome";
import { type DebugBreakpointMarker } from "../debugEditorChrome";
import { editorAppearanceExtension } from "../editorAppearanceExtension";
import { createWorkspaceSearchPanel, openWorkspaceReplacePanel, WORKSPACE_SEARCH_STYLE } from "../editorSearchPanel";
import { createErrorStripe } from "../errorStripe";
import { createGitEditorChrome } from "../gitEditorChrome";
import { LSP_EDITOR_STYLE, readOnlyExtension, WORKSPACE_EDITOR_STYLE } from "./appearance";
import { bumpClipboardOwnerGeneration, clipboardContextByView, clipboardOwnerGeneration } from "./clipboard";
import { editorLanguageByView } from "./commands";
import { createCompositionLifecycle } from "./createCompositionLifecycle";
import { createDocumentUpdateListener } from "./createDocumentUpdateListener";
import { createEditorDomHandlers } from "./createEditorDomHandlers";
import { createMountedEditorActions } from "./createMountedEditorActions";
import { createTemplateKeybindings } from "./createTemplateKeybindings";
import { cancelActiveHoverResize, foldHoverProvenanceTooltip, lspHoverExtension, lspNavigationExtensions } from "./intelligence";
import { type EditorSelectionRange } from "./types";
import { applyPersistedEditorViewState, captureEditorViewState, importFoldPathByView } from "./viewState";
import { importFoldRange } from "../importFold";
import { liveTemplateLanguageForPath } from "../liveTemplates";
import { cancelLspSnippetSession, lspSnippetSessionInvalidator, resetBasicCompletionSession, type CompletionResolveGateRequest } from "../lspCompletion";
import { createDiagnosticChrome } from "../lspDiagnosticChrome";
import { createLspOverlayChrome, createLspSemanticTokenChrome, LSP_INTELLIGENCE_THEME } from "../lspIntelligenceChrome";
import { lspPositionFromOffset } from "../lspPositions";
import { RENDERED_DOC_THEME, renderedDocDecorationConfig, renderedDocDecorationField } from "../renderedDocCommentsExtension";
import { createRunGutter } from "../runGutter";
import { EditorActionBridge } from "../workspaceActionHost";
import { buildEditorPrimitiveKeybindings } from "../workspaceCodeMirrorKeymap";
import {
  createRegionFoldService,
  escapeEditorSelections,
  expandSelectionFromLspRanges,
  expandSyntaxSelection,
  occurrenceSessionField,
  selectionHistoryField,
} from "../workspaceEditorCommands";
import { treeRevisionField } from "../workspaceSyntaxFacts";
import { desiredVisualColumnField, virtualOverflowRestoreField, virtualSpaceClickHandler, virtualSpaceOverflowField, virtualSpaceTypingHandler } from "../workspaceVirtualSpace";
import { useEditorHostRefs } from "./useEditorHostRefs";

export interface UseEditorViewLifetimeContext {
  editor: ReturnType<typeof useEditorHostRefs>;
  doc: string;
  documentRevision: number;
  lastDocumentTextRef: import("react").RefObject<string>;
  emitSelection: (view: EditorView) => void;
  emitViewport: (view: EditorView) => void;
  requestParameterInfoRef: import("react").RefObject<(() => boolean) | null>;
  buildAutocompletionExtension: () => import("@codemirror/state").Extension;
  pendingTriggerOriginRef: import("react").RefObject<{ pos: number; char: string; docLength: number; } | null>;
  localRefreshTimerRef: import("react").RefObject<number | null>;
  codeStyleCompartment: import("react").RefObject<import("@codemirror/state").Compartment>;
  codeStyle: import("../codeStyleModel").EffectiveCodeStyle | undefined;
  languageCompartment: import("react").RefObject<import("@codemirror/state").Compartment>;
  diagnosticsCompartment: import("react").RefObject<import("@codemirror/state").Compartment>;
  diagnostics: import("../../../../lib/editor/lsp").LspDiagnostic[];
  highlights: import("../../../../lib/editor/lsp").LspDocumentHighlight[];
  inlayHints: import("../../../../lib/editor/lsp").LspInlayHint[];
  semanticTokens: import("../../../../lib/editor/lsp").LspSemanticToken[];
  gitChanges: import("../gitEditorChrome").GitLineChange[];
  runGutterTargets: import("../runGutter").RunGutterTarget[];
  gitBlame: import("../../../../lib/git").GitBlameLine | null;
  coverageCompartment: import("react").RefObject<import("@codemirror/state").Compartment>;
  fileCoverage: import("../coverageModel").FileCoverage | null | undefined;
  coverageEnabled: boolean;
  debugCompartment: import("react").RefObject<import("@codemirror/state").Compartment>;
  buildDebugChrome: (markers: DebugBreakpointMarker[] | undefined, currentLine: number | null | undefined, inlineValues: Record<string, string> | undefined, evaluating: boolean) => import("@codemirror/state").Extension;
  debugBreakpoints: DebugBreakpointMarker[];
  debugCurrentLine: number | null | undefined;
  debugInlineValues: Record<string, string>;
  debugEvaluate: ((expression: string) => Promise<{ value: string; type: string | null; } | null>) | null | undefined;
  signatureCompartment: import("react").RefObject<import("@codemirror/state").Compartment>;
  hoverCompartment: import("react").RefObject<import("@codemirror/state").Compartment>;
  activeHoverResizeSessionRef: import("react").RefObject<import("../windowResizeSession").WindowResizeSession | null>;
  showHoverDocumentation: boolean;
  hoverDocumentationDelayMs: number;
  readOnlyCompartment: import("react").RefObject<import("@codemirror/state").Compartment>;
  readOnly: boolean;
  wrappingCompartment: import("react").RefObject<import("@codemirror/state").Compartment>;
  softWrap: boolean;
  appearanceCompartment: import("react").RefObject<import("@codemirror/state").Compartment>;
  appearance: import("../editorAppearanceExtension").EditorAppearanceExtensionProfile | undefined;
  renderedDocCompartment: import("react").RefObject<import("@codemirror/state").Compartment>;
  renderedDocLanguageId: string | null | undefined;
  renderedDocEnabled: boolean;
  getValidActiveProviderCandidate: (view: EditorView, language: import("../liveTemplates").LiveTemplateLanguage) => { completion: import("@codemirror/autocomplete").Completion; from: number; to: number; } | null;
  liveTemplateSourceOptions: import("../liveTemplates").LiveTemplateSourceOptions;
  workspaceActionHost: import("../workspaceActionHost").WorkspaceActionHost | null;
  applyingExternalDocRef: import("react").RefObject<boolean>;
  rememberLocalDocumentEcho: (text: string) => void;
  clipboardWorkspaceId: string | undefined;
  viewId: string | undefined;
  fileKey: string;
}

export function useEditorViewLifetime(context: UseEditorViewLifetimeContext) {
  const {
    editor,
    doc,
    documentRevision,
    emitSelection,
    emitViewport,
    buildAutocompletionExtension,
    pendingTriggerOriginRef,
    localRefreshTimerRef,
    codeStyle,
    diagnostics,
    highlights,
    inlayHints,
    semanticTokens,
    gitChanges,
    runGutterTargets,
    gitBlame,
    fileCoverage,
    coverageEnabled,
    buildDebugChrome,
    debugBreakpoints,
    debugCurrentLine,
    debugInlineValues,
    debugEvaluate,
    showHoverDocumentation,
    hoverDocumentationDelayMs,
    readOnly,
    softWrap,
    appearance,
    renderedDocLanguageId,
    renderedDocEnabled,
    getValidActiveProviderCandidate,
    liveTemplateSourceOptions,
    workspaceActionHost,
    clipboardWorkspaceId,
    viewId,
    fileKey,
  } = context;

  useEffect(function mountEditorHost() {
    if (!editor.hostRef.current) return;
    const owner = editor.transactionOwnerRef.current;
    const sharedFileKey = editor.fileKeyRef.current;
    const sharedViewId = editor.viewIdRef.current;
    const initialDocumentText = owner && sharedFileKey
      ? owner.acquireView(sharedFileKey, sharedViewId, doc, documentRevision)
      : doc;
    context.lastDocumentTextRef.current = initialDocumentText;
    const initialDoc = Text.of(initialDocumentText.split("\n"));
    // §8.19.4 resolve gate banner: anchored to the caret at presentation time.
    // The gate request's own closures re-verify identity/doc before acting, so
    // a stale banner is inert — this only decides where it shows.
    const presentResolveGate = (request: CompletionResolveGateRequest) => {
      const view = editor.viewRef.current;
      const coords = view?.coordsAtPos(request.range.from);
      const container = editor.hostRef.current?.getBoundingClientRect();
      if (view && completionStatus(view.state) !== null) closeCompletion(view);
      const id = ++editor.resolveGateSequenceRef.current;
      const gateWidth = Math.min(460, Math.max(0, (container?.width ?? 476) - 16));
      const left = coords && container
        ? Math.max(8, Math.min(coords.left - container.left, container.width - gateWidth - 8))
        : 8;
      const below = coords && container ? coords.bottom - container.top + 4 : 28;
      const top = container && below + 88 > container.height && coords
        ? Math.max(8, coords.top - container.top - 88)
        : below;
      editor.setResolveGateUi({
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
          editor.setResolveGateUi((gate) => gate?.id === id ? null : gate);
          editor.viewRef.current?.focus();
        },
      });
    };
    editor.presentResolveGateRef.current = presentResolveGate;
    const clearPendingSelectionEmit = () => {
      if (editor.selectionEmitTimerRef.current === null) return;
      window.clearTimeout(editor.selectionEmitTimerRef.current);
      editor.selectionEmitTimerRef.current = null;
    };
    const scheduleSelectionEmit = (view: EditorView, delay = 0) => {
      clearPendingSelectionEmit();
      if (delay === 0) {
        emitSelection(view);
        return;
      }
      editor.selectionEmitTimerRef.current = window.setTimeout(() => {
        editor.selectionEmitTimerRef.current = null;
        if (editor.viewRef.current === view) emitSelection(view);
      }, delay);
    };
    const clearPendingViewportEmit = () => {
      if (editor.viewportEmitTimerRef.current === null) return;
      window.clearTimeout(editor.viewportEmitTimerRef.current);
      editor.viewportEmitTimerRef.current = null;
    };
    const scheduleViewportEmit = (view: EditorView, defer: boolean) => {
      clearPendingViewportEmit();
      if (!defer) {
        emitViewport(view);
        return;
      }
      editor.viewportEmitTimerRef.current = window.setTimeout(() => {
        editor.viewportEmitTimerRef.current = null;
        if (editor.viewRef.current === view) emitViewport(view);
      }, 125);
    };
    // ED-IMPROVE-007: capture is cheap and stays in memory; identical
    // snapshots are dropped so a scroll or caret move does not schedule a
    // persistence write per event.
    const scheduleViewStateEmit = (view: EditorView, delay = 150) => {
      if (!editor.onViewStateChangeRef.current) return;
      if (editor.viewStateEmitTimerRef.current !== null) {
        window.clearTimeout(editor.viewStateEmitTimerRef.current);
      }
      editor.viewStateEmitTimerRef.current = window.setTimeout(() => {
        editor.viewStateEmitTimerRef.current = null;
        if (editor.viewRef.current !== view) return;
        const handler = editor.onViewStateChangeRef.current;
        if (!handler) return;
        const captured = captureEditorViewState(view);
        const serialized = JSON.stringify(captured);
        if (serialized === editor.lastEmittedViewStateRef.current) return;
        editor.lastEmittedViewStateRef.current = serialized;
        handler(captured);
      }, delay);
    };
    const saveHandler = () => {
      editor.onSaveRef.current();
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
      const handler = editor.onParameterTriggerRef.current;
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
    context.requestParameterInfoRef.current = () => {
      const current = editor.viewRef.current;
      return current ? emitParameterTrigger(current, null, "explicit") : false;
    };
    const openReplacePanel = openWorkspaceReplacePanel;
    const expandSemanticSelection = (view: EditorView) => {
      const handler = editor.onExpandSelectionRef.current;
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
        const current = editor.viewRef.current;
        if (!current || current !== view) return;
        if (!ranges || !expandSelectionFromLspRanges(current, ranges)) {
          expandSyntaxSelection(current);
        }
      }).catch(() => {
        const current = editor.viewRef.current;
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
        createRegionFoldService(() => editor.pathRef.current),
        foldHoverProvenanceTooltip(() => editor.pathRef.current),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        EditorState.allowMultipleSelections.of(true),
        drawSelection(),
        rectangularSelection({
          eventFilter: (event) =>
            event.button === 0 && (
              editor.columnSelectionModeRef.current
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
        editor.completionCompartment.current.of(buildAutocompletionExtension()),
        // IDEA: typing `.` / `:` (or server trigger chars) opens the popup
        // immediately instead of waiting for activateOnTypingDelay.
        EditorView.updateListener.of((update) => {
          for (const tr of update.transactions) {
            if (!tr.selection) continue;
            editor.selectionOriginRef.current = tr.isUserEvent("select.pointer")
              ? (editor.pointerClickCountRef.current > 1 ? "other" : "pointer")
              // Workspace keyboard actions (virtual-space moves) dispatch without
              // a userEvent; a Shift+navigation keydown marks them as user-made.
              : editor.shiftExtendKeyRef.current && (tr.isUserEvent("select") || !tr.annotation(Transaction.userEvent))
                ? "keyboard"
                : "other";
          }
        }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || update.transactions.every((tr) => !tr.isUserEvent("input.type"))) {
            return;
          }
          if (editor.completionControllerRef.current && !editor.completionControllerRef.current.shouldAutoTrigger(0, false, "trigger")) {
            return;
          }
          const triggers = editor.completionTriggersRef.current;
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
          if (editor.basicCompletionReopenRef.current) return;
          const identity = editor.getCompletionIdentityRef.current();
          if (identity) resetBasicCompletionSession(identity.workspaceId, identity.fileKey);
        }),
        search({
          top: true, createPanel: (view) => createWorkspaceSearchPanel(view, () => (
            editor.visibleRef.current && editor.activeRef.current !== false ? clipboardOwnerGeneration(view) : null
          ))
        }),
        selectionHistoryField,
        occurrenceSessionField,
        // Drop pending LSP snippet tabstop sessions on any unrelated edit.
        lspSnippetSessionInvalidator(),
        context.codeStyleCompartment.current.of([
          EditorState.tabSize.of(codeStyle?.tabSize ?? 2),
          indentUnit.of(codeStyle?.insertSpaces ? " ".repeat(codeStyle?.indentSize || codeStyle?.tabSize || 2) : "\t"),
        ]),
        context.languageCompartment.current.of([]),
        context.diagnosticsCompartment.current.of(createDiagnosticChrome(
          diagnostics,
          (line) => editor.onLightbulbRef.current?.(line),
        )),
        editor.overlayCompartment.current.of(createLspOverlayChrome(
          initialDoc,
          highlights,
          inlayHints,
        )),
        editor.semanticTokensCompartment.current.of(createLspSemanticTokenChrome(
          initialDoc,
          semanticTokens,
        )),
        LSP_INTELLIGENCE_THEME,
        // ED-PARITY-022 DEC-022-01: right-edge error stripe (read-only marks).
        createErrorStripe({ diagnostics, gitChanges, usages: highlights }),
        createRunGutter({
          targets: runGutterTargets,
          onClick: (target, anchor) => editor.onRunGutterClickRef.current?.(target, anchor),
        }),
        editor.gitCompartment.current.of(createGitEditorChrome(
          gitChanges,
          gitBlame,
          (change) => editor.onGitChangeClickRef.current?.(change),
        )),
        context.coverageCompartment.current.of(createCoverageEditorChrome(
          fileCoverage ?? null,
          coverageEnabled,
        )),
        context.debugCompartment.current.of(buildDebugChrome(
          debugBreakpoints,
          debugCurrentLine,
          debugInlineValues,
          !!debugEvaluate,
        )),
        context.signatureCompartment.current.of([]),
        context.hoverCompartment.current.of(lspHoverExtension(
          editor.onHoverRef,
          editor.onPinHoverDocRef,
          context.activeHoverResizeSessionRef,
          showHoverDocumentation,
          hoverDocumentationDelayMs,
        )),
        context.readOnlyCompartment.current.of(readOnlyExtension(readOnly)),
        context.wrappingCompartment.current.of(softWrap ? EditorView.lineWrapping : []),
        context.appearanceCompartment.current.of(
          appearance ? editorAppearanceExtension(appearance) : [],
        ),
        renderedDocDecorationField,
        context.renderedDocCompartment.current.of(renderedDocDecorationConfig.of({
          languageId: renderedDocLanguageId ?? liveTemplateLanguageForPath(editor.pathRef.current),
          enabled: renderedDocEnabled,
          onToggleRaw: () => {
            editor.onToggleRenderedDocRawRef.current?.();
            editor.viewRef.current?.focus();
          },
        })),
        ...lspNavigationExtensions(
          editor.onDefinitionRef,
          editor.onReferencesRef,
          () => !!editor.workspaceActionHostRef.current && !editor.workspaceActionHostRef.current.isDisposed(),
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
        createTemplateKeybindings({ pathRef: editor.pathRef, getValidActiveProviderCandidate, liveTemplateSourceOptions }),
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
                  return editor.onParameterEscapeRef.current?.() ?? false;
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
        createEditorDomHandlers({ pointerClickCountRef: editor.pointerClickCountRef, shiftExtendKeyRef: editor.shiftExtendKeyRef, onContextMenuRef: editor.onContextMenuRef }),
        createDocumentUpdateListener({ applyingExternalDocRef: context.applyingExternalDocRef, lastDocumentTextRef: context.lastDocumentTextRef, transactionOwnerRef: editor.transactionOwnerRef, fileKeyRef: editor.fileKeyRef, viewIdRef: editor.viewIdRef, currentCompositionSessionRef: editor.currentCompositionSessionRef, compositionActiveRef: editor.compositionActiveRef, viewRef: editor.viewRef, rememberLocalDocumentEcho: context.rememberLocalDocumentEcho, onChangeRef: editor.onChangeRef, signatureTriggersRef: editor.signatureTriggersRef, emitParameterTrigger, onParameterInvalidateRef: editor.onParameterInvalidateRef, scheduleSelectionEmit, scheduleViewportEmit, viewportEmitTimerRef: editor.viewportEmitTimerRef, restoringInitialViewStateRef: editor.restoringInitialViewStateRef, userInteractedSinceMountRef: editor.userInteractedSinceMountRef, pendingDeferredScrollRef: editor.pendingDeferredScrollRef, scheduleViewStateEmit }),
      ],
    });
    const view = new EditorView({ state, parent: editor.hostRef.current });
    editorLanguageByView.set(view, liveTemplateLanguageForPath(editor.pathRef.current));
    editor.viewRef.current = view;
    // ED-PARITY-011 DEC-011-07: remember whether the latest key in this view
    // was a Shift+navigation extend. Window capture sees it even when the
    // workspace dispatcher consumes the key before CodeMirror.
    const trackSelectionKey = (event: KeyboardEvent) => {
      if (!(event.target instanceof Node) || !view.dom.contains(event.target)) return;
      if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
      editor.shiftExtendKeyRef.current = event.shiftKey && !event.ctrlKey && !event.metaKey
        && /^(Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown)$/.test(event.key);
    };
    window.addEventListener("keydown", trackSelectionKey, true);
    editor.selectionKeyTrackerCleanupRef.current = () => window.removeEventListener("keydown", trackSelectionKey, true);
    // ED-PARITY-011 DEC-011-06: IDEA folds the import block by default.
    // Imports the user expanded in this leaf stay expanded when it remounts.
    const importFold = importFoldRange(editor.pathRef.current, view.state.doc.toString());
    if (importFold && importFold.to <= view.state.doc.length) {
      importFoldPathByView.set(view, editor.pathRef.current);
      if (editor.initialViewStateRef.current?.importsExpanded !== true) {
        view.dispatch({ effects: foldEffect.of(importFold) });
      }
    }
    const providerRowForEvent = (event: MouseEvent): { row: HTMLLIElement; index: number; } | null => {
      if (!editor.pathRef.current.toLowerCase().endsWith(".java") || editor.viewRef.current !== view) return null;
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
    const initialViewState = editor.initialViewStateRef.current;
    if (initialViewState) {
      editor.restoringInitialViewStateRef.current = true;
      try {
        const restoreResult = applyPersistedEditorViewState(view, initialViewState);
        editor.pendingDeferredScrollRef.current = restoreResult.deferredScroll;
      } finally {
        editor.restoringInitialViewStateRef.current = false;
      }
      view.requestMeasure();
    }
    const cancelDeferredScroll = () => {
      editor.userInteractedSinceMountRef.current = true;
      editor.pendingDeferredScrollRef.current = null;
    };
    view.scrollDOM?.addEventListener("wheel", cancelDeferredScroll, { passive: true });
    view.scrollDOM?.addEventListener("pointerdown", cancelDeferredScroll, { passive: true });
    const disposeComposition = createCompositionLifecycle({
      view,
      compositionActiveRef: editor.compositionActiveRef,
      compositionEndFinalizeRef: editor.compositionEndFinalizeRef,
      currentCompositionSessionRef: editor.currentCompositionSessionRef,
      transactionOwnerRef: editor.transactionOwnerRef,
      fileKeyRef: editor.fileKeyRef,
      compositionSessionSeqRef: editor.compositionSessionSeqRef,
      viewIdRef: editor.viewIdRef,
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
    const actionHost = editor.workspaceActionHostRef.current;
    let unregisterEditorActions: (() => void) | null = null;
    let bridgeRegistration: { dispose(): void; } | null = null;
    let legacyBridgeRegistration: { dispose(): void; } | null = null;
    if (actionHost && !actionHost.isDisposed()) {
      // Handlers close over this mount's view instance; the registration is
      // removed in cleanup so a remount re-binds against the fresh view.
      unregisterEditorActions = actionHost.registerActions(createMountedEditorActions({ openReplacePanel, view, onGoToLineRequestRef: editor.onGoToLineRequestRef, expandSemanticSelection, viewRef: editor.viewRef, pendingCompletionAcceptanceRef: editor.pendingCompletionAcceptanceRef, setResolveGateUi: editor.setResolveGateUi, basicCompletionReopenRef: editor.basicCompletionReopenRef, onParameterEscapeRef: editor.onParameterEscapeRef, workspaceHistoryClaimRef: editor.workspaceHistoryClaimRef, transactionOwnerRef: editor.transactionOwnerRef, fileKeyRef: editor.fileKeyRef, viewIdRef: editor.viewIdRef, rememberLocalDocumentEcho: context.rememberLocalDocumentEcho, onChangeRef: editor.onChangeRef }), { ownerViewId: viewId ?? fileKey });
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
      if (editor.viewStateEmitTimerRef.current !== null) {
        window.clearTimeout(editor.viewStateEmitTimerRef.current);
        editor.viewStateEmitTimerRef.current = null;
      }
      // ED-REPAIR-009: Tail capture on unmount / teardown
      if (editor.viewRef.current === view && editor.onViewStateChangeRef.current) {
        try {
          const captured = captureEditorViewState(view);
          const serialized = JSON.stringify(captured);
          if (serialized !== editor.lastEmittedViewStateRef.current) {
            editor.lastEmittedViewStateRef.current = serialized;
            editor.onViewStateChangeRef.current(captured);
          }
        } catch {
          // view may be in teardown
        }
      }
      view.scrollDOM?.removeEventListener("wheel", cancelDeferredScroll);
      view.scrollDOM?.removeEventListener("pointerdown", cancelDeferredScroll);
      context.requestParameterInfoRef.current = null;
      cancelActiveHoverResize(context.activeHoverResizeSessionRef);
      clipboardContextByView.delete(view);
      if (localRefreshTimerRef.current !== null) {
        window.clearTimeout(localRefreshTimerRef.current);
        localRefreshTimerRef.current = null;
      }
      disposeComposition();
      view.contentDOM.removeEventListener("focusout", clipboardFocusOutGuard, true);
      editor.pendingCompletionAcceptanceRef.current?.();
      editor.pendingCompletionAcceptanceRef.current = null;
      editor.selectionKeyTrackerCleanupRef.current?.();
      editor.selectionKeyTrackerCleanupRef.current = null;
      view.destroy();
      editor.viewRef.current = null;
      if (owner && sharedFileKey) owner.releaseView(sharedFileKey, sharedViewId);
    };
  }, []);
  return {};
}
