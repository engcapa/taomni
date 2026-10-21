import { useCallback, useEffect } from "react";
import { workspaceReadFile, workspaceReadLooseFile, workspaceReadFileWithEncoding, workspaceReadLooseFileWithEncoding } from "../../../../lib/editor/workspace";
import { type LspExternalFileChange } from "../../../../lib/editor/lsp";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore, type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import { type WorkspaceStyleController } from "../workspaceStyleController";
import { SaveTransactionRegistry } from "../saveCommit";
import { type ClosedTabEntry, type WorkspaceTabPolicyV3 } from "../workspaceTabPolicy";
import { isTauriRuntime } from "../../../../lib/runtime";
import { WorkspaceResourceRecoveryCoordinator, type ResourceCleanupHandlers, type ResourceCleanupOutcome } from "../workspaceResourceRecoveryCoordinator";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { type LspFileState, type MarkdownViewMode, type OpenFileState, normalizeEditorText, normalizeFsPath } from "../codeWorkspaceModel";
import { createHandleExternalFileChange, createCloseFile } from "../controller/fileActions";
import { type PendingExternalFileConflict, type PendingExternalFileEvent, type PendingClosedFile, type ExternalDiskSnapshot, externalDiskSnapshot, coalesceExternalFileChange, EXTERNAL_FILE_EVENT_SETTLE_MS } from "../controller/model";

