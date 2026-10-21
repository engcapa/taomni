import { useCallback, useEffect, useRef, useState } from "react";
import { lspDocumentSymbols, type LspCodeAction, type LspDiagnostic, type LspDocumentDescriptor, type LspDocumentSymbol, type LspRange, type LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import { type BottomDockTabId } from "../../../../stores/codeWorkspaceStore";
import { promptAppDialog } from "../../../../lib/appDialogs";
import { type EditorSelectionRange } from "../host/types";
import { EditorView } from "@codemirror/view";
import { showInlineRenameMarks } from "../inlineRename";
import { readRefactorOptionsMode } from "../refactorOptions";
import { IntentionSession } from "../intentionSession";
import { type ReferencesResultState } from "../panels/ReferencesPanel";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { type LspFileState, type OpenFileState } from "../codeWorkspaceModel";
import { type WorkspaceSemanticIndexBuildToken } from "../workspaceSemanticIndex";
import { extractBufferMatches, extractReceiptMatches, type ExtractOwnerSnapshot, type ExtractReceipt, type ExtractSession } from "../extractMethodFlow";
import { createRenameSymbolAt, createContinueExtractNaming, createRunExtractMethod, createSafeDeleteSymbolAtCursor } from "../controller/refactorActions";
import { type ExtractSessionState, type ExtractNamingPromptState, type InlineRenameRequest, type InlineNameResult } from "../controller/model";
import { type WorkspaceEditApplyOptions } from "../controller/mutationTypes";
import { createPromptInlineName } from "../controller/editorMenus";

export interface UseSymbolRefactoringContext {
  rootRef: import("react").RefObject<HTMLDivElement | null>;
  activeEditorGroupIdRef: import("react").RefObject<string>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  activeKey: string | null;
  semanticIndex: import("../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
  setStatusMessage: (message: string) => void;
  ensureWorkspaceSemanticDocumentsSynced: (requiredFileKey: string, expectedRevision: number) => Promise<OpenFileState | null>;
  updateLspStatusForFile: (file: OpenFileState, status: import("../../../../lib/editor/lsp").LspDocumentStatus) => void;
  lspSessionGeneration: () => number;
  projectAnalysisSnapshot: import("../projectAnalysisModel").JavaProjectAnalysisSnapshotV1 | null;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  buildPlanOpenFiles: () => Record<string, { documentRevision?: number; revision?: number; canonicalPath?: string; dirty?: boolean; library?: unknown; }>;
  applyLspWorkspaceEdit: (edit: LspWorkspaceEdit, options?: WorkspaceEditApplyOptions) => Promise<import("../workspaceEditApply").WorkspaceEditApplyOutcome[]>;
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  renameSymbolRef: import("react").RefObject<() => Promise<void>>;
  workspaceInstanceId: string;
  revealNavLocation: (key: string, position: { line: number; character: number; }) => void;
  intentionRequestAbortRef: import("react").RefObject<AbortController | null>;
  requestCodeActions: (file: OpenFileState, range: LspRange, diagnostics?: LspDiagnostic[], only?: string[], options?: { signal?: AbortSignal; allowCapabilityFallback?: boolean; }) => Promise<{ actions: LspCodeAction[]; providerActions: readonly import("../codeActionProviderAdapter").ProviderActionV4[]; context: import("../codeActionProviderAdapter").CodeActionContextIdentity | null; semanticToken: WorkspaceSemanticIndexBuildToken | null; requestFailure: { kind: "stale" | "sync-pending" | "descriptor-missing" | "failed" | "provider"; message: string; } | null; }>;
  editorPaneRef: import("react").RefObject<HTMLElement | null>;
  showCodeActionsMenu: (clientX: number, clientY: number, file: OpenFileState, range: LspRange, diagnostics?: LspDiagnostic[], only?: string[], sectionLabel?: string, anchor?: { clientX: number; clientY: number; }, prefetched?: { providerActions: readonly import("../codeActionProviderAdapter").ProviderActionV4[]; context: import("../codeActionProviderAdapter").CodeActionContextIdentity; semanticToken: WorkspaceSemanticIndexBuildToken | null; }) => Promise<void>;
  intentionSessionRef: import("react").RefObject<IntentionSession | null>;
  runCodeAction: (action: LspCodeAction, file: OpenFileState, semanticToken?: WorkspaceSemanticIndexBuildToken | null, intentionCandidateId?: string, intentionContext?: import("../codeActionProviderAdapter").CodeActionContextIdentity, receiptSessionId?: string) => Promise<{ ok: boolean; message: string | null; retryable: boolean; appliedReceipt?: ExtractReceipt; }>;
  runExtractMethodRef: import("react").RefObject<() => Promise<void>>;
  referencesRequestSequenceRef: import("react").RefObject<number>;
  setBottomDockOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setBottomDockTab: (tab: BottomDockTabId | ((prev: BottomDockTabId) => BottomDockTabId)) => void;
  setReferencesResult: import("react").Dispatch<import("react").SetStateAction<ReferencesResultState>>;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  safeDeleteSymbolRef: import("react").RefObject<() => Promise<void>>;
}

export function useSymbolRefactoring(context: UseSymbolRefactoringContext) {
  const {
    rootRef,
    activeEditorGroupIdRef,
    openFilesRef,
    lspDescriptorForFile,
    lspFilesRef,
    activeKey,
    semanticIndex,
    setStatusMessage,
    ensureWorkspaceSemanticDocumentsSynced,
    updateLspStatusForFile,
    lspSessionGeneration,
    projectAnalysisSnapshot,
    rootsRef,
    buildPlanOpenFiles,
    applyLspWorkspaceEdit,
    activeFile,
    editorSelectionRef,
    renameSymbolRef,
    workspaceInstanceId,
    revealNavLocation,
    intentionRequestAbortRef,
    requestCodeActions,
    editorPaneRef,
    showCodeActionsMenu,
    intentionSessionRef,
    runCodeAction,
    runExtractMethodRef,
    referencesRequestSequenceRef,
    setBottomDockOpen,
    setBottomDockTab,
    setReferencesResult,
    absolutePathForOpenFile,
    safeDeleteSymbolRef,
  } = context;
  const extractSessionRef = useRef<ExtractSessionState | null>(null);
  const beginExtractSessionRef = useRef<((input: {
      file: OpenFileState;
      range: LspRange;
      uri: string;
      beforeSymbols: LspDocumentSymbol[] | null;
    }) => ExtractSessionState | null) | null>(null);
  const continueExtractNamingRef = useRef<((receipt: ExtractReceipt) => Promise<void>) | null>(null);
  const captureMethodSymbolsRef = useRef<((file: OpenFileState) => Promise<LspDocumentSymbol[] | null>) | null>(null);
  const finishExtractSessionRef = useRef<((session: ExtractSessionState) => void) | null>(null);
  const [extractNamingPrompt, setExtractNamingPrompt] = useState<ExtractNamingPromptState | null>(null);
  const extractNamingPromptRef = useRef<ExtractNamingPromptState | null>(null);
  extractNamingPromptRef.current = extractNamingPrompt;

  // ---------------------------------------------------------------------------
  // ED-PARITY-017 DEC-017-01..04: in-place naming for Rename / Extract Method
  // ---------------------------------------------------------------------------
  const [inlineRename, setInlineRename] = useState<InlineRenameRequest | null>(null);
  const inlineRenameRef = useRef<InlineRenameRequest | null>(null);
  const [refactorModalOptions, setRefactorModalOptions] = useState(() => readRefactorOptionsMode() === "dialog");

  const finishInlineRename = useCallback((request: InlineRenameRequest, result: InlineNameResult) => {
    if (inlineRenameRef.current !== request) return;
    inlineRenameRef.current = null;
    setInlineRename(null);
    try {
      showInlineRenameMarks(request.view, null);
    } catch {
      // The view may already be destroyed (tab closed during the session).
    }
    // Focus returns to the editor at the untouched caret (DEC-017-03).
    if (request.view.dom.isConnected) request.view.focus();
    request.resolve(result);
  }, []);

  const activeEditorViewFor = useCallback((fileKey: string): EditorView | null => {
    const root = rootRef.current;
    const groupId = activeEditorGroupIdRef.current;
    const host = root?.querySelector<HTMLElement>(
      `[data-testid="code-workspace-editor-pane"][data-editor-group-id="${CSS.escape(groupId)}"] [data-testid="code-workspace-editor"] .cm-editor`,
    );
    const view = host ? EditorView.findFromDOM(host) : null;
    const live = openFilesRef.current[fileKey];
    if (!view || !live || view.state.doc.toString() !== live.text) return null;
    return view;
  }, []);

  /**
   * Open the in-place naming session over `range`. Resolves `dialog` when the
   * editor view cannot host it (no view, moved document) so the caller falls
   * back to the modal prompt instead of silently doing nothing.
   */
  const promptInlineName = useCallback(createPromptInlineName({
    activeEditorViewFor,
    inlineRenameRef,
    finishInlineRename,
    openFilesRef,
    lspDescriptorForFile,
    setRefactorModalOptions,
    setInlineRename,
    lspFilesRef,
  }), [activeEditorViewFor, finishInlineRename, lspDescriptorForFile]);

  // The session belongs to one editor document; switching files ends it.
  useEffect(() => {
    const request = inlineRenameRef.current;
    if (request && request.fileKey !== activeKey) finishInlineRename(request, { kind: "cancel" });
  }, [activeKey, finishInlineRename]);

  /** DEC-017-01: in-place naming by default, the modal prompt as the option / fallback. */
  const promptSymbolName = useCallback(async (input: {
    file: OpenFileState;
    kind: "rename" | "extract";
    range: LspRange | null;
    defaultName: string;
    initialValue?: string;
    error?: string | null;
    dialog: (initialValue: string) => Promise<string | null>;
  }): Promise<string | null> => {
    if (readRefactorOptionsMode() === "dialog" || !input.range) {
      return input.dialog(input.initialValue ?? input.defaultName);
    }
    const result = await promptInlineName({
      fileKey: input.file.key,
      kind: input.kind,
      range: input.range,
      defaultName: input.defaultName,
      initialValue: input.initialValue,
      error: input.error,
    });
    if (result.kind === "commit") return result.name;
    if (result.kind === "dialog") return input.dialog(result.value);
    return null;
  }, [promptInlineName]);

  // "The workspace changed" alone cannot separate a genuine concurrent edit
  // from a watcher echo of the provider's own project metadata
  // (.project/.classpath/.settings) arriving during a rename. Name it.
  const describeSemanticInvalidation = useCallback((
    snapshot: ReturnType<typeof semanticIndex.current>,
    tokenRevision: number,
  ): string => [
    snapshot.staleReasons.length > 0 ? `reasons=${snapshot.staleReasons.join(",")}` : null,
    snapshot.invalidatedPaths.length > 0
      ? `paths=${snapshot.invalidatedPaths.slice(0, 3).join(",")}`
      : null,
    `revision=${snapshot.revision}/${tokenRevision}`,
  ].filter(Boolean).join(" "), []);

  const renameSymbolAt = useCallback(createRenameSymbolAt({
    lspFilesRef,
    setStatusMessage,
    semanticIndex,
    ensureWorkspaceSemanticDocumentsSynced,
    lspDescriptorForFile,
    updateLspStatusForFile,
    promptSymbolName,
    describeSemanticInvalidation,
    lspSessionGeneration,
    projectAnalysisSnapshot,
    rootsRef,
    buildPlanOpenFiles,
    applyLspWorkspaceEdit,
  }), [
    applyLspWorkspaceEdit,
    ensureWorkspaceSemanticDocumentsSynced,
    lspDescriptorForFile,
    promptSymbolName,
    semanticIndex.beginBuild,
    semanticIndex.abandonBuild,
    semanticIndex.failBuild,
    semanticIndex.finishQuery,
    semanticIndex.current,
    setStatusMessage,
    updateLspStatusForFile,
  ]);

  const renameSymbolAtCursor = useCallback(async () => {
    const file = activeFile;
    if (!file || file.loading) return;
    const position = editorSelectionRef.current.start;
    if (readRefactorOptionsMode() === "dialog") {
      await renameSymbolAt(file, position);
      return;
    }
    // DEC-017-03: a provider rejection reopens the in-place session with the
    // rejected name and the real error, so the user can correct and retry
    // without anything having been written.
    let retry: { value: string; error: string } | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let submitted: string | null = null;
      const carried: { value: string; error: string } | null = retry;
      const live = openFilesRef.current[file.key] ?? file;
      const outcome = await renameSymbolAt(live, position, {
        promptName: async (defaultName, range) => {
          submitted = await promptSymbolName({
            file: live,
            kind: "rename",
            range,
            defaultName,
            initialValue: carried?.value,
            error: carried?.error,
            dialog: (initialValue) => promptAppDialog({
              title: "Rename Symbol",
              label: "New name",
              initialValue,
              confirmLabel: "Rename",
            }),
          });
          return submitted;
        },
      });
      if (outcome.status !== "failed" || !outcome.retryable || !submitted) return;
      retry = { value: submitted, error: outcome.message ?? "Rename failed" };
    }
  }, [activeFile, promptSymbolName, renameSymbolAt]);
  renameSymbolRef.current = renameSymbolAtCursor;

  // ---------------------------------------------------------------------------
  // ED-PARITY-007 DEC-02/03/05/06/07: direct Extract Method transaction
  // ---------------------------------------------------------------------------
  const extractLiveUri = useCallback((fileKey: string): string => {
    const live = openFilesRef.current[fileKey];
    if (!live) return "";
    const descriptor = lspDescriptorForFile(live);
    return descriptor?.documentUri
      ?? lspFilesRef.current[live.key]?.status?.uri
      ?? descriptor?.filePath
      ?? "";
  }, [lspDescriptorForFile]);

  const extractOwnerSnapshot = useCallback((session: ExtractSession): ExtractOwnerSnapshot => ({
    sessionId: session.id,
    workspaceInstance: workspaceInstanceId,
    sourceViewId: activeEditorGroupIdRef.current,
    fileKey: session.fileKey,
    uri: extractLiveUri(session.fileKey),
    providerGeneration: lspSessionGeneration(),
    projectFingerprint: projectAnalysisSnapshot?.projectFingerprint ?? "",
  }), [
    extractLiveUri,
    lspSessionGeneration,
    projectAnalysisSnapshot?.projectFingerprint,
    workspaceInstanceId,
  ]);

  const dismissExtractNamingPrompt = useCallback((sessionId?: string) => {
    const current = extractNamingPromptRef.current;
    if (!current || (sessionId !== undefined && current.sessionId !== sessionId)) return;
    extractNamingPromptRef.current = null;
    setExtractNamingPrompt(null);
    current.resolve(null);
  }, []);

  const resolveExtractNamingPrompt = useCallback((value: string | null) => {
    const current = extractNamingPromptRef.current;
    if (!current) return;
    extractNamingPromptRef.current = null;
    setExtractNamingPrompt(null);
    current.resolve(value);
  }, []);

  const finishExtractSession = useCallback((session: ExtractSessionState) => {
    session.phase = "finished";
    if (extractSessionRef.current === session) extractSessionRef.current = null;
    dismissExtractNamingPrompt(session.id);
  }, [dismissExtractNamingPrompt]);
  finishExtractSessionRef.current = finishExtractSession;

  const invalidateExtractSession = useCallback(() => {
    const session = extractSessionRef.current;
    if (!session) return;
    // Aborting only stops this owner from accepting further replies; it never
    // claims the language server cancelled anything.
    session.abortController.abort();
    finishExtractSession(session);
  }, [finishExtractSession]);

  /** DEC-03: zero-candidate boundary text; provider failures use DEC-05 text. */
  const captureMethodSymbols = useCallback(async (
    file: OpenFileState,
  ): Promise<LspDocumentSymbol[] | null> => {
    const live = openFilesRef.current[file.key];
    const descriptor = live ? lspDescriptorForFile(live) : null;
    if (!live || !descriptor) return null;
    try {
      const result = await lspDocumentSymbols(descriptor);
      updateLspStatusForFile(live, result.status);
      return result.symbols;
    } catch {
      return null;
    }
  }, [lspDescriptorForFile, updateLspStatusForFile]);
  captureMethodSymbolsRef.current = captureMethodSymbols;

  /**
   * DEC-03: an outline that is missing or empty is damaged provider data, not a
   * real answer (a Java file always has at least its class). Re-read once before
   * it can poison the post-extraction diff into an ambiguity.
   */
  const captureMethodSymbolsSettled = useCallback(async (
    file: OpenFileState,
  ): Promise<LspDocumentSymbol[] | null> => {
    for (let read = 0; read < 2; read += 1) {
      if (read > 0) {
        await new Promise((resolve) => { window.setTimeout(resolve, 300); });
      }
      const symbols = await captureMethodSymbols(file);
      if (symbols && symbols.length > 0) return symbols;
    }
    return null;
  }, [captureMethodSymbols]);

  const beginExtractSession = useCallback((input: {
    file: OpenFileState;
    range: LspRange;
    uri: string;
    beforeSymbols: LspDocumentSymbol[] | null;
  }): ExtractSessionState | null => {
    const live = openFilesRef.current[input.file.key];
    if (!live || live.loading) return null;
    const previous = extractSessionRef.current;
    if (previous) {
      // A newer request supersedes the old local owner; the old prompt is
      // resolved with null so it can never write for the new selection.
      previous.abortController.abort();
      finishExtractSession(previous);
    }
    const session: ExtractSessionState = {
      id: `extract-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      workspaceInstance: workspaceInstanceId,
      sourceViewId: activeEditorGroupIdRef.current,
      fileKey: input.file.key,
      uri: input.uri,
      providerGeneration: lspSessionGeneration(),
      projectFingerprint: projectAnalysisSnapshot?.projectFingerprint ?? "",
      baseRevision: live.documentRevision,
      baseText: live.text,
      selection: { start: input.range.start, end: input.range.end },
      phase: "request",
      beforeSymbols: input.beforeSymbols,
      abortController: new AbortController(),
    };
    extractSessionRef.current = session;
    return session;
  }, [
    finishExtractSession,
    lspSessionGeneration,
    projectAnalysisSnapshot?.projectFingerprint,
    workspaceInstanceId,
  ]);
  beginExtractSessionRef.current = beginExtractSession;

  const promptExtractName = useCallback((
    sessionId: string,
    options: { title: string; label: string; confirmLabel: string; initialValue: string },
  ): Promise<string | null> => new Promise<string | null>((resolve) => {
    const pending: ExtractNamingPromptState = { sessionId, ...options, resolve };
    extractNamingPromptRef.current = pending;
    setExtractNamingPrompt(pending);
  }), []);

  // The local Extract prompt reuses TextInputDialog but owns its own focus
  // loop: Tab/Shift+Tab cycle input -> Cancel -> Confirm and never escape to
  // the workspace behind the modal. Enter/Escape stay with the dialog itself
  // (which already ignores composing Enter).
  const handleExtractNamingTab = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || event.nativeEvent.isComposing) return;
    const dialog = event.currentTarget.querySelector<HTMLElement>('[data-testid="text-input-dialog"]');
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>("input, button"),
    ).filter((element) => !element.hasAttribute("disabled"));
    if (focusable.length === 0) return;
    const index = focusable.findIndex((element) => element === document.activeElement);
    const nextIndex = event.shiftKey
      ? (index <= 0 ? focusable.length - 1 : index - 1)
      : (index === -1 || index === focusable.length - 1 ? 0 : index + 1);
    event.preventDefault();
    event.stopPropagation();
    focusable[nextIndex]?.focus();
  }, []);

  const continueExtractNaming = useCallback(createContinueExtractNaming({
    extractSessionRef,
    extractOwnerSnapshot,
    openFilesRef,
    ensureWorkspaceSemanticDocumentsSynced,
    semanticIndex,
    captureMethodSymbolsSettled,
    setStatusMessage,
    renameSymbolAt,
    promptSymbolName,
    promptExtractName,
    revealNavLocation,
    finishExtractSession,
  }), [
    captureMethodSymbolsSettled,
    ensureWorkspaceSemanticDocumentsSynced,
    extractOwnerSnapshot,
    finishExtractSession,
    promptExtractName,
    promptSymbolName,
    renameSymbolAt,
    revealNavLocation,
    semanticIndex.current,
    setStatusMessage,
  ]);
  continueExtractNamingRef.current = continueExtractNaming;

  const runExtractMethod = useCallback(createRunExtractMethod({
    activeFile,
    extractSessionRef,
    editorSelectionRef,
    beginExtractSession,
    extractLiveUri,
    finishExtractSession,
    ensureWorkspaceSemanticDocumentsSynced,
    semanticIndex,
    captureMethodSymbolsSettled,
    intentionRequestAbortRef,
    requestCodeActions,
    editorPaneRef,
    setStatusMessage,
    showCodeActionsMenu,
    intentionSessionRef,
    runCodeAction,
    continueExtractNaming,
  }), [
    activeFile,
    beginExtractSession,
    captureMethodSymbolsSettled,
    continueExtractNaming,
    ensureWorkspaceSemanticDocumentsSynced,
    finishExtractSession,
    requestCodeActions,
    runCodeAction,
    semanticIndex.current,
    setStatusMessage,
    showCodeActionsMenu,
  ]);
  runExtractMethodRef.current = runExtractMethod;

  // DEC-07 invalidation: switching files or workspaces (including closing the
  // source view and reopening the same key) drops the local owner and only its
  // own prompt. The guard also drops a pre-commit session whose frozen B0 no
  // longer matches the live buffer, or a post-commit session whose B1 moved.
  const extractGuardRevision = activeFile
    ? `${activeFile.key}:${activeFile.documentRevision}:${activeFile.text.length}:${activeFile.dirty ? 1 : 0}`
    : "";
  useEffect(() => {
    const session = extractSessionRef.current;
    if (!session) return;
    if (workspaceInstanceId !== session.workspaceInstance || activeKey !== session.fileKey) {
      invalidateExtractSession();
      return;
    }
    const live = openFilesRef.current[session.fileKey];
    if (!live) {
      invalidateExtractSession();
      return;
    }
    const current = { revision: live.documentRevision, text: live.text };
    if (session.receipt) {
      if (!extractReceiptMatches(session.receipt, current)) invalidateExtractSession();
      return;
    }
    // Before the commit the request window is the only phase where an external
    // edit must drop the owner eagerly; during resolve/commit the canonical
    // revision/generation guards already reject the apply, and after the commit
    // the receipt check above owns the decision.
    if (!session.receipt && session.phase === "request") {
      if (!extractBufferMatches(
        { revision: session.baseRevision, text: session.baseText },
        current,
      )) {
        invalidateExtractSession();
      }
    }
  }, [activeKey, extractGuardRevision, invalidateExtractSession, workspaceInstanceId]);

  useEffect(() => () => {
    const session = extractSessionRef.current;
    if (session) {
      session.phase = "finished";
      extractSessionRef.current = null;
      session.abortController.abort();
    }
    const pending = extractNamingPromptRef.current;
    if (pending) {
      extractNamingPromptRef.current = null;
      pending.resolve(null);
    }
  }, []);

  const safeDeleteSymbolAtCursor = useCallback(createSafeDeleteSymbolAtCursor({
    activeFile,
    setStatusMessage,
    semanticIndex,
    ensureWorkspaceSemanticDocumentsSynced,
    referencesRequestSequenceRef,
    lspDescriptorForFile,
    editorSelectionRef,
    setBottomDockOpen,
    setBottomDockTab,
    setReferencesResult,
    updateLspStatusForFile,
    absolutePathForOpenFile,
    rootsRef,
    lspFilesRef,
    lspSessionGeneration,
    projectAnalysisSnapshot,
    buildPlanOpenFiles,
    applyLspWorkspaceEdit,
  }), [
    absolutePathForOpenFile,
    activeFile,
    applyLspWorkspaceEdit,
    ensureWorkspaceSemanticDocumentsSynced,
    lspDescriptorForFile,
    semanticIndex.beginBuild,
    semanticIndex.abandonBuild,
    semanticIndex.failBuild,
    semanticIndex.finishQuery,
    semanticIndex.current,
    setStatusMessage,
    updateLspStatusForFile,
  ]);
  safeDeleteSymbolRef.current = safeDeleteSymbolAtCursor;
  return {
    extractSessionRef,
    beginExtractSessionRef,
    continueExtractNamingRef,
    captureMethodSymbolsRef,
    finishExtractSessionRef,
    extractNamingPrompt,
    inlineRename,
    refactorModalOptions,
    finishInlineRename,
    setRefactorModalOptions,
    handleExtractNamingTab,
    resolveExtractNamingPrompt,
  };
}
