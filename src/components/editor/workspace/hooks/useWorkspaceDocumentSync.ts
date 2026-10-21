import { useCallback } from "react";
import { type LspFileState, type OpenFileState, isLspFeatureReady, shouldLiveSyncLsp } from "../codeWorkspaceModel";
import { LSP_CHANGE_SYNC_DELAY_MS, LSP_FEATURE_SYNC_WAIT_MS } from "../controller/model";


export interface UseWorkspaceDocumentSyncContext {
  liveLspSyncTimersRef: import("react").RefObject<Record<string, number>>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  isLspDocumentSynced: (key: string, text: string) => boolean;
  syncLspDocument: (file: OpenFileState, mode: "open" | "change") => Promise<void>;
  waitForLspDocumentSyncQueue: (key: string) => Promise<void>;
  semanticIndex: import("../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
}

export function useWorkspaceDocumentSync(context: UseWorkspaceDocumentSyncContext) {
  const { liveLspSyncTimersRef, openFilesRef, lspFilesRef, isLspDocumentSynced, syncLspDocument, waitForLspDocumentSyncQueue, semanticIndex } = context;

  const scheduleLiveLspSync = useCallback((key: string) => {
    const existing = liveLspSyncTimersRef.current[key];
    if (existing) window.clearTimeout(existing);
    const latestNow = openFilesRef.current[key];
    // Typing only drives didChange for an *already active* session. Missing
    // LSP / failed jdtls never schedules idle open probes from keystrokes.
    if (!latestNow || !shouldLiveSyncLsp(latestNow.languagePath, lspFilesRef.current[key])) {
      return;
    }
    liveLspSyncTimersRef.current[key] = window.setTimeout(() => {
      delete liveLspSyncTimersRef.current[key];
      const latest = openFilesRef.current[key];
      if (!latest || latest.loading) return;
      const lspState = lspFilesRef.current[key];
      if (!shouldLiveSyncLsp(latest.languagePath, lspState)) return;
      if (lspState?.status?.active && isLspDocumentSynced(key, latest.text)) return;
      // Active → change; still-opening → open (coalesced as pending change once active).
      const mode: "open" | "change" = lspState?.status?.active ? "change" : "open";
      void syncLspDocument(latest, mode);
    }, LSP_CHANGE_SYNC_DELAY_MS);
  }, [isLspDocumentSynced, syncLspDocument]);

  const cancelLiveLspSync = useCallback((key: string) => {
    const existing = liveLspSyncTimersRef.current[key];
    if (!existing) return;
    window.clearTimeout(existing);
    delete liveLspSyncTimersRef.current[key];
  }, []);

  /**
   * Bring the language server up to the live editor buffer before a latency-
   * sensitive feature (completion / signature). Bypasses the typing debounce
   * and waits for the in-flight sync queue to drain for this file.
   */
  const ensureLspDocumentSynced = useCallback(async (
    fileKey: string,
    requireSynchronized = false,
  ): Promise<OpenFileState | null> => {
    cancelLiveLspSync(fileKey);
    const kick = () => {
      const latest = openFilesRef.current[fileKey];
      if (!latest || latest.loading) return null;
      const state = lspFilesRef.current[fileKey];
      // Features require an active session; do not open-from-completion on plain text.
      if (!isLspFeatureReady(state)) return null;
      if (isLspDocumentSynced(fileKey, latest.text)) return latest;
      void syncLspDocument(latest, "change");
      return null;
    };
    const ready = kick();
    if (ready) return ready;
    // No active server: do not wait on every completion keystroke.
    if (!isLspFeatureReady(lspFilesRef.current[fileKey])) return null;
    if (requireSynchronized) {
      // A completion for the final trigger character has no later keystroke
      // to retry it. Keep it pending until didChange settles instead of
      // dropping it when the best-effort feature wait expires. Callers still
      // reject changed document/session identities before delivering results.
      await waitForLspDocumentSyncQueue(fileKey);
    } else {
      await Promise.race([
        waitForLspDocumentSyncQueue(fileKey),
        new Promise<void>((resolve) => {
          window.setTimeout(resolve, LSP_FEATURE_SYNC_WAIT_MS);
        }),
      ]);
    }
    const finalReady = kick();
    if (finalReady) return finalReady;
    // Best effort: if the server is active but still catching up, still return
    // the live buffer so the feature request can race (CM will re-query on the
    // next keystroke via isIncomplete / abort-on-doc-change).
    const latest = openFilesRef.current[fileKey];
    if (
      latest
      && isLspFeatureReady(lspFilesRef.current[fileKey])
      && (!requireSynchronized || isLspDocumentSynced(fileKey, latest.text))
    ) return latest;
    return null;
  }, [cancelLiveLspSync, isLspDocumentSynced, syncLspDocument, waitForLspDocumentSyncQueue]);

  /**
   * Semantic mutations are stricter than completion/signature help: every
   * active provider buffer must be acknowledged before the query is sent.
   * If the user edits during the barrier, the original action is abandoned.
   */
  const ensureWorkspaceSemanticDocumentsSynced = useCallback(async (
    requiredFileKey: string,
    expectedRevision: number,
  ): Promise<OpenFileState | null> => {
    const candidates = Object.values(openFilesRef.current).filter((candidate) => (
      !candidate.library
      && shouldLiveSyncLsp(candidate.languagePath, lspFilesRef.current[candidate.key])
    ));
    if (!candidates.some((candidate) => candidate.key === requiredFileKey)) return null;
    const synchronized = await Promise.all(candidates.map(async (candidate) => {
      const latest = await ensureLspDocumentSynced(candidate.key, true);
      const current = openFilesRef.current[candidate.key];
      return !!latest
        && !!current
        && latest.text === current.text
        && isLspDocumentSynced(candidate.key, current.text);
    }));
    if (!synchronized.every(Boolean)) return null;
    if (semanticIndex.current().revision !== expectedRevision) return null;
    const required = openFilesRef.current[requiredFileKey];
    return required && isLspDocumentSynced(requiredFileKey, required.text) ? required : null;
  }, [ensureLspDocumentSynced, isLspDocumentSynced, semanticIndex.current]);
  return { scheduleLiveLspSync, ensureWorkspaceSemanticDocumentsSynced, ensureLspDocumentSynced };
}
