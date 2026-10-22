import { useCallback } from "react";
import { createNavigateDiagnostic } from "../controller/navigationActions";
import { createCopyReferenceAtCursor } from "../controller/semanticQueries";
import { useIntentionActions } from "./useIntentionActions";
import { useSymbolRefactoring } from "./useSymbolRefactoring";
import { useWorkspaceBookmarkActions } from "./useWorkspaceBookmarkActions";
import { useWorkspaceComparisons } from "./useWorkspaceComparisons";
import { useWorkspaceCoverage } from "./useWorkspaceCoverage";
import { useWorkspaceDocumentEditing } from "./useWorkspaceDocumentEditing";
import { useWorkspaceFileOpening } from "./useWorkspaceFileOpening";
import { useWorkspaceLanguagePreferences } from "./useWorkspaceLanguagePreferences";
import { useWorkspaceLocationOpening } from "./useWorkspaceLocationOpening";
import { useWorkspaceOccurrences } from "./useWorkspaceOccurrences";
import { useWorkspaceProjectRuntime } from "./useWorkspaceProjectRuntime";
import { useWorkspaceReaderMode } from "./useWorkspaceReaderMode";
import { useWorkspaceSemanticFeatures } from "./useWorkspaceSemanticFeatures";
import { useWorkspaceSession } from "./useWorkspaceSession";
import { useWorkspaceStructure } from "./useWorkspaceStructure";
import { useWorkspaceStyleActions } from "./useWorkspaceStyleActions";
import { useWorkspaceSurfaceState } from "./useWorkspaceSurfaceState";
import { useWorkspaceToolWindows } from "./useWorkspaceToolWindows";


export interface UseWorkspaceEditingFeaturesContext {
  editing: ReturnType<typeof useWorkspaceDocumentEditing>;
  project: ReturnType<typeof useWorkspaceProjectRuntime>;
  session: ReturnType<typeof useWorkspaceSession>;
  surfaceState: ReturnType<typeof useWorkspaceSurfaceState>;
  files: ReturnType<typeof useWorkspaceFileOpening>;
  semantics: ReturnType<typeof useWorkspaceSemanticFeatures>;
  refactoring: ReturnType<typeof useSymbolRefactoring>;
}

