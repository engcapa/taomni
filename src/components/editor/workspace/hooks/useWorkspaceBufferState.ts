import { useEffect, useRef } from "react";
import { type LspPosition } from "../../../../lib/editor/lsp";
import { type LibraryBufferInfo, type OpenFileState } from "../codeWorkspaceModel";


export interface UseWorkspaceBufferStateContext {
  workspaceUi: import("../../../../stores/codeWorkspaceStore").CodeWorkspaceInstanceUi;
}

export function useWorkspaceBufferState(context: UseWorkspaceBufferStateContext) {
  const { workspaceUi } = context;
  // Refs declared early so store-backed setters can dual-write latest maps synchronously.
  const openFilesRef = useRef(workspaceUi.openFiles);
  const openOrderRef = useRef(workspaceUi.openOrder);
  const lspFilesRef = useRef(workspaceUi.lspFiles);
  const pendingEditorTextByFileRef = useRef(new Map<string, OpenFileState>());
  const pendingEditorCaretByFileRef = useRef(new Map<string, {
    position: LspPosition;
    offset?: number;
  }>());
  const flushPendingEditLocationsRef = useRef<() => void>(() => { });
  const pendingEditorTextTimerRef = useRef<number | null>(null);
  /** Debounced didChange timers keyed by open-file key (live buffer path). */
  const liveLspSyncTimersRef = useRef<Record<string, number>>({});
  // Library sources opened from the language server (JDK / dependency classes),
  // keyed by editor key so a closed tab can be re-fetched from history.
  const libraryBuffersRef = useRef<Record<string, LibraryBufferInfo>>({});
  // Incremented for each active-buffer revision.  Async LSP responses capture
  // this value so an older response can never repaint a newer buffer.
  const lspDocumentEpochRef = useRef<Record<string, number>>({});
  const lastTrackedBufferTextRef = useRef<Record<string, string>>({});

  useEffect(() => {
    // Store-backed openFiles can lag the live editor buffer while typing is
    // batched. Never clobber pending keystrokes with a stale store snapshot —
    // that used to drop mid-edit text right as completion asked for a sync.
    if (pendingEditorTextByFileRef.current.size === 0) {
      openFilesRef.current = workspaceUi.openFiles;
      return;
    }
    const merged = { ...workspaceUi.openFiles };
    for (const [key, file] of pendingEditorTextByFileRef.current) {
      if (key in merged) merged[key] = file;
    }
    openFilesRef.current = merged;
  }, [workspaceUi.openFiles]);

  useEffect(() => {
    openOrderRef.current = workspaceUi.openOrder;
  }, [workspaceUi.openOrder]);

  useEffect(() => {
    lspFilesRef.current = workspaceUi.lspFiles;
  }, [workspaceUi.lspFiles]);
  return {
    openFilesRef,
    pendingEditorTextTimerRef,
    pendingEditorTextByFileRef,
    flushPendingEditLocationsRef,
    liveLspSyncTimersRef,
    lspFilesRef,
    libraryBuffersRef,
    pendingEditorCaretByFileRef,
    openOrderRef,
    lastTrackedBufferTextRef,
    lspDocumentEpochRef,
  };
}
