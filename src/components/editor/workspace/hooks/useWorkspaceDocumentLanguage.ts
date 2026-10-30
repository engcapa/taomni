import { useCallback, useEffect, useMemo } from "react";
import { lspDocumentSymbols, lspSelectionRanges, type LspDiagnostic, type LspRange } from "../../../../lib/editor/lsp";
import { type BreadcrumbPathSegment } from "../Breadcrumbs";
import { type EditorSelectionRange } from "../CodeMirrorHost";
import { shouldLiveSyncLsp, shouldProbeLsp, type LspFileState, type OpenFileState } from "../codeWorkspaceModel";
import { LSP_DOCUMENT_SYMBOLS_IDLE_DELAY_MS, breadcrumbSegmentsForFile } from "../controller/model";
import { useEditorSemanticDecorations } from "../controller/useEditorSemanticDecorations";
import { isDiagnosticScopeCurrent, type DiagnosticScope } from "../diagnosticScopeModel";
import { inlayHintsEnabledForLanguage } from "../intelligencePreferences";
import { isLargeFileContent } from "../largeFile";
import { useWorkspaceLspSession } from "../useWorkspaceLspSession";
import { useWorkspaceBufferState } from "./useWorkspaceBufferState";
import { useWorkspaceDocumentSync } from "./useWorkspaceDocumentSync";
import { useWorkspaceEditorTelemetry } from "./useWorkspaceEditorTelemetry";
import { useWorkspaceIntelligencePreferences } from "./useWorkspaceIntelligencePreferences";
import { useWorkspaceTreeModel } from "./useWorkspaceTreeModel";


export interface UseWorkspaceDocumentLanguageContext {
  workspaceUi: Omit<import("../../../../stores/codeWorkspaceStore").CodeWorkspaceInstanceUi, "treeSelection">;
  lsp: ReturnType<typeof useWorkspaceLspSession>;
  bufferState: ReturnType<typeof useWorkspaceBufferState>;
  intelligence: ReturnType<typeof useWorkspaceIntelligencePreferences>;
  visible: boolean;
  documents: ReturnType<typeof useWorkspaceDocumentSync>;
  telemetry: ReturnType<typeof useWorkspaceEditorTelemetry>;
  projectTree: ReturnType<typeof useWorkspaceTreeModel>;
}

