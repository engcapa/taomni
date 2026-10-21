import { useCallback, useDeferredValue, useMemo, useRef } from "react";
import { gitRootForWorkspacePath, workspaceTitle } from "../codeWorkspaceModel";
import { type CodeWorkspaceGitManagerPayload } from "../controller/model";
import { useDeferredOpenFileTodos } from "../useDeferredOpenFileTodos";
import { useCodeGeneration } from "./useCodeGeneration";
import { useRefactorRecovery } from "./useRefactorRecovery";
import { useReferenceDocumentation } from "./useReferenceDocumentation";
import { useSymbolRefactoring } from "./useSymbolRefactoring";
import { useWorkspaceCodeActions } from "./useWorkspaceCodeActions";
import { useWorkspaceDocumentEditing } from "./useWorkspaceDocumentEditing";
import { useWorkspaceEditTransactions } from "./useWorkspaceEditTransactions";
import { useWorkspaceEncoding } from "./useWorkspaceEncoding";
import { useWorkspaceFileOpening } from "./useWorkspaceFileOpening";
import { useWorkspaceGitDecorations } from "./useWorkspaceGitDecorations";
import { useWorkspaceHierarchy } from "./useWorkspaceHierarchy";
import { useWorkspaceJavaCreation } from "./useWorkspaceJavaCreation";
import { useWorkspaceLibrarySources } from "./useWorkspaceLibrarySources";
import { useWorkspaceProjectRuntime } from "./useWorkspaceProjectRuntime";
import { useWorkspaceSearchNavigation } from "./useWorkspaceSearchNavigation";
import { useWorkspaceSession } from "./useWorkspaceSession";
import { useWorkspaceStatusBridge } from "./useWorkspaceStatusBridge";
import { useWorkspaceSurfaceState } from "./useWorkspaceSurfaceState";


export interface UseWorkspaceSemanticFeaturesContext {
  session: ReturnType<typeof useWorkspaceSession>;
  editing: ReturnType<typeof useWorkspaceDocumentEditing>;
  project: ReturnType<typeof useWorkspaceProjectRuntime>;
  workspace: import("../../../../types").CodeWorkspaceTabInfo;
  onOpenGitManager: ((payload: CodeWorkspaceGitManagerPayload) => void) | undefined;
  surfaceState: ReturnType<typeof useWorkspaceSurfaceState>;
  visible: boolean;
  tabId: string;
  files: ReturnType<typeof useWorkspaceFileOpening>;
  refactoring: ReturnType<typeof useSymbolRefactoring>;
}

