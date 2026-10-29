import { useCallback } from "react";
import { type EditorSelectionRange } from "../CodeMirrorHost";
import { absoluteWorkspacePath, normalizeFsPath, type OpenFileState } from "../codeWorkspaceModel";
import { createMutateOpenBuffer, createQueueEditorTextUpdate } from "../controller/bufferMutations";
import { useEditorAiActions } from "./useEditorAiActions";
import { useWorkspaceActionPorts } from "./useWorkspaceActionPorts";
import { useWorkspaceAnnouncements } from "./useWorkspaceAnnouncements";
import { useWorkspaceCodeActions } from "./useWorkspaceCodeActions";
import { useWorkspaceDocumentLanguage } from "./useWorkspaceDocumentLanguage";
import { useWorkspaceDocumentSync } from "./useWorkspaceDocumentSync";
import { useWorkspaceEditPlanning } from "./useWorkspaceEditPlanning";
import { useWorkspaceEditSnapshots } from "./useWorkspaceEditSnapshots";
import { useWorkspaceFileLifecycle } from "./useWorkspaceFileLifecycle";
import { useWorkspaceFileOpening } from "./useWorkspaceFileOpening";
import { useWorkspaceKeyboard } from "./useWorkspaceKeyboard";
import { useWorkspaceLocalHistory } from "./useWorkspaceLocalHistory";
import { useWorkspaceProjectRuntime } from "./useWorkspaceProjectRuntime";
import { useWorkspaceSave } from "./useWorkspaceSave";
import { useWorkspaceSession } from "./useWorkspaceSession";
import { useWorkspaceSplits } from "./useWorkspaceSplits";
import { useWorkspaceSurfaceState } from "./useWorkspaceSurfaceState";


export interface UseWorkspaceDocumentEditingContext {
  session: ReturnType<typeof useWorkspaceSession>;
  project: ReturnType<typeof useWorkspaceProjectRuntime>;
  files: ReturnType<typeof useWorkspaceFileOpening>;
  surfaceState: ReturnType<typeof useWorkspaceSurfaceState>;
  ports: ReturnType<typeof useWorkspaceActionPorts>;
  codeActions: ReturnType<typeof useWorkspaceCodeActions>;
  keyboard: ReturnType<typeof useWorkspaceKeyboard>;
  visible: boolean;
}