export function useWorkspaceDocumentLanguage(context: UseWorkspaceDocumentLanguageContext) {
  const { workspaceUi, lsp, bufferState, intelligence, visible, documents, telemetry, projectTree } = context;

  const activeFile = workspaceUi.activeKey ? workspaceUi.openFiles[workspaceUi.activeKey] ?? null : null;
  // Large-file mode (M6-B): above the size/line threshold, skip the per-edit
  // semantic-tokens / inlay-hint / document-highlight storm and their decoration
  // rebuilds. Lezer highlighting and on-demand features stay available.
  const activeFileIsLarge = useMemo(
    () => (activeFile && !activeFile.loading ? isLargeFileContent(activeFile.text) : false),
    [activeFile],
  );
  const activeLspState = workspaceUi.activeKey ? workspaceUi.lspFiles[workspaceUi.activeKey] ?? null : null;
  const activeCapabilities = activeLspState?.status?.capabilities ?? null;
  const diagnosticScopeForFile = useCallback((
    file: OpenFileState,
    state: LspFileState | null | undefined,
  ): DiagnosticScope => {
    const descriptor = lsp.descriptorForFile(file);
    return {
      fileKey: file.key,
      revision: file.documentRevision ?? 0,
      providerId: state?.status?.presetId ?? null,
      providerGeneration: lsp.sessionGeneration(),
      uri: state?.status?.uri || descriptor?.documentUri || descriptor?.filePath || null,
    };
  }, [lsp.descriptorForFile, lsp.sessionGeneration]);
  const currentDiagnosticsForFile = useCallback((
    file: OpenFileState,
    state: LspFileState | null | undefined,
  ): LspDiagnostic[] | null => {
    if (!state || !isDiagnosticScopeCurrent(state.diagnosticScope, diagnosticScopeForFile(file, state))) {
      return null;
    }
    return state.diagnostics;
  }, [diagnosticScopeForFile]);
  const activeLspDocumentIsSynced = Boolean(
    activeFile
    && !activeFile.loading
    && activeLspState?.status
    // Store-backed fields re-render after the didChange queue drains; the
    // session helper also covers the silent mid-burst path.
    && !activeLspState.syncing
    && (activeLspState.syncedText === activeFile.text
      || lsp.isDocumentSynced(activeFile.key, activeFile.text)),
  );

  // The backend is responsible for serializing didOpen/didChange calls, but
  // the view also needs a revision token so a slow feature response cannot
  // paint a document revision that has already been replaced locally.
  useEffect(() => {
    if (!activeFile) return;
    bufferState.lspDocumentEpochRef.current[activeFile.key] =
      (bufferState.lspDocumentEpochRef.current[activeFile.key] ?? 0) + 1;
  }, [activeFile?.key, activeFile?.text]);

  const isCurrentLspDocumentRequest = useCallback((file: OpenFileState, epoch: number) => {
    const latestFile = bufferState.openFilesRef.current[file.key];
    return latestFile?.text === file.text
      && bufferState.lspDocumentEpochRef.current[file.key] === epoch
      && lsp.isDocumentSynced(file.key, file.text);
  }, [lsp.isDocumentSynced]);
  const activeLanguageId = activeLspState?.status?.languageId ?? null;
  const activeRenderedDocLanguageId = activeLanguageId
    ?? activeFile?.languagePath.split(".").pop()?.toLowerCase()
    ?? null;
  const activeInlayHintsEnabled = inlayHintsEnabledForLanguage(
    intelligence.intelligencePreferences,
    activeLanguageId,
  );

  // Probe / re-open when the active buffer *identity* changes — not on every
  // text commit. Typing drives didChange through scheduleLiveLspSync only.
  // Depending on the whole activeFile object used to re-fire open/change IPC
  // after each EDITOR_TEXT_COMMIT_IDLE flush and made non-LSP files feel laggy.
  const activeFileKey = activeFile?.key ?? null;
  const activeFileLoading = activeFile?.loading ?? false;
  const activeFileLanguagePath = activeFile?.languagePath ?? null;
  // Library buffers are served by the origin project's session and never opened as
  // documents, so they must not start a server of their own.
  const activeFileIsLibrary = !!activeFile?.library;
  useEffect(() => {
    if (!visible || !activeFileKey || activeFileLoading || !activeFileLanguagePath) return;
    if (activeFileIsLibrary) return;
    const lspState = bufferState.lspFilesRef.current[activeFileKey];
    if (!shouldProbeLsp(activeFileLanguagePath, lspState)) return;
    if (lspState?.status?.active) {
      // Active session: typing / store-text effects own didChange.
      return;
    }
    const timer = window.setTimeout(() => {
      const latest = bufferState.openFilesRef.current[activeFileKey];
      if (!latest || !shouldProbeLsp(latest.languagePath, bufferState.lspFilesRef.current[activeFileKey])) return;
      void lsp.syncDocument(latest, "open");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    activeFileIsLibrary,
    activeFileKey,
    activeFileLanguagePath,
    activeFileLoading,
    lsp.syncDocument,
    visible,
  ]);

  // Non-CodeMirror text updates (format, AI rewrite, store patches in tests)
  // still need didChange once the server is active. Gated so plain-text /
  // unavailable presets never schedule IPC from store flushes.
  const activeFileText = activeFile?.text;
  useEffect(() => {
    if (!visible || !activeFileKey || activeFileLoading || activeFileText == null) return;
    const lspState = bufferState.lspFilesRef.current[activeFileKey];
    if (!shouldLiveSyncLsp(activeFileLanguagePath ?? "", lspState)) return;
    if (lsp.isDocumentSynced(activeFileKey, activeFileText)) return;
    documents.scheduleLiveLspSync(activeFileKey);
  }, [
    activeFileKey,
    activeFileLanguagePath,
    activeFileLoading,
    activeFileText,
    lsp.isDocumentSynced,
    documents.scheduleLiveLspSync,
    visible,
  ]);
  useEditorSemanticDecorations({
    activeEditorGroupId: workspaceUi.activeEditorGroupId,
    activeFile,
    autoHighlightRequestGenerationRef: telemetry.autoHighlightRequestGenerationRef,
    occurrenceActiveFileKeyRef: telemetry.occurrenceActiveFileKeyRef,
    occurrenceActiveGroupIdRef: telemetry.occurrenceActiveGroupIdRef,
    occurrenceSessionRef: telemetry.occurrenceSessionRef,
    openFilesRef: bufferState.openFilesRef,
    activeFileIsLarge,
    setHighlightsByGroup: telemetry.setHighlightsByGroup,
    cursorPositions: telemetry.cursorPositions,
    lspDescriptorForFile: lsp.descriptorForFile,
    activeCapabilities,
    activeLspDocumentIsSynced,
    lspDocumentEpochRef: bufferState.lspDocumentEpochRef,
    isCurrentLspDocumentRequest,
    updateLspStatusForFile: lsp.updateStatus,
    occurrenceSession: telemetry.occurrenceSession,
    setOccurrenceSession: telemetry.setOccurrenceSession,
    activeInlayHintsEnabled,
    setInlayHintsByGroup: telemetry.setInlayHintsByGroup,
    viewportRanges: telemetry.viewportRanges,
    setSemanticTokensByGroup: telemetry.setSemanticTokensByGroup,
  });

  const getLspSelectionRanges = useCallback(async (
    file: OpenFileState,
    selection: EditorSelectionRange,
  ): Promise<LspRange[] | null> => {
    const capabilities = bufferState.lspFilesRef.current[file.key]?.status?.capabilities;
    if (!capabilities?.selectionRange) return null;
    const descriptor = lsp.descriptorForFile(file);
    if (!descriptor) return null;
    try {
      const result = await lspSelectionRanges(descriptor, selection.end);
      lsp.updateStatus(file, result.status);
      return result.ranges.length > 0 ? result.ranges : null;
    } catch {
      return null;
    }
  }, [lsp.descriptorForFile, lsp.updateStatus]);
  const breadcrumbPathSegments = useMemo<BreadcrumbPathSegment[]>(() => {
    return activeFile ? breadcrumbSegmentsForFile(activeFile, projectTree.roots) : [];
  }, [activeFile, projectTree.roots]);

  useEffect(() => {
    let cancelled = false;
    if (!activeFile || activeFile.loading || !activeCapabilities?.documentSymbol) {
      telemetry.setBreadcrumbSymbolsByGroup((current) => (
        (current[workspaceUi.activeEditorGroupId] ?? []).length === 0
          ? current
          : { ...current, [workspaceUi.activeEditorGroupId]: [] }
      ));
      return () => { cancelled = true; };
    }
    if (!activeLspDocumentIsSynced) {
      telemetry.setBreadcrumbSymbolsByGroup((current) => (
        (current[workspaceUi.activeEditorGroupId] ?? []).length === 0
          ? current
          : { ...current, [workspaceUi.activeEditorGroupId]: [] }
      ));
      return () => { cancelled = true; };
    }
    const descriptor = lsp.descriptorForFile(activeFile);
    if (!descriptor) return () => { cancelled = true; };
    const epoch = bufferState.lspDocumentEpochRef.current[activeFile.key] ?? 0;
    const timer = window.setTimeout(() => {
      if (!isCurrentLspDocumentRequest(activeFile, epoch)) return;
      void lspDocumentSymbols(descriptor).then((result) => {
        if (!cancelled && isCurrentLspDocumentRequest(activeFile, epoch)) {
          lsp.updateStatus(activeFile, result.status);
          telemetry.setBreadcrumbSymbolsByGroup((current) => ({
            ...current,
            [workspaceUi.activeEditorGroupId]: result.symbols,
          }));
        }
      }).catch(() => {
        if (!cancelled && isCurrentLspDocumentRequest(activeFile, epoch)) {
          telemetry.setBreadcrumbSymbolsByGroup((current) => (
            (current[workspaceUi.activeEditorGroupId] ?? []).length === 0
              ? current
              : { ...current, [workspaceUi.activeEditorGroupId]: [] }
          ));
        }
      });
    }, LSP_DOCUMENT_SYMBOLS_IDLE_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activeCapabilities?.documentSymbol,
    workspaceUi.activeEditorGroupId,
    activeFile,
    activeLspDocumentIsSynced,
    isCurrentLspDocumentRequest,
    lsp.descriptorForFile,
    lsp.updateStatus,
  ]);
  return {
    activeFile,
    activeLanguageId,
    activeLspState,
    activeFileIsLarge,
    activeCapabilities,
    activeLspDocumentIsSynced,
    isCurrentLspDocumentRequest,
    activeRenderedDocLanguageId,
    currentDiagnosticsForFile,
    diagnosticScopeForFile,
    activeInlayHintsEnabled,
    activeFileLoading,
    breadcrumbPathSegments,
    getLspSelectionRanges,
  };
}
