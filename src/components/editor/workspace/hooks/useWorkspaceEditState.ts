import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type LspWorkspaceEditOperation } from "../../../../lib/editor/lsp";
import { errorMessage } from "../codeWorkspaceModel";
import { createRestoreEchoSuppressor } from "../refactorRecoveryController";
import { WorkspaceDocumentTransactionOwner } from "../workspaceDocumentTransactionOwner";
import { WorkspaceEditHistory, type WorkspaceEditPathSnapshot } from "../workspaceEditHistory";
import { WorkspaceObservationBridge } from "../workspaceObservationBridge";
import { useWorkspaceDocumentLifetime } from "./useWorkspaceDocumentLifetime";


export interface UseWorkspaceEditStateContext {
  publishWorkspaceObservation: (update: (bridge: WorkspaceObservationBridge) => void) => void;
  workspaceInstanceId: string;
  setStatusMessage: (message: string) => void;
  searchEverywhereTriggerRef: import("react").RefObject<HTMLElement | null>;
}

export function useWorkspaceEditState(context: UseWorkspaceEditStateContext) {
  const { publishWorkspaceObservation, workspaceInstanceId, setStatusMessage, searchEverywhereTriggerRef } = context;
  const [workspaceUndoConfirmOpen, setWorkspaceUndoConfirmOpen] = useState(false);
  const undoConfirmTriggerRef = useRef<HTMLElement | null>(null);
  const [workspaceResourceOperationLocked, setWorkspaceResourceOperationLocked] = useState(false);
  // ED-IMPROVE-001: live mirror so an awaited rearrange/cleanup run observes a
  // read-only toggle that happens after the callback closure was created.
  const workspaceResourceOperationLockedRef = useRef(workspaceResourceOperationLocked);
  workspaceResourceOperationLockedRef.current = workspaceResourceOperationLocked;
  // ED-IMPROVE-001: monotonic per-workflow request tokens. A newer invocation
  // (double entry) supersedes the in-flight one, which then fails typed stale
  // before any mutation.
  const rearrangeRequestTokenRef = useRef(0);
  const cleanupRequestTokenRef = useRef(0);
  const workspaceEditQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingWorkspaceEditsRef = useRef(0);
  const pendingWorkspaceHistoryClaimRef = useRef(false);
  const providerCommandSemanticGuardRef = useRef<{
    generation: number;
    revision: number;
    requireReady: boolean;
  } | null>(null);
  const providerCommandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const fileActionResourceOperationRef = useRef<((
    operation: Exclude<LspWorkspaceEditOperation, { kind: "text"; }>,
  ) => Promise<void>) | null>(null);
  // CodeMirror owns character-level history. This separate stack groups a
  // multi-file WorkspaceEdit into one IDEA-style transaction.
  const workspaceEditHistoryRef = useRef<WorkspaceEditHistory | null>(null);
  if (workspaceEditHistoryRef.current === null) {
    workspaceEditHistoryRef.current = new WorkspaceEditHistory();
  }
  const [workspaceEditHistoryRevision, setWorkspaceEditHistoryRevision] = useState(0);
  const workspaceEditHistory = workspaceEditHistoryRef.current;
  const workspaceEditHistorySequenceRef = useRef(0);
  const replayWorkspacePathSnapshotsRef = useRef<(
    snapshots: readonly WorkspaceEditPathSnapshot[],
  ) => Promise<void>>(async () => {
    throw new Error("Workspace resource history is not ready");
  });
  const replayWorkspaceEncodingRef = useRef<Map<string, { encoding: string; bom: boolean; eol?: "lf" | "crlf" | "cr"; }> | null>(null);
  // ED-AUDIT-014: comparison keys of closed-file paths just written by a
  // refactor restore, so the file-watcher echo of our own write does not
  // overwrite the "Refactor recovery complete" status with a misleading
  // "File changed on disk" note. Only the status message is suppressed.
  const restoreEchoSuppressorRef = useRef(createRestoreEchoSuppressor());
  // ED-AUDIT-008: set while a workspace-history restore replays through the
  // workspace-edit funnel. Open-buffer writes made inside that window are
  // recorded as "history-replay" mutations so the editor hosts treat the
  // resulting store snapshot as a journal-owned restore (origin "undo") and
  // never mirror it as a second undoable document entry.
  const replayWorkspaceRestoreRef = useRef(false);
  const documentTransactionOwnerRef = useRef(new WorkspaceDocumentTransactionOwner({
    onTransaction: ({ fileKey, revision }) => {
      publishWorkspaceObservation((bridge) => bridge.observeDocumentRevision(fileKey, revision));
    },
    onHistoryReceipt: ({ fileKey, revision }) => {
      publishWorkspaceObservation((bridge) => bridge.observeHistoryReceipt(`${fileKey}:${revision}`));
    },
    onViewLeaseChanged: ({ delta }) => {
      publishWorkspaceObservation((bridge) => bridge.observeLeaseDelta(delta));
    },
  }));
  useWorkspaceDocumentLifetime(workspaceInstanceId, documentTransactionOwnerRef.current);

  useEffect(() => {
    workspaceEditHistory.clear();
    setWorkspaceEditHistoryRevision((revision) => revision + 1);
  }, [workspaceEditHistory, workspaceInstanceId]);

  // ED-IMPROVE-001: switching the workspace supersedes any in-flight
  // rearrange/cleanup identity even before readLive observes the switch.
  useEffect(() => {
    rearrangeRequestTokenRef.current += 1;
    cleanupRequestTokenRef.current += 1;
  }, [workspaceInstanceId]);

  const workspaceEditHistoryState = useMemo(
    () => workspaceEditHistory.state(),
    [workspaceEditHistory, workspaceEditHistoryRevision],
  );

  const undoWorkspaceEdit = useCallback(async () => {
    try {
      const result = await workspaceEditHistory.undo();
      if (result) {
        setStatusMessage(`Undid ${result.entry.label} (${result.entry.affectedPaths.length} files)`);
      }
    } catch (error) {
      setStatusMessage(`Cannot undo workspace edit: ${errorMessage(error)}`);
    } finally {
      setWorkspaceEditHistoryRevision((revision) => revision + 1);
    }
  }, [setStatusMessage, workspaceEditHistory]);

  const requestWorkspaceUndoConfirmation = useCallback(() => {
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    undoConfirmTriggerRef.current = activeElement?.closest('[data-testid="code-workspace-search-everywhere"]')
      ? searchEverywhereTriggerRef.current
      : activeElement;
    setWorkspaceUndoConfirmOpen(true);
  }, []);

  const closeWorkspaceUndoConfirmation = useCallback(() => {
    setWorkspaceUndoConfirmOpen(false);
  }, []);

  const redoWorkspaceEdit = useCallback(async () => {
    try {
      const result = await workspaceEditHistory.redo();
      if (result) {
        setStatusMessage(`Redid ${result.entry.label} (${result.entry.affectedPaths.length} files)`);
      }
    } catch (error) {
      setStatusMessage(`Cannot redo workspace edit: ${errorMessage(error)}`);
    } finally {
      setWorkspaceEditHistoryRevision((revision) => revision + 1);
    }
  }, [setStatusMessage, workspaceEditHistory]);

  // ED-AUDIT-008: the workspace-edit journal and the per-document CodeMirror
  // ledger are two history owners over the same Ctrl+Z stroke. The newest
  // user-visible transaction wins: while the journal can serve the requested
  // direction the editor's shared undo/redo routes there; `undefined` hands
  // the stroke back to the document ledger (character-level history). A busy
  // journal blocks the stroke entirely so a document undo can never interleave
  // with a running multi-file restore.
  const claimWorkspaceHistory = useCallback((action: "undo" | "redo"): boolean | undefined => {
    if (pendingWorkspaceHistoryClaimRef.current) return false;
    if (pendingWorkspaceEditsRef.current > 0) {
      // Writes become visible before post-state verification registers their
      // history. Keep this stroke with the multi-file transaction; falling
      // through here would undo only the open document and strand disk edits.
      const sequence = workspaceEditHistorySequenceRef.current;
      pendingWorkspaceHistoryClaimRef.current = true;
      const pendingClaim = workspaceEditQueueRef.current.then(async () => {
        if (action === "undo" && workspaceEditHistorySequenceRef.current > sequence) {
          await undoWorkspaceEdit();
        }
      }).finally(() => { pendingWorkspaceHistoryClaimRef.current = false; });
      workspaceEditQueueRef.current = pendingClaim.then(() => undefined, () => undefined);
      return true;
    }
    const state = workspaceEditHistory.state();
    if (state.busy) return false;
    if (action === "undo" ? !state.canUndo : !state.canRedo) return undefined;
    if (action === "undo") void undoWorkspaceEdit();
    else void redoWorkspaceEdit();
    return true;
  }, [redoWorkspaceEdit, undoWorkspaceEdit, workspaceEditHistory]);
  return {
    fileActionResourceOperationRef,
    workspaceEditHistory,
    setWorkspaceEditHistoryRevision,
    replayWorkspacePathSnapshotsRef,
    restoreEchoSuppressorRef,
    workspaceResourceOperationLockedRef,
    setWorkspaceResourceOperationLocked,
    replayWorkspaceRestoreRef,
    replayWorkspaceEncodingRef,
    workspaceEditHistorySequenceRef,
    pendingWorkspaceEditsRef,
    workspaceEditQueueRef,
    providerCommandSemanticGuardRef,
    providerCommandQueueRef,
    workspaceResourceOperationLocked,
    rearrangeRequestTokenRef,
    cleanupRequestTokenRef,
    workspaceEditHistoryState,
    requestWorkspaceUndoConfirmation,
    redoWorkspaceEdit,
    undoWorkspaceEdit,
    documentTransactionOwnerRef,
    claimWorkspaceHistory,
    workspaceUndoConfirmOpen,
    undoConfirmTriggerRef,
    closeWorkspaceUndoConfirmation,
    setWorkspaceUndoConfirmOpen,
  };
}