export interface UseWorkspaceFileLifecycleContext {
  findRoot: (rootId: string) => CodeWorkspaceRootInfo | null;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  lastTrackedBufferTextRef: import("react").RefObject<Record<string, string>>;
  mutateOpenBuffer: (key: string, patch: import("../controller/mutationTypes").BufferMutationPatch, reason: import("../controller/mutationTypes").MutationReason) => OpenFileState | null;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  syncLspDocument: (file: OpenFileState, mode: "open" | "change") => Promise<void>;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  setExternalFileConflicts: import("react").Dispatch<import("react").SetStateAction<PendingExternalFileConflict[]>>;
  workspaceStyleControllerRef: import("react").RefObject<WorkspaceStyleController>;
  semanticIndex: import("../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
  refreshTree: () => void;
  restoreEchoSuppressorRef: import("react").RefObject<import("../refactorRecoveryController").RestoreEchoSuppressor>;
  setStatusMessage: (message: string) => void;
  setOpenFiles: (updater: Record<string, OpenFileState> | ((prev: Record<string, OpenFileState>) => Record<string, OpenFileState>)) => void;
  workspaceInstanceId: string;
  pendingExternalFileEventsRef: import("react").RefObject<Map<string, PendingExternalFileEvent>>;
  activeEditorGroupId: string;
  mruFileKeysRef: import("react").RefObject<string[]>;
  closeLayoutTabInLeaf: (instanceId: string, leafId: string, fileKey: string, policy?: import("../workspaceTabPolicy").AnyWorkspaceTabPolicy, lastUsedByKey?: ReadonlyMap<string, number>) => void;
  tabPolicyRef: import("react").RefObject<WorkspaceTabPolicyV3>;
  resourceRecoveryCoordinatorRef: import("react").RefObject<WorkspaceResourceRecoveryCoordinator>;
  pendingClosedFilesRef: import("react").RefObject<Map<string, PendingClosedFile>>;
  setClosedTabsStack: import("react").Dispatch<import("react").SetStateAction<readonly ClosedTabEntry[]>>;
  closeLspDocumentAndWait: (file: OpenFileState) => Promise<void>;
  saveTransactionRegistryRef: import("react").RefObject<SaveTransactionRegistry>;
  setMarkdownModes: (updater: Record<string, MarkdownViewMode> | ((prev: Record<string, MarkdownViewMode>) => Record<string, MarkdownViewMode>)) => void;
  setLspFiles: (updater: Record<string, LspFileState> | ((prev: Record<string, LspFileState>) => Record<string, LspFileState>)) => void;
  observeResourceCleanupOutcome: (outcome: ResourceCleanupOutcome, handlers: ResourceCleanupHandlers) => void;
  closeFileRef: import("react").RefObject<((key: string, groupId?: EditorGroupId, options?: { discard?: boolean; }) => Promise<void>) | null>;
}

export function useWorkspaceFileLifecycle(context: UseWorkspaceFileLifecycleContext) {
  const {
    findRoot,
    openFilesRef,
    lastTrackedBufferTextRef,
    mutateOpenBuffer,
    lspFilesRef,
    syncLspDocument,
    absolutePathForOpenFile,
    setExternalFileConflicts,
    workspaceStyleControllerRef,
    semanticIndex,
    refreshTree,
    restoreEchoSuppressorRef,
    setStatusMessage,
    setOpenFiles,
    workspaceInstanceId,
    pendingExternalFileEventsRef,
    activeEditorGroupId,
    closeLayoutTabInLeaf,
    tabPolicyRef,
    resourceRecoveryCoordinatorRef,
    pendingClosedFilesRef,
    closeLspDocumentAndWait,
    saveTransactionRegistryRef,
    setMarkdownModes,
    setLspFiles,
    observeResourceCleanupOutcome,
    closeFileRef,
  } = context;

  const readDiskSnapshot = useCallback(async (file: OpenFileState): Promise<ExternalDiskSnapshot> => {
    const preferredEncoding = file.encoding ?? "UTF-8";
    const disk = file.ref.kind === "root"
      ? preferredEncoding !== "UTF-8" && typeof workspaceReadFileWithEncoding === "function"
        ? await workspaceReadFileWithEncoding(
          findRoot(file.ref.rootId)?.path ?? "",
          file.ref.path,
          preferredEncoding,
        )
        : await workspaceReadFile(findRoot(file.ref.rootId)?.path ?? "", file.ref.path)
      : preferredEncoding !== "UTF-8" && typeof workspaceReadLooseFileWithEncoding === "function"
        ? await workspaceReadLooseFileWithEncoding(file.ref.path, preferredEncoding)
        : await workspaceReadLooseFile(file.ref.path);
    return externalDiskSnapshot(disk);
  }, [findRoot]);

  const applyDiskSnapshot = useCallback((file: OpenFileState, disk: ExternalDiskSnapshot) => {
    const latest = openFilesRef.current[file.key] ?? file;
    lastTrackedBufferTextRef.current[file.key] = disk.text;
    const next = mutateOpenBuffer(
      file.key,
      {
        text: disk.text,
        savedText: disk.text,
        eol: disk.eol,
        encoding: disk.encoding,
        bom: disk.bom,
        hash: disk.hash,
        mtime: disk.mtime,
        size: disk.size,
        loading: false,
        saving: false,
        dirty: false,
        error: null,
      },
      "reload",
    );
    if (next && latest.text !== next.text && lspFilesRef.current[file.key]?.status?.active) {
      void syncLspDocument(next, "change");
    }
  }, [mutateOpenBuffer, syncLspDocument]);

  const enqueueExternalFileConflict = useCallback((
    file: OpenFileState,
    disk: ExternalDiskSnapshot | null,
  ) => {
    const conflict: PendingExternalFileConflict = {
      key: file.key,
      path: absolutePathForOpenFile(file) ?? file.path,
      baseText: file.savedText,
      localText: file.text,
      disk,
    };
    setExternalFileConflicts((current) => (
      current.some((item) => item.key === conflict.key) ? current : [...current, conflict]
    ));
  }, [absolutePathForOpenFile]);

  const handleExternalFileChange = useCallback(createHandleExternalFileChange({
    workspaceStyleControllerRef,
    semanticIndex,
    openFilesRef,
    absolutePathForOpenFile,
    refreshTree,
    restoreEchoSuppressorRef,
    setStatusMessage,
    enqueueExternalFileConflict,
    setOpenFiles,
    readDiskSnapshot,
    applyDiskSnapshot,
  }), [
    absolutePathForOpenFile,
    applyDiskSnapshot,
    enqueueExternalFileConflict,
    readDiskSnapshot,
    refreshTree,
    semanticIndex.invalidate,
    setOpenFiles,
    setStatusMessage,
  ]);

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen<LspExternalFileChange>("lsp://external-file-change", (event) => {
      const change = event.payload;
      if (change.workspaceId !== workspaceInstanceId) return;
      const pathKey = normalizeFsPath(change.path);
      const pending = pendingExternalFileEventsRef.current.get(pathKey);
      if (pending) window.clearTimeout(pending.timer);
      const merged = pending
        ? coalesceExternalFileChange(pending.change, change)
        : change;
      const timer = window.setTimeout(() => {
        pendingExternalFileEventsRef.current.delete(pathKey);
        if (!disposed) void handleExternalFileChange(merged);
      }, EXTERNAL_FILE_EVENT_SETTLE_MS);
      pendingExternalFileEventsRef.current.set(pathKey, { change: merged, timer });
    }).then((next) => {
      if (disposed) next();
      else unlisten = next;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
      for (const pending of pendingExternalFileEventsRef.current.values()) {
        window.clearTimeout(pending.timer);
      }
      pendingExternalFileEventsRef.current.clear();
    };
  }, [handleExternalFileChange, workspaceInstanceId]);