export function useWorkspaceSemanticFeatures(context: UseWorkspaceSemanticFeaturesContext) {
  const { session, editing, project, workspace, onOpenGitManager, surfaceState, visible, tabId, files } = context;
  // Metadata panels and AI workspace context do not need a new snapshot for
  // every character.  Let React publish that non-interactive work after the
  // input update has painted.
  const deferredOpenFiles = useDeferredValue(session.workspaceUi.openFiles);
  const hierarchy = useWorkspaceHierarchy({
    activeFile: editing.documentLanguage.activeFile,
    lspDescriptorForFile: project.lsp.descriptorForFile,
    setStatusMessage: session.setStatusMessage,
    lspFilesRef: session.bufferState.lspFilesRef,
    cursorPositionsRef: project.telemetry.cursorPositionsRef,
    activeEditorGroupId: session.workspaceUi.activeEditorGroupId,
    editorSelectionRef: session.editorSelectionRef,
    openFilesRef: session.bufferState.openFilesRef,
    lspSessionGeneration: project.lsp.sessionGeneration,
    workspaceInstanceId: session.workspaceInstanceId,
    workspaceInstanceIdRef: project.semanticQueries.workspaceInstanceIdRef,
    semanticQueryHostRef: project.semanticQueries.semanticQueryHostRef,
    projectAnalysisSnapshot: project.projectAnalysis.snapshot,
    updateLspStatusForFile: project.lsp.updateStatus,
    setBottomDockTab: project.toolWindowRouting.setBottomDockTab,
    setBottomDockOpen: project.toolWindowRouting.setBottomDockOpen,
  });

  const openFileTodos = useDeferredOpenFileTodos(session.workspaceUi.openFiles);
  const activeRootId = editing.documentLanguage.activeFile?.ref.kind === "root" ? editing.documentLanguage.activeFile.ref.rootId : null;
  const activeRoot = activeRootId ? project.projectTree.roots.find((root) => root.id === activeRootId) ?? null : null;
  const activeGitRoot = activeRoot && editing.documentLanguage.activeFile?.ref.kind === "root"
    ? gitRootForWorkspacePath(activeRoot, editing.documentLanguage.activeFile.ref.path, project.gitSnapshotOwner.gitRoots)
    : null;
  const title = workspaceTitle(workspace, project.projectTree.roots, project.projectTree.looseFiles);
  const gitManagerPayload = useMemo<CodeWorkspaceGitManagerPayload>(() => ({
    workspaceName: title,
    workspaceInstanceId: session.workspaceInstanceId,
    workspaceId: workspace.workspaceId,
    roots: project.gitSnapshotOwner.gitRoots,
    // Empty roots still emit a payload so the linked Git manager can close
    // instead of snapshotting stale paths (issue #324 B1).
    activeRepoRoot: activeGitRoot?.repoRoot ?? project.gitSnapshotOwner.gitRoots[0]?.repoRoot ?? null,
  }), [activeGitRoot, project.gitSnapshotOwner.gitRoots, title, workspace.workspaceId, session.workspaceInstanceId]);

  const openGitManager = useCallback(() => {
    if (!onOpenGitManager || gitManagerPayload.roots.length === 0) return;
    onOpenGitManager(gitManagerPayload);
  }, [gitManagerPayload, onOpenGitManager]);
  const encodingOwner = useWorkspaceEncoding({
    activeKey: session.workspaceUi.activeKey,
    openFilesRef: session.bufferState.openFilesRef,
    setOpenFiles: project.buffers.setOpenFiles,
    findRoot: project.projectTree.findRoot,
    mutateOpenBuffer: editing.mutateOpenBuffer,
    setFileEncodingDialogOpen: surfaceState.setFileEncodingDialogOpen,
    setStatusMessage: session.setStatusMessage,
    pendingEncodingDialogFileKeyRef: surfaceState.pendingEncodingDialogFileKeyRef,
    activeFile: editing.documentLanguage.activeFile,
  });
  const statusBridge = useWorkspaceStatusBridge({
    lspClientEvents: session.lspClientEvents,
    codeStyle: project.codeStyle,
    activeFile: editing.documentLanguage.activeFile,
    activeKey: session.workspaceUi.activeKey,
    openFilesRef: session.bufferState.openFilesRef,
    setStatusMessage: session.setStatusMessage,
    visible,
    tabId,
    telemetry: project.telemetry,
    activeEditorGroupId: session.workspaceUi.activeEditorGroupId,
    activeLspState: editing.documentLanguage.activeLspState,
    activeGitRoot,
    gitSnapshotOwner: project.gitSnapshotOwner,
    activeLanguageId: editing.documentLanguage.activeLanguageId,
    appearance: project.appearance,
    activeFileIsLarge: editing.documentLanguage.activeFileIsLarge,
    roots: project.projectTree.roots,
    gitManagerPayload,
    onOpenGitManager,
    openGitManager,
    encoding: encodingOwner,
  });
  const gitDecorations = useWorkspaceGitDecorations({
    roots: project.projectTree.roots,
    gitRoots: project.gitSnapshotOwner.gitRoots,
    gitSnapshots: project.gitSnapshotOwner.gitSnapshots,
    workspaceUi: session.workspaceUi,
    editorGroups: session.workspaceUi.editorGroups,
    openFiles: session.workspaceUi.openFiles,
    openFilesRef: session.bufferState.openFilesRef,
    intelligencePreferences: project.intelligence.intelligencePreferences,
    cursorPositions: project.telemetry.cursorPositions,
    workspaceInstanceId: session.workspaceInstanceId,
  });
  const librarySources = useWorkspaceLibrarySources({
    activeFile: editing.documentLanguage.activeFile,
    openFile: files.openFile,
    addLooseFilePath: files.fileActions.addLooseFilePath,
    revealNonceRef: surfaceState.revealNonceRef,
    setRevealTarget: surfaceState.setRevealTarget,
    libraryBuffersRef: session.bufferState.libraryBuffersRef,
    suppressNextHistoryRecord: files.navigation.suppressNextHistoryRecord,
    setOpenFiles: project.buffers.setOpenFiles,
    workspaceInstanceId: session.workspaceInstanceId,
    updateEditorGroup: project.uiActions.updateEditorGroup,
    activateEditorGroup: project.uiActions.activateEditorGroup,
    recordNavigationLocation: files.navigation.recordNavigationLocation,
    setStatusMessage: session.setStatusMessage,
    openFilesRef: session.bufferState.openFilesRef,
    downloadingSourcesKeys: surfaceState.downloadingSourcesKeys,
    setDownloadingSourcesKeys: surfaceState.setDownloadingSourcesKeys,
    lspDescriptorForPath: project.lsp.descriptorForPath,
    rootsRef: project.projectTree.rootsRef,
    setLooseFiles: project.projectTree.setLooseFiles,
    lspDescriptorForFile: project.lsp.descriptorForFile,
    updateLspStatusForFile: project.lsp.updateStatus,
  });
  const searchNavigation = useWorkspaceSearchNavigation({
    documentLanguage: editing.documentLanguage,
    bufferState: session.bufferState,
    semanticIndex: session.semanticIndex,
    documents: editing.documents,
    lsp: project.lsp,
    uiActions: project.uiActions,
    setStatusMessage: session.setStatusMessage,
    workspaceInstanceId: session.workspaceInstanceId,
    storeActions: session.storeActions,
    librarySources,
    workspaceUi: session.workspaceUi,
    projectTree: project.projectTree,
    revealNonceRef: surfaceState.revealNonceRef,
    setRevealTarget: surfaceState.setRevealTarget,
    openFile: files.openFile,
    toolWindowRouting: project.toolWindowRouting,
  });

  const structureFileRef = useRef<string | null>(null);
  const documentation = useReferenceDocumentation({
    setPinnedDoc: project.uiActions.setPinnedDoc,
    setReferenceHistory: session.referenceSessions.setReferenceHistory,
    referenceInfoController: session.referenceSessions.referenceInfoController,
    setPinnedDocLocked: project.uiActions.setPinnedDocLocked,
    setRightPaneTab: project.toolWindowRouting.setRightPaneTab,
    setRightPaneOpen: project.toolWindowRouting.setRightPaneOpen,
    setQuickDocOpen: project.uiActions.setQuickDocOpen,
    activeFile: editing.documentLanguage.activeFile,
    editorSelectionRef: session.editorSelectionRef,
    lspDescriptorForFile: project.lsp.descriptorForFile,
    setStatusMessage: session.setStatusMessage,
    showCodeInsightNotice: surfaceState.showCodeInsightNotice,
    lspSessionGeneration: project.lsp.sessionGeneration,
    workspaceInstanceId: session.workspaceInstanceId,
    lspFilesRef: session.bufferState.lspFilesRef,
    openFilesRef: session.bufferState.openFilesRef,
    updateLspStatusForFile: project.lsp.updateStatus,
    setQuickDocContent: project.uiActions.setQuickDocContent,
    pinnedDoc: session.workspaceUi.pinnedDoc,
    pinnedDocLocked: session.workspaceUi.pinnedDocLocked,
    intelligencePreferences: project.intelligence.intelligencePreferences,
    quickDocContent: session.workspaceUi.quickDocContent,
    openLspLocation: librarySources.openLspLocation,
    quickDocOpen: session.workspaceUi.quickDocOpen,
  });
  const editTransactions = useWorkspaceEditTransactions({
    buffers: project.buffers,
    projectTree: project.projectTree,
    bufferState: session.bufferState,
    recoveryState: project.recoveryState,
    workspaceInstanceId: session.workspaceInstanceId,
    lsp: project.lsp,
    navigation: files.navigation,
    uiActions: project.uiActions,
    setRevealTarget: surfaceState.setRevealTarget,
    preferences: session.preferences,
    gitSnapshotOwner: project.gitSnapshotOwner,
    mountedRef: session.mountedRef,
    editState: project.editState,
    semanticIndex: session.semanticIndex,
    editSnapshots: editing.editSnapshots,
    semanticQueries: project.semanticQueries,
    absolutePathForOpenFile: editing.absolutePathForOpenFile,
    mutateOpenBuffer: editing.mutateOpenBuffer,
    updateFileText: editing.updateFileText,
    saves: editing.saves,
    codeStyle: project.codeStyle,
    readWorkspaceEditPathSnapshot: editing.editPlanning.readWorkspaceEditPathSnapshot,
    get codeActions() { return codeActions; },
    setStatusMessage: session.setStatusMessage,
    fileActions: files.fileActions,
  });
  const refactorRecovery = useRefactorRecovery({
    readWorkspaceEditPathSnapshot: editing.editPlanning.readWorkspaceEditPathSnapshot,
    workspaceInstanceIdRef: project.semanticQueries.workspaceInstanceIdRef,
    replayWorkspaceEncodingRef: project.editState.replayWorkspaceEncodingRef,
    replayWorkspaceRestoreRef: project.editState.replayWorkspaceRestoreRef,
    applyLspWorkspaceEditNow: editTransactions.applyLspWorkspaceEditNow,
    restoreEchoSuppressorRef: project.editState.restoreEchoSuppressorRef,
    applyLspResourceOperation: editTransactions.applyLspResourceOperation,
    refreshTree: files.fileActions.refreshTree,
    setStatusMessage: session.setStatusMessage,
    workspaceInstanceId: session.workspaceInstanceId,
    roots: project.projectTree.roots,
  });
  const javaCreation = useWorkspaceJavaCreation({
    fileActions: files.fileActions,
    setStatusMessage: session.setStatusMessage,
    projectTree: project.projectTree,
    applyLspWorkspaceEdit: editTransactions.applyLspWorkspaceEdit,
    uiActions: project.uiActions,
    openFile: files.openFile,
    gitSnapshotOwner: project.gitSnapshotOwner,
  });
  const codeActions = useWorkspaceCodeActions({
    bufferState: session.bufferState,
    semanticIndex: session.semanticIndex,
    documents: editing.documents,
    setStatusMessage: session.setStatusMessage,
    lsp: project.lsp,
    projectAnalysis: project.projectAnalysis,
    workspaceInstanceId: session.workspaceInstanceId,
    inspections: project.inspections,
    projectTree: project.projectTree,
    editSnapshots: editing.editSnapshots,
    applyLspWorkspaceEdit: editTransactions.applyLspWorkspaceEdit,
    get refactoring() { return context.refactoring; },
    editState: project.editState,
  });
  const codeGeneration = useCodeGeneration({
    activeFile: editing.documentLanguage.activeFile,
    setStatusMessage: session.setStatusMessage,
    setGenerateCode: project.uiActions.setGenerateCode,
    editorSelectionRef: session.editorSelectionRef,
    requestCodeActions: codeActions.requestCodeActions,
    generateCodeContextRef: project.uiActions.generateCodeContextRef,
    semanticIndex: session.semanticIndex,
    runCodeAction: codeActions.runCodeAction,
  });
  return {
    codeActions,
    structureFileRef,
    librarySources,
    gitDecorations,
    javaCreation,
    editTransactions,
    codeGeneration,
    searchNavigation,
    documentation,
    hierarchy,
    activeGitRoot,
    refactorRecovery,
    openGitManager,
    deferredOpenFiles,
    gitManagerPayload,
    statusBridge,
    openFileTodos,
    activeRoot,
    title,
    encodingOwner,
  };
}
