import { useCallback, useEffect, useRef } from "react";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import { type LspFileState, type OpenFileState } from "../codeWorkspaceModel";
import { reconcileWorkspaceRecoveryEntries } from "../workspaceRecovery";
import { changedWorkspaceSemanticBufferPaths } from "../workspaceSemanticIndex";


export interface UseWorkspaceBufferStoreContext {
  pendingEditorTextTimerRef: import("react").RefObject<number | null>;
  pendingEditorTextByFileRef: import("react").RefObject<Map<string, import("../editorGroupTypes").OpenFileViewModel>>;
  flushPendingEditLocationsRef: import("react").RefObject<() => void>;
  workspaceInstanceId: string;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  updateStoreOpenFiles: (instanceId: string, updater: Record<string, import("../editorGroupTypes").OpenFileViewModel> | ((prev: Record<string, import("../editorGroupTypes").OpenFileViewModel>) => Record<string, import("../editorGroupTypes").OpenFileViewModel>)) => void;
  semanticIndex: import("../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
  pendingWorkspaceRecoveryKeysRef: import("react").RefObject<Set<string>>;
  liveLspSyncTimersRef: import("react").RefObject<Record<string, number>>;
  disposeWorkspaceUi: (instanceId: string) => void;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  updateStoreLspFiles: (instanceId: string, updater: Record<string, LspFileState> | ((prev: Record<string, LspFileState>) => Record<string, LspFileState>)) => void;
  replaceStoreFileState: (instanceId: string, replacement: import("../../../../stores/codeWorkspaceStore").CodeWorkspaceFileStateReplacement) => void;
}

export function useWorkspaceBufferStore(context: UseWorkspaceBufferStoreContext) {
  const {
    pendingEditorTextTimerRef,
    pendingEditorTextByFileRef,
    flushPendingEditLocationsRef,
    workspaceInstanceId,
    openFilesRef,
    updateStoreOpenFiles,
    semanticIndex,
    pendingWorkspaceRecoveryKeysRef,
    liveLspSyncTimersRef,
    disposeWorkspaceUi,
    lspFilesRef,
    updateStoreLspFiles,
    replaceStoreFileState,
  } = context;

  const flushPendingEditorText = useCallback(() => {
    if (pendingEditorTextTimerRef.current !== null) {
      window.clearTimeout(pendingEditorTextTimerRef.current);
      pendingEditorTextTimerRef.current = null;
    }
    const pending = pendingEditorTextByFileRef.current;
    if (pending.size === 0) return;
    flushPendingEditLocationsRef.current();
    const current = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).openFiles;
    let next = current;
    for (const [key, file] of pending) {
      // A close/reload may have removed the buffer while its input callback
      // was queued. Do not resurrect it.
      if (!(key in current) || current[key] === file) continue;
      if (next === current) next = { ...current };
      next[key] = file;
    }
    pending.clear();
    if (next === current) return;
    openFilesRef.current = next;
    updateStoreOpenFiles(workspaceInstanceId, next);
    semanticIndex.publishCurrent();
  }, [semanticIndex.publishCurrent, updateStoreOpenFiles, workspaceInstanceId]);
  const setOpenFiles = useCallback((
    updater: Record<string, OpenFileState> | ((prev: Record<string, OpenFileState>) => Record<string, OpenFileState>),
  ) => {
    // External operations (save, reload, rename, close, WorkspaceEdit) need
    // a coherent current buffer, so they flush any in-progress typing first.
    flushPendingEditorText();
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).openFiles;
    const next = typeof updater === "function" ? updater(prev) : updater;
    if (next === prev) return;
    const changedPaths = changedWorkspaceSemanticBufferPaths(prev, next);
    if (changedPaths.length > 0) {
      semanticIndex.invalidate("document-edited", changedPaths);
    }
    openFilesRef.current = next;
    updateStoreOpenFiles(workspaceInstanceId, next);
  }, [
    flushPendingEditorText,
    semanticIndex.invalidate,
    updateStoreOpenFiles,
    workspaceInstanceId,
  ]);

  /** Pending store teardown, so a StrictMode remount can cancel it (below). */
  const disposeTimerRef = useRef<{ timer: number; instanceId: string; } | null>(null);
  useEffect(() => {
    // A remount of the SAME workspace cancels a teardown scheduled by the
    // previous cleanup. React StrictMode runs mount → cleanup → mount in
    // development, and disposing the store instance is NOT idempotent: it
    // deletes openOrder / activeKey / editorGroups outright. Running it
    // mid-mount dropped the writes the first pass had already made, so the
    // restored initial file sat in `openFiles` but in no editor group — the tab
    // rendered with no editor at all (and with no active file the Java Debug
    // button stays disabled). Deferring the teardown by a macrotask lets the
    // remount cancel it; a real unmount has no remount to cancel, so the
    // instance is still released a tick later.
    //
    // Only a matching instance id may cancel: a tab can be rebound to a
    // different workspace without unmounting, and cancelling there would leak
    // the previous instance's entry forever.
    const pending = disposeTimerRef.current;
    if (pending != null && pending.instanceId === workspaceInstanceId) {
      window.clearTimeout(pending.timer);
      disposeTimerRef.current = null;
    }
    return () => {
      // Capture this workspace's flush callback in the effect closure. A tab can
      // be rebound to a different workspace without unmounting, and a ref read
      // during cleanup would then point at the new instance.
      const instanceId = workspaceInstanceId;
      flushPendingEditorText();
      // Persist the final live buffer synchronously on teardown; the debounced
      // effect may not have fired yet when the app is closed or the renderer
      // is being replaced.
      reconcileWorkspaceRecoveryEntries(
        instanceId,
        openFilesRef.current,
        pendingWorkspaceRecoveryKeysRef.current,
      );
      for (const timer of Object.values(liveLspSyncTimersRef.current)) {
        window.clearTimeout(timer);
      }
      liveLspSyncTimersRef.current = {};
      const timer = window.setTimeout(() => {
        if (disposeTimerRef.current?.timer === timer) disposeTimerRef.current = null;
        disposeWorkspaceUi(instanceId);
      }, 0);
      disposeTimerRef.current = { timer, instanceId };
    };
  }, [disposeWorkspaceUi, flushPendingEditorText, workspaceInstanceId]);

  const setLspFiles = useCallback((
    updater: Record<string, LspFileState> | ((prev: Record<string, LspFileState>) => Record<string, LspFileState>),
  ) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).lspFiles;
    const next = typeof updater === "function" ? updater(prev) : updater;
    lspFilesRef.current = next;
    updateStoreLspFiles(workspaceInstanceId, next);
  }, [updateStoreLspFiles, workspaceInstanceId]);

  const replaceWorkspaceFileState = useCallback((
    nextOpenFiles: Record<string, OpenFileState>,
    nextLspFiles: Record<string, LspFileState>,
    keyChanges: Record<string, string | null>,
  ) => {
    openFilesRef.current = nextOpenFiles;
    lspFilesRef.current = nextLspFiles;
    replaceStoreFileState(workspaceInstanceId, {
      openFiles: nextOpenFiles,
      lspFiles: nextLspFiles,
      keyChanges,
    });
  }, [replaceStoreFileState, workspaceInstanceId]);
  return { setLspFiles, flushPendingEditorText, setOpenFiles, replaceWorkspaceFileState };
}
