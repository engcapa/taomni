import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect } from "react";
import { flushSync } from "react-dom";
import { useMountedRef } from "../../../../hooks/useMountedRef";
import { lspResolveWorkspaceEdit, type LspWorkspaceApplyEditRequest, type LspWorkspaceEdit, type LspWorkspaceEditOperation } from "../../../../lib/editor/lsp";
import type { EditorRevealTarget } from "../EditorGroup";
import { errorMessage, fsPathComparisonKey, type OpenFileState } from "../codeWorkspaceModel";
import { type WorkspaceEditApplyOptions } from "../controller/mutationTypes";
import { createApplyLspResourceOperationUnlocked } from "../controller/resourceActions";
import { useWorkspacePreferences } from "../controller/useWorkspacePreferences";
import { createApplyLspWorkspaceEditNow } from "../controller/workspaceEditActions";
import { useWorkspaceFileActions } from "../useWorkspaceFileActions";
import { useWorkspaceGitSnapshots } from "../useWorkspaceGitSnapshots";
import { useWorkspaceLspSession } from "../useWorkspaceLspSession";
import { useWorkspaceNavigation } from "../useWorkspaceNavigation";
import { useWorkspaceSemanticIndex } from "../useWorkspaceSemanticIndex";
import { workspaceEditApplyResponse } from "../workspaceEditApply";
import { buildWorkspacePathSnapshotEdit, type WorkspaceEditPathSnapshot } from "../workspaceEditHistory";
import { formatWorkspaceEditPreview } from "../workspaceEditPreview";
import { useWorkspaceBufferState } from "./useWorkspaceBufferState";
import { useWorkspaceCodeActions } from "./useWorkspaceCodeActions";
import { useWorkspaceCodeStyle } from "./useWorkspaceCodeStyle";
import { useWorkspaceEditSnapshots } from "./useWorkspaceEditSnapshots";
import { useWorkspaceEditState } from "./useWorkspaceEditState";
import { useWorkspaceRecoveryState } from "./useWorkspaceRecoveryState";
import { useWorkspaceSave } from "./useWorkspaceSave";
import { useWorkspaceSemanticQueries } from "./useWorkspaceSemanticQueries";
import { useWorkspaceTreeModel } from "./useWorkspaceTreeModel";
import { useWorkspaceUiActions } from "./useWorkspaceUiActions";


export interface UseWorkspaceEditTransactionsContext {
  buffers: { setLspFiles: (updater: Record<string, import("../codeWorkspaceModel").LspFileState> | ((prev: Record<string, import("../codeWorkspaceModel").LspFileState>) => Record<string, import("../codeWorkspaceModel").LspFileState>)) => void; flushPendingEditorText: () => void; setOpenFiles: (updater: Record<string, OpenFileState> | ((prev: Record<string, OpenFileState>) => Record<string, OpenFileState>)) => void; replaceWorkspaceFileState: (nextOpenFiles: Record<string, OpenFileState>, nextLspFiles: Record<string, import("../codeWorkspaceModel").LspFileState>, keyChanges: Record<string, string | null>) => void; };
  projectTree: ReturnType<typeof useWorkspaceTreeModel>;
  bufferState: ReturnType<typeof useWorkspaceBufferState>;
  recoveryState: ReturnType<typeof useWorkspaceRecoveryState>;
  workspaceInstanceId: string;
  lsp: ReturnType<typeof useWorkspaceLspSession>;
  navigation: ReturnType<typeof useWorkspaceNavigation>;
  uiActions: ReturnType<typeof useWorkspaceUiActions>;
  setRevealTarget: import("react").Dispatch<import("react").SetStateAction<EditorRevealTarget | null>>;
  preferences: ReturnType<typeof useWorkspacePreferences>;
  gitSnapshotOwner: ReturnType<typeof useWorkspaceGitSnapshots>;
  mountedRef: ReturnType<typeof useMountedRef>;
  editState: ReturnType<typeof useWorkspaceEditState>;
  semanticIndex: ReturnType<typeof useWorkspaceSemanticIndex>;
  editSnapshots: ReturnType<typeof useWorkspaceEditSnapshots>;
  semanticQueries: ReturnType<typeof useWorkspaceSemanticQueries>;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  mutateOpenBuffer: (key: string, patch: import("../controller/mutationTypes").BufferMutationPatch, reason: import("../controller/mutationTypes").MutationReason) => OpenFileState | null;
  updateFileText: (key: string, text: string) => void;
  saves: ReturnType<typeof useWorkspaceSave>;
  codeStyle: ReturnType<typeof useWorkspaceCodeStyle>;
  readWorkspaceEditPathSnapshot: (absolutePath: string) => Promise<WorkspaceEditPathSnapshot | null>;
  codeActions: ReturnType<typeof useWorkspaceCodeActions>;
  setStatusMessage: (message: string) => void;
  fileActions: ReturnType<typeof useWorkspaceFileActions>;
}