export function useWorkspaceEditingFeatures(context: UseWorkspaceEditingFeaturesContext) {
  const { editing, project, session, surfaceState, files, semantics } = context;

  // §8.19.5 Copy Reference: workspace-relative `path:line` from real file
  // facts, plus a symbol candidate only when the provider names one via its
  // rename range. Qualified names are never synthesized — without a
  // provider channel they stay an explicit unavailable reason.
  const copyReferenceAtCursor = useCallback(createCopyReferenceAtCursor({
    activeFile: editing.documentLanguage.activeFile,
    absolutePathForOpenFile: editing.absolutePathForOpenFile,
    rootsRef: project.projectTree.rootsRef,
    editorSelectionRef: session.editorSelectionRef,
    setStatusMessage: session.setStatusMessage,
    openFilesRef: session.bufferState.openFilesRef,
    lspDescriptorForFile: project.lsp.descriptorForFile,
    editorPaneRef: surfaceState.editorPaneRef,
    openTreeContextMenuAt: files.treeInteractions.openTreeContextMenuAt,
  }), [
    editing.absolutePathForOpenFile,
    editing.documentLanguage.activeFile,
    project.lsp.descriptorForFile,
    files.treeInteractions.openTreeContextMenuAt,
    session.setStatusMessage,
  ]);
  const intentions = useIntentionActions({
    intentionRequestAbortRef: semantics.codeActions.intentionRequestAbortRef,
    requestCodeActions: semantics.codeActions.requestCodeActions,
    showCodeInsightNotice: surfaceState.showCodeInsightNotice,
    setStatusMessage: session.setStatusMessage,
    intentionSessionRef: semantics.codeActions.intentionSessionRef,
    get beginExtractSessionRef() { return context.refactoring.beginExtractSessionRef; },
    get captureMethodSymbolsRef() { return context.refactoring.captureMethodSymbolsRef; },
    runCodeAction: semantics.codeActions.runCodeAction,
    get continueExtractNamingRef() { return context.refactoring.continueExtractNamingRef; },
    get finishExtractSessionRef() { return context.refactoring.finishExtractSessionRef; },
    openTreeContextMenuAt: files.treeInteractions.openTreeContextMenuAt,
    activeFile: editing.documentLanguage.activeFile,
    editorSelectionRef: session.editorSelectionRef,
    editorPaneRef: surfaceState.editorPaneRef,
    resolveEditorTarget: session.editorCommands.resolveEditorTarget,
    lspFilesRef: session.bufferState.lspFilesRef,
    openFilesRef: session.bufferState.openFilesRef,
  });
  const structure = useWorkspaceStructure({
    activeKey: session.workspaceUi.activeKey,
    openFilesRef: session.bufferState.openFilesRef,
    structureFileRef: semantics.structureFileRef,
    setStructureSymbols: project.uiActions.setStructureSymbols,
    setStructureUnavailable: project.uiActions.setStructureUnavailable,
    setStructureSyntaxOnly: surfaceState.setStructureSyntaxOnly,
    setStructureLoading: project.uiActions.setStructureLoading,
    setStructureOpen: project.uiActions.setStructureOpen,
    lspDescriptorForFile: project.lsp.descriptorForFile,
    updateLspStatusForFile: project.lsp.updateStatus,
    revealEditorLocation: semantics.librarySources.revealEditorLocation,
  });
  const { openTodoOrBookmark } = useWorkspaceLocationOpening({
    openFilesRef: session.bufferState.openFilesRef,
    updateEditorGroup: project.uiActions.updateEditorGroup,
    activeEditorGroupId: session.workspaceUi.activeEditorGroupId,
    openFile: files.openFile,
    looseFilesRef: project.projectTree.looseFilesRef,
    setStatusMessage: session.setStatusMessage,
    activeKey: session.workspaceUi.activeKey,
    recordNavigationLocation: files.navigation.recordNavigationLocation,
    editorSelectionRef: session.editorSelectionRef,
    suppressNextHistoryRecord: files.navigation.suppressNextHistoryRecord,
    revealEditorLocation: semantics.librarySources.revealEditorLocation,
  });
  const toolWindowActions = useWorkspaceToolWindows({
    setLanguagePanelOpen: project.toolWindowRouting.setLanguagePanelOpen,
    projectPanelRef: session.projectPanelRef,
    leftToolAreaOpen: project.toolWindowRouting.leftToolAreaOpen,
    lastProjectPanelSizeRef: session.lastProjectPanelSizeRef,
    toolWindowLayoutRef: project.toolWindowRouting.toolWindowLayoutRef,
    rootRef: surfaceState.rootRef,
    workspaceUi: session.workspaceUi,
    bottomDockTab: session.workspaceUi.bottomDockTab,
    setBottomDockHeightForTool: session.storeActions.setBottomDockHeightForTool,
    workspaceInstanceId: session.workspaceInstanceId,
    treePaneRef: session.treeFocus.treePaneRef,
    rightPaneTabRef: project.toolWindowRouting.rightPaneTabRef,
    handleReturnToEditor: session.editorCommands.handleReturnToEditor,
    restoreDefaultToolWindowLayout: session.storeActions.restoreDefaultToolWindowLayout,
    setStatusMessage: session.setStatusMessage,
    bottomDockOpen: session.workspaceUi.bottomDockOpen,
    rightPaneOpen: project.toolWindowRouting.rightPaneOpen,
    rightPaneTab: session.workspaceUi.rightPaneTab,
    setRightPaneTab: project.toolWindowRouting.setRightPaneTab,
    setRightPaneOpen: project.toolWindowRouting.setRightPaneOpen,
    setBottomDockTab: project.toolWindowRouting.setBottomDockTab,
    setBottomDockOpen: project.toolWindowRouting.setBottomDockOpen,
    rightPanelRef: project.toolWindowRouting.rightPanelRef,
    rightToolAreaOpen: project.toolWindowRouting.rightToolAreaOpen,
    lastRightPanelSizeRef: project.toolWindowRouting.lastRightPanelSizeRef,
  });
  const bookmarkActions = useWorkspaceBookmarkActions({
    setBottomDockTab: project.toolWindowRouting.setBottomDockTab,
    setBottomDockOpen: project.toolWindowRouting.setBottomDockOpen,
    workspaceInstanceId: session.workspaceInstanceId,
    activeKey: session.workspaceUi.activeKey,
    openFilesRef: session.bufferState.openFilesRef,
    setStatusMessage: session.setStatusMessage,
    editorSelectionRef: session.editorSelectionRef,
    bookmarks: session.preferences.bookmarks,
    replaceBookmarks: session.preferences.replaceBookmarks,
    bookmarksRef: session.preferences.bookmarksRef,
    openTodoOrBookmark,
  });
  const occurrences = useWorkspaceOccurrences({
    telemetry: project.telemetry,
    activeEditorGroupId: session.workspaceUi.activeEditorGroupId,
    activeFile: editing.documentLanguage.activeFile,
    lspDescriptorForFile: project.lsp.descriptorForFile,
    lspDocumentEpochRef: session.bufferState.lspDocumentEpochRef,
    activeCapabilities: editing.documentLanguage.activeCapabilities,
    activeLspDocumentIsSynced: editing.documentLanguage.activeLspDocumentIsSynced,
    openFilesRef: session.bufferState.openFilesRef,
    isCurrentLspDocumentRequest: editing.documentLanguage.isCurrentLspDocumentRequest,
    setStatusMessage: session.setStatusMessage,
    revealEditorLocation: semantics.librarySources.revealEditorLocation,
  });
  const comparisons = useWorkspaceComparisons({
    openFilesRef: session.bufferState.openFilesRef,
    gitHeadTextByFile: semantics.gitDecorations.gitHeadTextByFile,
    setStatusMessage: session.setStatusMessage,
    setActiveCompareSession: surfaceState.setActiveCompareSession,
    activeFile: editing.documentLanguage.activeFile,
    editorSelectionRef: session.editorSelectionRef,
    absolutePathForOpenFile: editing.absolutePathForOpenFile,
    rootsRef: project.projectTree.rootsRef,
    compareLocalHistorySnapshot: editing.localHistory.compareLocalHistorySnapshot,
    workspaceResourceOperationLocked: project.editState.workspaceResourceOperationLocked,
    flushPendingEditorText: project.buffers.flushPendingEditorText,
    mutateOpenBuffer: editing.mutateOpenBuffer,
    semanticIndex: session.semanticIndex,
    workspaceEditHistory: project.editState.workspaceEditHistory,
    workspaceInstanceId: session.workspaceInstanceId,
    syncLspDocument: project.lsp.syncDocument,
    setWorkspaceEditHistoryRevision: project.editState.setWorkspaceEditHistoryRevision,
  });
  const readerMode = useWorkspaceReaderMode({
    workspaceInstanceId: session.workspaceInstanceId,
    activeFile: editing.documentLanguage.activeFile,
    activeRenderedDocLanguageId: editing.documentLanguage.activeRenderedDocLanguageId,
    setStatusMessage: session.setStatusMessage,
  });

  const navigateDiagnostic = useCallback(createNavigateDiagnostic({
    activeFile: editing.documentLanguage.activeFile,
    lspFilesRef: session.bufferState.lspFilesRef,
    currentDiagnosticsForFile: editing.documentLanguage.currentDiagnosticsForFile,
    setStatusMessage: session.setStatusMessage,
    diagnosticScopeForFile: editing.documentLanguage.diagnosticScopeForFile,
    displayDiagnosticsFor: project.inspections.displayDiagnosticsFor,
    inspectionPathForFileKey: project.inspections.inspectionPathForFileKey,
    cursorPositionsRef: project.telemetry.cursorPositionsRef,
    activeEditorGroupId: session.workspaceUi.activeEditorGroupId,
    openFile: files.openFile,
    openFilesRef: session.bufferState.openFilesRef,
    revealEditorLocation: semantics.librarySources.revealEditorLocation,
  }), [
    session.workspaceUi.activeEditorGroupId,
    editing.documentLanguage.activeFile,
    editing.documentLanguage.currentDiagnosticsForFile,
    editing.documentLanguage.diagnosticScopeForFile,
    project.inspections.displayDiagnosticsFor,
    project.inspections.inspectionPathForFileKey,
    files.openFile,
    session.bufferState.openFilesRef,
    semantics.librarySources.revealEditorLocation,
    session.setStatusMessage,
  ]);
  const coverage = useWorkspaceCoverage({
    rootsRef: project.projectTree.rootsRef,
    setStatusMessage: session.setStatusMessage,
  });
  const styleActions = useWorkspaceStyleActions({
    documentLanguage: editing.documentLanguage,
    setStatusMessage: session.setStatusMessage,
    absolutePathForOpenFile: editing.absolutePathForOpenFile,
    editState: project.editState,
    saves: editing.saves,
    editorSelectionRef: session.editorSelectionRef,
    updateFileText: editing.updateFileText,
    codeActions: semantics.codeActions,
    bufferState: session.bufferState,
    projectFactsRoot: project.projectFactsRoot,
    javaCreation: semantics.javaCreation,
    clipboard: session.clipboard,
    editorCommands: session.editorCommands,
    workspaceInstanceId: session.workspaceInstanceId,
    lsp: project.lsp,
    semanticQueries: project.semanticQueries,
    editTransactions: semantics.editTransactions,
  });
  const languagePreferences = useWorkspaceLanguagePreferences({
    intelligence: project.intelligence,
    documentLanguage: editing.documentLanguage,
    codeStyle: project.codeStyle,
    setStatusMessage: session.setStatusMessage,
    bufferState: session.bufferState,
    workspaceUi: session.workspaceUi,
    get executeAutoImportOnTheFly() { return styleActions.executeAutoImportOnTheFly; },
  });
  return {
    styleActions,
    navigateDiagnostic,
    copyReferenceAtCursor,
    structure,
    languagePreferences,
    intentions,
    toolWindowActions,
    bookmarkActions,
    occurrences,
    comparisons,
    readerMode,
    coverage,
    openTodoOrBookmark,
  };
}
