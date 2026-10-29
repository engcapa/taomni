import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ResourceCleanupRecoveryView } from "../controller/model";
import { SaveTransactionRegistry } from "../saveCommit";
import { type SaveObservationRecord } from "../saveObservationContract";
import { listDiskEffectLedgerEntries, readWorkspaceRecoveryEntries, reconcileWorkspaceRecoveryEntries, writeWorkspaceRecoveryEntries, type WorkspaceRecoveryEntry } from "../workspaceRecovery";
import { WorkspaceResourceRecoveryCoordinator, type ResourceCleanupHandlers, type ResourceCleanupOutcome } from "../workspaceResourceRecoveryCoordinator";


export interface UseWorkspaceRecoveryStateContext {
  workspaceInstanceId: string;
  setTabPolicyReceipt: import("react").Dispatch<import("react").SetStateAction<import("../controller/model").TabPolicyLifecycleReceiptView | null>>;
  setStatusMessage: (message: string) => void;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  openFiles: Record<string, import("../editorGroupTypes").OpenFileViewModel>;
}

export function useWorkspaceRecoveryState(context: UseWorkspaceRecoveryStateContext) {
  const { workspaceInstanceId, setTabPolicyReceipt, setStatusMessage, openFilesRef, openFiles } = context;
  const [workspaceRecoveryEntries, setWorkspaceRecoveryEntries] = useState<WorkspaceRecoveryEntry[]>([]);
  const recoveryEntriesRef = useRef(workspaceRecoveryEntries);
  recoveryEntriesRef.current = workspaceRecoveryEntries;
  const [workspaceRecoveryOpen, setWorkspaceRecoveryOpen] = useState(false);
  /** §8.19.1 disk-effect ledger view state; bumped whenever rows are recorded/resolved. */
  const [diskEffectLedgerRevision, setDiskEffectLedgerRevision] = useState(0);
  const bumpDiskEffectLedger = useCallback(() => {
    setDiskEffectLedgerRevision((revision) => revision + 1);
  }, []);
  const diskEffectLedgerEntries = useMemo(
    () => listDiskEffectLedgerEntries(workspaceInstanceId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revision drives refresh; rows only change through recorded/resolved events or workspace switches
    [workspaceInstanceId, diskEffectLedgerRevision],
  );
  const [saveObservations, setSaveObservations] = useState<Record<string, SaveObservationRecord>>({});
  const pendingWorkspaceRecoveryKeysRef = useRef(new Set<string>());
  useEffect(() => {
    setSaveObservations({});
  }, [workspaceInstanceId]);
  const saveTransactionRegistryRef = useRef<SaveTransactionRegistry>(new SaveTransactionRegistry());
  const resourceRecoveryCoordinatorRef = useRef<WorkspaceResourceRecoveryCoordinator>(
    new WorkspaceResourceRecoveryCoordinator(workspaceInstanceId),
  );
  const resourceRecoveryHandlersRef = useRef(new Map<string, ResourceCleanupHandlers>());
  const [resourceCleanupRecoveries, setResourceCleanupRecoveries] = useState<readonly ResourceCleanupRecoveryView[]>([]);

  // Unmount drops every live transaction owner so in-flight writers discard
  // their writeback/watcher/LSP side effects instead of resurrecting state.
  useEffect(() => {
    resourceRecoveryCoordinatorRef.current = new WorkspaceResourceRecoveryCoordinator(workspaceInstanceId);
    resourceRecoveryHandlersRef.current.clear();
    setResourceCleanupRecoveries([]);
    setTabPolicyReceipt(null);
    const registry = saveTransactionRegistryRef.current;
    return () => {
      registry.discardWorkspace(workspaceInstanceId);
      resourceRecoveryCoordinatorRef.current.dispose();
    };
  }, [workspaceInstanceId]);

  const previousFilesRef = useRef(openFiles);
  useEffect(() => {
    const previous = previousFilesRef.current;
    previousFilesRef.current = openFiles;
    const entries = readWorkspaceRecoveryEntries(workspaceInstanceId);
    const remaining = entries.filter((entry) => {
      const file = openFiles[entry.key];
      if (!file || file.loading || file.error || file.dirty) return true;
      // A completed save supersedes the old draft immediately. Waiting for
      // the debounce could offer that already saved draft after a fast reload.
      const saved = previous[entry.key]?.dirty && file.text === file.savedText;
      if (!saved && file.savedText !== entry.text) return true;
      pendingWorkspaceRecoveryKeysRef.current.delete(entry.key);
      return false;
    });
    if (remaining.length === entries.length) return;
    writeWorkspaceRecoveryEntries(workspaceInstanceId, remaining);
    setWorkspaceRecoveryEntries(remaining);
    if (!remaining.length && !listDiskEffectLedgerEntries(workspaceInstanceId).length) {
      setWorkspaceRecoveryOpen(false);
    }
  }, [openFiles, workspaceInstanceId]);

  const observeResourceCleanupOutcome = useCallback((
    outcome: ResourceCleanupOutcome,
    handlers: ResourceCleanupHandlers,
  ) => {
    if (outcome.status === "retained") return;
    if (outcome.status === "committed") {
      if (outcome.recoveryId) {
        resourceRecoveryHandlersRef.current.delete(outcome.recoveryId);
        setResourceCleanupRecoveries((current) => current.filter(
          (recovery) => recovery.recoveryId !== outcome.recoveryId,
        ));
      }
      return;
    }

    resourceRecoveryHandlersRef.current.set(outcome.recoveryId, handlers);
    setResourceCleanupRecoveries((current) => {
      const previous = current.find((recovery) => recovery.recoveryId === outcome.recoveryId);
      const next: ResourceCleanupRecoveryView = {
        recoveryId: outcome.recoveryId,
        fileKey: outcome.fileKey,
        nextStage: outcome.nextStage,
        error: outcome.failedStages[0]?.error ?? outcome.message,
        completedStageCount: outcome.completedStages.length,
        attemptCount: (previous?.attemptCount ?? 0) + 1,
      };
      return [...current.filter((recovery) => recovery.recoveryId !== outcome.recoveryId), next];
    });
  }, []);

  const replayResourceCleanup = useCallback(async (recoveryId: string) => {
    const handlers = resourceRecoveryHandlersRef.current.get(recoveryId);
    if (!handlers) {
      setStatusMessage(`Cleanup recovery ${recoveryId} is no longer available`);
      return;
    }
    const outcome = await resourceRecoveryCoordinatorRef.current.replayRecoveryById(recoveryId, handlers);
    if (!outcome) {
      setStatusMessage(`Cleanup recovery ${recoveryId} was not found`);
      return;
    }
    observeResourceCleanupOutcome(outcome, handlers);
    setStatusMessage(outcome.status === "committed"
      ? `Completed resource cleanup recovery ${recoveryId}`
      : outcome.status === "committed-with-recovery"
        ? outcome.message
        : `Resource ${outcome.fileKey} is still retained by an editor view`);
  }, [observeResourceCleanupOutcome, setStatusMessage]);

  useEffect(() => {
    const entries = readWorkspaceRecoveryEntries(workspaceInstanceId);
    pendingWorkspaceRecoveryKeysRef.current = new Set(entries.map((entry) => entry.key));
    setWorkspaceRecoveryEntries(entries);
    // §8.19.1: unresolved disk-effect rows also open the recovery center so a
    // previous session's committed-discarded/unknown writes are surfaced.
    setWorkspaceRecoveryOpen(
      entries.length > 0 || listDiskEffectLedgerEntries(workspaceInstanceId).length > 0,
    );
  }, [workspaceInstanceId]);

  // Keep a bounded copy of unsaved buffers so a renderer/process crash can be
  // repaired on the next workspace open. Debouncing avoids a storage write for
  // every keystroke while retaining the latest edit within a short window.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const entries = reconcileWorkspaceRecoveryEntries(
        workspaceInstanceId,
        openFilesRef.current,
        pendingWorkspaceRecoveryKeysRef.current,
      );
      // Persistence reconciliation still runs. A clean document has no new
      // recovery UI to publish, so keep it out of the editor's paint path.
      if (!entries.length && !recoveryEntriesRef.current.length) return;
      setWorkspaceRecoveryEntries(entries);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [openFiles, workspaceInstanceId]);
  return {
    pendingWorkspaceRecoveryKeysRef,
    setWorkspaceRecoveryEntries,
    setWorkspaceRecoveryOpen,
    bumpDiskEffectLedger,
    saveTransactionRegistryRef,
    setSaveObservations,
    resourceRecoveryCoordinatorRef,
    observeResourceCleanupOutcome,
    saveObservations,
    resourceCleanupRecoveries,
    replayResourceCleanup,
    workspaceRecoveryOpen,
    workspaceRecoveryEntries,
    diskEffectLedgerEntries,
  };
}