export function useWorkspaceEditTransactions(context: UseWorkspaceEditTransactionsContext) {
  const {
    buffers,
    projectTree,
    bufferState,
    recoveryState,
    workspaceInstanceId,
    lsp,
    navigation,
    uiActions,
    setRevealTarget,
    preferences,
    gitSnapshotOwner,
    mountedRef,
    editState,
    semanticIndex,
    editSnapshots,
    semanticQueries,
    absolutePathForOpenFile,
    mutateOpenBuffer,
    updateFileText,
    saves,
    codeStyle,
    readWorkspaceEditPathSnapshot,
    setStatusMessage,
    fileActions,
  } = context;

  const applyLspResourceOperationUnlocked = useCallback(createApplyLspResourceOperationUnlocked({
    flushPendingEditorText: buffers.flushPendingEditorText,
    rootsRef: projectTree.rootsRef,
    openFilesRef: bufferState.openFilesRef,
    saveTransactionRegistryRef: recoveryState.saveTransactionRegistryRef,
    workspaceInstanceId,
    closeLspDocument: lsp.closeDocument,
    lspFilesRef: bufferState.lspFilesRef,
    reconcileNavigationFileReferences: navigation.reconcileFileReferences,
    setExpandedDirs: uiActions.setExpandedDirs,
    setSelected: uiActions.setSelected,
    replaceWorkspaceFileState: buffers.replaceWorkspaceFileState,
    setRevealTarget,
    bookmarksRef: preferences.bookmarksRef,
    looseFilesRef: projectTree.looseFilesRef,
    replaceBookmarks: preferences.replaceBookmarks,
    syncLspDocument: lsp.syncDocument,
    notifyWorkspacePathGitChanged: gitSnapshotOwner.notifyWorkspacePathGitChanged,
  }), [
    lsp.closeDocument,
    buffers.flushPendingEditorText,
    gitSnapshotOwner.notifyWorkspacePathGitChanged,
    preferences.replaceBookmarks,
    navigation.reconcileFileReferences,
    buffers.replaceWorkspaceFileState,
    uiActions.setExpandedDirs,
    uiActions.setSelected,
    lsp.syncDocument,
    workspaceInstanceId,
  ]);

  const applyLspResourceOperation = useCallback(async (
    operation: Exclude<LspWorkspaceEditOperation, { kind: "text"; }>,
  ) => {
    if (mountedRef.current) {
      flushSync(() => editState.setWorkspaceResourceOperationLocked(true));
    }
    try {
      const result = await applyLspResourceOperationUnlocked(operation);
      const paths = operation.kind === "rename"
        ? [operation.oldPath, operation.newPath]
        : [operation.path];
      semanticIndex.invalidate(
        "resource-operation",
        paths.filter((path): path is string => !!path),
      );
      return result;
    } finally {
      if (mountedRef.current) {
        flushSync(() => editState.setWorkspaceResourceOperationLocked(false));
      }
    }
  }, [applyLspResourceOperationUnlocked, mountedRef, semanticIndex.invalidate]);

  useEffect(() => {
    editState.fileActionResourceOperationRef.current = applyLspResourceOperation;
    return () => {
      if (editState.fileActionResourceOperationRef.current === applyLspResourceOperation) {
        editState.fileActionResourceOperationRef.current = null;
      }
    };
  }, [applyLspResourceOperation]);

  const applyLspWorkspaceEditNow = useCallback(createApplyLspWorkspaceEditNow({
    captureWorkspaceEditPathSnapshots: editSnapshots.captureWorkspaceEditPathSnapshots,
    captureWorkspaceEditBookmarkSnapshot: editSnapshots.captureWorkspaceEditBookmarkSnapshot,
    captureWorkspaceEditTabSnapshot: editSnapshots.captureWorkspaceEditTabSnapshot,
    workspaceInstanceIdRef: semanticQueries.workspaceInstanceIdRef,
    workspaceInstanceId,
    rootsRef: projectTree.rootsRef,
    openFilesRef: bufferState.openFilesRef,
    absolutePathForOpenFile,
    workspaceResourceOperationLockedRef: editState.workspaceResourceOperationLockedRef,
    lspDocumentVersion: lsp.documentVersion,
    isLspDocumentSynced: lsp.isDocumentSynced,
    replayWorkspaceRestoreRef: editState.replayWorkspaceRestoreRef,
    mutateOpenBuffer,
    updateFileText,
    saveOpenBufferText: saves.saveOpenBufferText,
    replayWorkspaceEncodingRef: editState.replayWorkspaceEncodingRef,
    workspaceStyleControllerRef: codeStyle.workspaceStyleControllerRef,
    commitClosedFilePreparedSave: saves.commitClosedFilePreparedSave,
    readWorkspaceEditPathSnapshot,
    get setRefactoringPreviewModal() { return context.codeActions.setRefactoringPreviewModal; },
    semanticIndex,
    applyLspResourceOperation,
    setStatusMessage,
    refreshTree: fileActions.refreshTree,
    workspaceEditHistorySequenceRef: editState.workspaceEditHistorySequenceRef,
    replayWorkspacePathSnapshotsRef: editState.replayWorkspacePathSnapshotsRef,
    restoreWorkspaceBookmarkSnapshot: editSnapshots.restoreWorkspaceBookmarkSnapshot,
    restoreWorkspaceEditTabs: editSnapshots.restoreWorkspaceEditTabs,
    workspaceEditHistory: editState.workspaceEditHistory,
    setWorkspaceEditHistoryRevision: editState.setWorkspaceEditHistoryRevision,
  }), [
    absolutePathForOpenFile,
    applyLspResourceOperation,
    editSnapshots.captureWorkspaceEditBookmarkSnapshot,
    editSnapshots.captureWorkspaceEditPathSnapshots,
    editSnapshots.captureWorkspaceEditTabSnapshot,
    saves.commitClosedFilePreparedSave,
    formatWorkspaceEditPreview,
    lsp.isDocumentSynced,
    lsp.documentVersion,
    mutateOpenBuffer,
    readWorkspaceEditPathSnapshot,
    fileActions.refreshTree,
    saves.saveOpenBufferText,
    setStatusMessage,
    editSnapshots.restoreWorkspaceEditTabs,
    editSnapshots.restoreWorkspaceBookmarkSnapshot,
    semanticIndex.invalidate,
    semanticIndex.current,
    updateFileText,
    editState.workspaceEditHistory,
    workspaceInstanceId,
  ]);

  editState.replayWorkspacePathSnapshotsRef.current = async (snapshots) => {
    const currentSnapshots = await Promise.all(
      snapshots.map((snapshot) => readWorkspaceEditPathSnapshot(snapshot.path)),
    );
    if (!currentSnapshots.every(
      (snapshot): snapshot is WorkspaceEditPathSnapshot => snapshot !== null,
    )) {
      throw new Error("A workspace history path is not a regular file");
    }
    editState.replayWorkspaceEncodingRef.current = new Map(
      snapshots
        .filter((snapshot) => snapshot.exists)
        .map((snapshot) => [
          fsPathComparisonKey(snapshot.path),
          {
            encoding: snapshot.encoding ?? "UTF-8",
            bom: snapshot.bom ?? false,
            eol: snapshot.eol,
          },
        ]),
    );
    try {
      // ED-AUDIT-008: open-buffer writes inside this replay are restores, not
      // fresh edits — the journal transaction owns their history.
      editState.replayWorkspaceRestoreRef.current = true;
      try {
        const outcomes = await applyLspWorkspaceEditNow(
          buildWorkspacePathSnapshotEdit(currentSnapshots, snapshots),
          { recordHistory: false },
        );
        const response = workspaceEditApplyResponse(outcomes);
        if (!response.applied) {
          throw new Error(response.failureReason ?? "Workspace history replay failed");
        }
      } finally {
        editState.replayWorkspaceRestoreRef.current = false;
      }
    } finally {
      editState.replayWorkspaceEncodingRef.current = null;
    }
  };

  const applyLspWorkspaceEdit = useCallback((
    edit: LspWorkspaceEdit,
    options: WorkspaceEditApplyOptions = {},
  ) => {
    editState.pendingWorkspaceEditsRef.current += 1;
    const pending = editState.workspaceEditQueueRef.current
      .then(() => applyLspWorkspaceEditNow(edit, options))
      .finally(() => { editState.pendingWorkspaceEditsRef.current -= 1; });
    editState.workspaceEditQueueRef.current = pending.then(() => undefined, () => undefined);
    return pending;
  }, [applyLspWorkspaceEditNow]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void listen<LspWorkspaceApplyEditRequest>("lsp://workspace-apply-edit", (event) => {
      const request = event.payload;
      if (request.workspaceId !== workspaceInstanceId) return;
      void (async () => {
        try {
          const semanticGuard = editState.providerCommandSemanticGuardRef.current;
          const outcomes = await applyLspWorkspaceEdit(request.edit, {
            preview: true,
            label: request.label ?? "Language server changes",
            semanticGeneration: semanticGuard?.generation,
            semanticRevision: semanticGuard?.revision,
            semanticRequireReady: semanticGuard?.requireReady,
          });
          const response = workspaceEditApplyResponse(outcomes);
          await lspResolveWorkspaceEdit(
            request.requestId,
            workspaceInstanceId,
            response.applied,
            response.failureReason,
            response.failedChange,
          );
        } catch (error) {
          const message = errorMessage(error);
          setStatusMessage(message);
          await lspResolveWorkspaceEdit(
            request.requestId,
            workspaceInstanceId,
            false,
            message,
          ).catch(() => undefined);
        }
      })();
    }).then((next) => {
      if (disposed) next();
      else unlisten = next;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applyLspWorkspaceEdit, setStatusMessage, workspaceInstanceId]);
  return { applyLspWorkspaceEditNow, applyLspResourceOperation, applyLspWorkspaceEdit };
}