export function useWorkspaceDocumentEditing(context: UseWorkspaceDocumentEditingContext) {
  const { session, project, files, surfaceState, ports, visible } = context;

  const mutateOpenBuffer = useCallback(createMutateOpenBuffer({
    openFilesRef: session.bufferState.openFilesRef,
    pendingEditorTextByFileRef: session.bufferState.pendingEditorTextByFileRef,
    pendingEditorCaretByFileRef: session.bufferState.pendingEditorCaretByFileRef,
    setOpenFiles: project.buffers.setOpenFiles,
  }), [project.buffers.setOpenFiles]);

  const updateFileText = useCallback((key: string, text: string) => {
    mutateOpenBuffer(key, { text, error: null }, "programmatic");
  }, [mutateOpenBuffer]);
  const documents = useWorkspaceDocumentSync({
    liveLspSyncTimersRef: session.bufferState.liveLspSyncTimersRef,
    openFilesRef: session.bufferState.openFilesRef,
    lspFilesRef: session.bufferState.lspFilesRef,
    isLspDocumentSynced: project.lsp.isDocumentSynced,
    syncLspDocument: project.lsp.syncDocument,
    waitForLspDocumentSyncQueue: project.lsp.waitForSyncQueue,
    semanticIndex: session.semanticIndex,
  });

  const queueEditorTextUpdate = useCallback(createQueueEditorTextUpdate({
    openFilesRef: session.bufferState.openFilesRef,
    workspaceInstanceId: session.workspaceInstanceId,
    updateEditorGroup: project.uiActions.updateEditorGroup,
    workspaceEditHistory: project.editState.workspaceEditHistory,
    setWorkspaceEditHistoryRevision: project.editState.setWorkspaceEditHistoryRevision,
    mutateOpenBuffer,
    pendingEditorCaretByFileRef: session.bufferState.pendingEditorCaretByFileRef,
    editorSelectionRef: session.editorSelectionRef,
    semanticIndex: session.semanticIndex,
    scheduleLiveLspSync: documents.scheduleLiveLspSync,
    pendingEditorTextTimerRef: session.bufferState.pendingEditorTextTimerRef,
    flushPendingEditorText: project.buffers.flushPendingEditorText,
  }), [
    project.buffers.flushPendingEditorText,
    documents.scheduleLiveLspSync,
    session.semanticIndex.invalidateSilently,
    project.uiActions.updateEditorGroup,
    project.editState.workspaceEditHistory,
    session.workspaceInstanceId,
  ]);

  const absolutePathForOpenFile = useCallback((file: OpenFileState): string | null => {
    // Library sources live inside a JAR / the language server, not on disk.
    if (file.library) return null;
    if (file.ref.kind === "loose") return normalizeFsPath(file.ref.path);
    const root = project.projectTree.findRoot(file.ref.rootId);
    if (!root) return null;
    return absoluteWorkspacePath(root, file.ref.path);
  }, [project.projectTree.findRoot]);
  const editPlanning = useWorkspaceEditPlanning({
    bufferState: session.bufferState,
    absolutePathForOpenFile,
    lsp: project.lsp,
    projectTree: project.projectTree,
    workspaceInstanceId: session.workspaceInstanceId,
    editState: project.editState,
  });
  const editSnapshots = useWorkspaceEditSnapshots({
    readWorkspaceEditPathSnapshot: editPlanning.readWorkspaceEditPathSnapshot,
    replayWorkspacePathSnapshotsRef: project.editState.replayWorkspacePathSnapshotsRef,
    openFilesRef: session.bufferState.openFilesRef,
    absolutePathForOpenFile,
    rootsRef: project.projectTree.rootsRef,
    bookmarksRef: session.preferences.bookmarksRef,
    workspaceInstanceId: session.workspaceInstanceId,
    replaceBookmarks: session.preferences.replaceBookmarks,
    setLayoutTreeV2Store: session.storeActions.setLayoutTreeV2Store,
    openFile: files.openFile,
    updateEditorGroup: project.uiActions.updateEditorGroup,
    activateEditorGroup: project.uiActions.activateEditorGroup,
  });
  const localHistory = useWorkspaceLocalHistory({
    openFilesRef: session.bufferState.openFilesRef,
    absolutePathForOpenFile,
    setStatusMessage: session.setStatusMessage,
    editorSelectionRef: session.editorSelectionRef,
    setActiveCompareSession: surfaceState.setActiveCompareSession,
    updateFileText,
  });

  const applySelectionReplacement = useCallback((key: string, range: EditorSelectionRange, nextText: string) => {
    const file = session.bufferState.openFilesRef.current[key];
    if (!file) return;
    const lines = file.text.split("\n");
    const offsetAt = (position: { line: number; character: number; }) => {
      let offset = 0;
      for (let line = 0;line < Math.min(position.line, lines.length);line += 1) {
        offset += (lines[line]?.length ?? 0) + 1;
      }
      const lineText = lines[Math.min(position.line, Math.max(0, lines.length - 1))] ?? "";
      return offset + Math.min(Math.max(0, position.character), lineText.length);
    };
    const from = offsetAt(range.start);
    const to = offsetAt(range.end);
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    const replaced = `${file.text.slice(0, start)}${nextText}${file.text.slice(end)}`;
    updateFileText(key, replaced);
  }, [updateFileText]);
  const editorAi = useEditorAiActions({
    lspFilesRef: session.bufferState.lspFilesRef,
    breadcrumbSymbolsRef: project.telemetry.breadcrumbSymbolsRef,
    activeEditorGroupIdRef: surfaceState.activeEditorGroupIdRef,
    getLspHoverRef: ports.getLspHoverRef,
    editorAiPreferences: session.preferences.editorAiPreferences,
    sendPromptToTabChat: session.sendPromptToTabChat,
    setStatusMessage: session.setStatusMessage,
    t: session.t,
    editorSelectionRef: session.editorSelectionRef,
    activeKey: session.workspaceUi.activeKey,
    openFilesRef: session.bufferState.openFilesRef,
  });
  const saves = useWorkspaceSave({
    openFilesRef: session.bufferState.openFilesRef,
    rootsRef: project.projectTree.rootsRef,
    bumpDiskEffectLedger: project.recoveryState.bumpDiskEffectLedger,
    saveTransactionRegistryRef: project.recoveryState.saveTransactionRegistryRef,
    mutateOpenBuffer,
    absolutePathForOpenFile,
    workspaceStyleControllerRef: project.codeStyle.workspaceStyleControllerRef,
    notifyWorkspacePathGitChanged: project.gitSnapshotOwner.notifyWorkspacePathGitChanged,
    semanticIndex: session.semanticIndex,
    saveLspDocument: project.lsp.saveDocument,
    syncLspDocument: project.lsp.syncDocument,
    workspaceInstanceId: session.workspaceInstanceId,
    lspDescriptorForFile: project.lsp.descriptorForFile,
    lspFilesRef: session.bufferState.lspFilesRef,
    indentationOverridesRef: project.codeStyle.indentationOverridesRef,
    codeStyleSchemesRef: project.codeStyle.codeStyleSchemesRef,
    resolvedCodeStylesRef: project.codeStyle.resolvedCodeStylesRef,
    updateLspStatusForFile: project.lsp.updateStatus,
    findRoot: project.projectTree.findRoot,
    setStatusMessage: session.setStatusMessage,
    activeKey: session.workspaceUi.activeKey,
    lspSessionGeneration: project.lsp.sessionGeneration,
    projectAnalysisSnapshot: project.projectAnalysis.snapshot,
    intelligencePreferences: project.intelligence.intelligencePreferences,
    get canonicalCodeActionServiceRef() { return context.codeActions.canonicalCodeActionServiceRef; },
    setSaveObservations: project.recoveryState.setSaveObservations,
    publishWorkspaceObservation: session.publishWorkspaceObservation,
    setOpenFiles: project.buffers.setOpenFiles,
  });
  const fileLifecycle = useWorkspaceFileLifecycle({
    findRoot: project.projectTree.findRoot,
    openFilesRef: session.bufferState.openFilesRef,
    lastTrackedBufferTextRef: session.bufferState.lastTrackedBufferTextRef,
    mutateOpenBuffer,
    lspFilesRef: session.bufferState.lspFilesRef,
    syncLspDocument: project.lsp.syncDocument,
    absolutePathForOpenFile,
    setExternalFileConflicts: surfaceState.setExternalFileConflicts,
    workspaceStyleControllerRef: project.codeStyle.workspaceStyleControllerRef,
    semanticIndex: session.semanticIndex,
    refreshTree: project.projectTree.treeData.refreshPath,
    restoreEchoSuppressorRef: project.editState.restoreEchoSuppressorRef,
    setStatusMessage: session.setStatusMessage,
    setOpenFiles: project.buffers.setOpenFiles,
    workspaceInstanceId: session.workspaceInstanceId,
    pendingExternalFileEventsRef: surfaceState.pendingExternalFileEventsRef,
    activeEditorGroupId: session.workspaceUi.activeEditorGroupId,
    get mruFileKeysRef() { return context.keyboard.mruFileKeysRef; },
    closeLayoutTabInLeaf: session.storeActions.closeLayoutTabInLeaf,
    tabPolicyRef: session.tabPolicyOwner.tabPolicyRef,
    resourceRecoveryCoordinatorRef: project.recoveryState.resourceRecoveryCoordinatorRef,
    pendingClosedFilesRef: files.pendingClosedFilesRef,
    get setClosedTabsStack() { return surfaceState.setClosedTabsStack; },
    closeLspDocumentAndWait: project.lsp.closeDocumentAndWait,
    saveTransactionRegistryRef: project.recoveryState.saveTransactionRegistryRef,
    setMarkdownModes: project.uiActions.setMarkdownModes,
    setLspFiles: project.buffers.setLspFiles,
    observeResourceCleanupOutcome: project.recoveryState.observeResourceCleanupOutcome,
    closeFileRef: files.closeFileRef,
  });
  const splits = useWorkspaceSplits({
    updateEditorGroup: project.uiActions.updateEditorGroup,
    closeFile: fileLifecycle.closeFile,
    activeKey: session.workspaceUi.activeKey,
    activeEditorGroupId: session.workspaceUi.activeEditorGroupId,
    openFilesRef: session.bufferState.openFilesRef,
    splitLayoutLeaf: session.storeActions.splitLayoutLeaf,
    workspaceInstanceId: session.workspaceInstanceId,
    closeLayoutLeaf: session.storeActions.closeLayoutLeaf,
    workspaceUi: session.workspaceUi,
    setStoreActiveEditorGroup: session.storeActions.setStoreActiveEditorGroup,
    setStatusMessage: session.setStatusMessage,
    moveLayoutTabStore: session.storeActions.moveLayoutTabStore,
    equalizeLayoutRatiosStore: session.storeActions.equalizeLayoutRatiosStore,
    stretchLayoutLeafStore: session.storeActions.stretchLayoutLeafStore,
    unsplitAllLayoutStore: session.storeActions.unsplitAllLayoutStore,
  });
  const documentLanguage = useWorkspaceDocumentLanguage({
    workspaceUi: session.workspaceUi,
    lsp: project.lsp,
    bufferState: session.bufferState,
    intelligence: project.intelligence,
    visible,
    documents,
    telemetry: project.telemetry,
    projectTree: project.projectTree,
  });
  const announcements = useWorkspaceAnnouncements({
    activeKey: session.workspaceUi.activeKey,
    recoveryState: project.recoveryState,
    activeFile: documentLanguage.activeFile,
    uiActions: project.uiActions,
  });
  return {
    documentLanguage,
    mutateOpenBuffer,
    documents,
    editSnapshots,
    absolutePathForOpenFile,
    updateFileText,
    saves,
    editPlanning,
    localHistory,
    editorAi,
    fileLifecycle,
    splits,
    queueEditorTextUpdate,
    applySelectionReplacement,
    announcements,
  };
}