  const closeFile = useCallback(
    createCloseFile({
    activeEditorGroupId,
    workspaceInstanceId,
    openFilesRef,
    get mruFileKeysRef() { return context.mruFileKeysRef; },
    closeLayoutTabInLeaf,
    tabPolicyRef,
    resourceRecoveryCoordinatorRef,
    pendingClosedFilesRef,
    get setClosedTabsStack() { return context.setClosedTabsStack; },
    closeLspDocumentAndWait,
    pendingExternalFileEventsRef,
    saveTransactionRegistryRef,
    setOpenFiles,
    setMarkdownModes,
    setLspFiles,
    observeResourceCleanupOutcome,
    setStatusMessage,
  }),
    [activeEditorGroupId, closeLayoutTabInLeaf, closeLspDocumentAndWait, observeResourceCleanupOutcome, workspaceInstanceId],
  );
  closeFileRef.current = closeFile;

  const dismissExternalFileConflict = useCallback((key: string) => {
    setExternalFileConflicts((current) => current.filter((item) => item.key !== key));
  }, []);

  const keepLocalExternalFileConflict = useCallback((conflict: PendingExternalFileConflict) => {
    const latest = openFilesRef.current[conflict.key];
    if (latest) {
      const next: OpenFileState = conflict.disk
        ? {
            ...latest,
            savedText: conflict.disk.text,
            eol: conflict.disk.eol,
            encoding: conflict.disk.encoding,
            bom: conflict.disk.bom,
            hash: conflict.disk.hash,
            mtime: conflict.disk.mtime,
            size: conflict.disk.size,
            dirty: latest.text !== conflict.disk.text,
            error: null,
          }
        : {
            ...latest,
            dirty: true,
            error: "File deleted on disk; local changes are preserved",
          };
      setOpenFiles((current) => ({ ...current, [conflict.key]: next }));
      setStatusMessage(conflict.disk
        ? `Kept local changes for ${latest.subtitle}; the next save will replace the disk version`
        : `Kept local changes for deleted file ${latest.subtitle}`);
    }
    dismissExternalFileConflict(conflict.key);
  }, [dismissExternalFileConflict, setOpenFiles, setStatusMessage]);

  const loadDiskExternalFileConflict = useCallback(async (conflict: PendingExternalFileConflict) => {
    const latest = openFilesRef.current[conflict.key];
    if (!latest) {
      dismissExternalFileConflict(conflict.key);
      return;
    }
    if (conflict.disk) {
      applyDiskSnapshot(latest, conflict.disk);
      setStatusMessage(`Loaded disk version of ${latest.subtitle}`);
      dismissExternalFileConflict(conflict.key);
      return;
    }

    const currentUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    for (const group of Object.values(currentUi.editorGroups)) {
      if (group.openOrder.includes(conflict.key)) {
        await closeFile(conflict.key, group.id, { discard: true });
      }
    }
    dismissExternalFileConflict(conflict.key);
    setStatusMessage(`Closed deleted file ${latest.subtitle}`);
  }, [
    applyDiskSnapshot,
    closeFile,
    dismissExternalFileConflict,
    setStatusMessage,
    workspaceInstanceId,
  ]);

  const mergeExternalFileConflict = useCallback((
    conflict: PendingExternalFileConflict,
    mergedText: string,
  ) => {
    const latest = openFilesRef.current[conflict.key];
    const disk = conflict.disk;
    if (!latest || !disk) {
      dismissExternalFileConflict(conflict.key);
      return;
    }
    const normalized = normalizeEditorText(mergedText);
    const next: OpenFileState = {
      ...latest,
      text: normalized.text,
      savedText: disk.text,
      eol: disk.eol,
      encoding: disk.encoding,
      bom: disk.bom,
      hash: disk.hash,
      mtime: disk.mtime,
      size: disk.size,
      dirty: normalized.text !== disk.text,
      error: null,
    };
    setOpenFiles((current) => ({ ...current, [conflict.key]: next }));
    if (latest.text !== next.text && lspFilesRef.current[conflict.key]?.status?.active) {
      void syncLspDocument(next, "change");
    }
    dismissExternalFileConflict(conflict.key);
    setStatusMessage(`Applied merged changes to ${latest.subtitle}`);
  }, [dismissExternalFileConflict, setOpenFiles, setStatusMessage, syncLspDocument]);
  return {
    closeFile,
    keepLocalExternalFileConflict,
    loadDiskExternalFileConflict,
    mergeExternalFileConflict,
    dismissExternalFileConflict,
  };
}
