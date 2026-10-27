import { useCallback, useEffect, useRef } from "react";
import { useWelcomeSessionResume } from "../../hooks/useWelcomeSessionResume";
import { t as tr } from "../../lib/i18n";
import { getSession, type SessionConfig } from "../../lib/ipc";
import { type TerminalProfile } from "../../lib/terminalProfile";
import { primaryViewTypeForEntry } from "../../lib/welcomeSessionResume";
import { useAppStore } from "../../stores/appStore";
import type { LocalLaunchOutcome, LocalShellSelection, SnapshotEntry, Tab } from "../../types";
import {
  createBuildRunSnapshotEntries,
  createCancelAllResumeWaiters,
  createCancelPendingAuthForRestore,
  createCancelResumeWaiter,
  createCommitRunSnapshotNow,
  createOpenLocalTerminalForRestore,
  createOpenSavedSessionForRestore,
  createResolveResumeWaiter,
  createResolveResumeWaiterForTab,
} from "./restore";
import { type PendingAuth, type ResumeWaiter } from "./types";


export interface UseSessionResumeContext {
  tabs: Tab[];
  removeTab: (id: string) => void;
  openQueuedSession: (session: SessionConfig, localShellOverride?: LocalShellSelection, resume?: import("./types").ResumeQueueContext) => import("./types").ConnectQueueOutcome;
  openLocalTab: (title?: string, sessionId?: string, terminalProfile?: TerminalProfile, localShell?: LocalShellSelection, initialCwd?: string, chatTabId?: string) => Promise<LocalLaunchOutcome>;
  setPendingAuth: import("react").Dispatch<import("react").SetStateAction<PendingAuth | null>>;
  awaitingManualAuthRef: import("react").RefObject<boolean>;
  continueConnectQueueRef: import("react").RefObject<() => void>;
  setActiveTab: (id: string) => void;
  activeTab: Tab | undefined;
  terminalCwds: Record<string, string>;
  activeTabId: string | null;
  setStatusMessage: (message: string) => void;
}

export function useSessionResume(context: UseSessionResumeContext) {
  const {
    tabs,
    removeTab,
    openQueuedSession,
    openLocalTab,
    setPendingAuth,
    awaitingManualAuthRef,
    continueConnectQueueRef,
    setActiveTab,
    terminalCwds,
    activeTabId,
    setStatusMessage,
  } = context;
  const homeActive = useAppStore((state) => state.activeSideTab === "home");

  /// Welcome restore orchestration (design §4.2.3): per-entry waiters keyed by
  /// request id, plus tabId bindings and readiness timers.
  const resumeWaitersRef = useRef<Map<string, ResumeWaiter>>(new Map());
  const resumeWaiterBySessionRef = useRef<Map<string, string>>(new Map());
  const resumeWaiterByTabRef = useRef<Map<string, string>>(new Map());
  /// Non-terminal restored tabs: settle timer -> view-opened while alive.
  const resumeSettleTimersRef = useRef<Map<string, number>>(new Map());
  /// Failed tabs owned by a restore operation, keyed by entry identity;
  /// retry replaces them instead of stacking (design §4.2.5).
  const restoreFailedLocalTabsRef = useRef<Map<string, string>>(new Map());
  /// Run-snapshot collector state (design §4.2.1).
  const runBatchIdRef = useRef<string>(
    globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const snapshotFingerprintRef = useRef<string>("");
  const snapshotRevisionRef = useRef<number>(0);
  const snapshotCommitTimerRef = useRef<number | null>(null);


  // -------------------------------------------------------------------------
  // Welcome restore orchestration (design §4.2.3-4.2.5)
  // -------------------------------------------------------------------------

  const resolveResumeWaiter = useCallback(createResolveResumeWaiter({
    resumeWaitersRef,
    resumeWaiterByTabRef,
    resumeWaiterBySessionRef,
    resumeSettleTimersRef,
  }), []);

  const cancelResumeWaiter = useCallback(
    createCancelResumeWaiter({
      resolveResumeWaiter,
    }),
    [resolveResumeWaiter],
  );

  const cancelAllResumeWaiters = useCallback(
    createCancelAllResumeWaiters({
      resumeWaitersRef,
      cancelResumeWaiter,
    }),
    [cancelResumeWaiter],
  );

  /** Resolve the waiter bound to a restored tab by its readiness outcome. */
  const resolveResumeWaiterForTab = useCallback(
    createResolveResumeWaiterForTab({
      resumeWaiterByTabRef,
      resolveResumeWaiter,
      resumeWaitersRef,
      restoreFailedLocalTabsRef,
    }),
    [resolveResumeWaiter],
  );

  // Bind newly created tabs (sessionId match, tab absent at registration) to
  // their waiting restore entry, then start a settle fallback. A bound tab
  // that closes before readiness completes its entry as cancelled.
  useEffect(() => {
    const liveIds = new Set(tabs.map((tab) => tab.id));
    for (const [tabId, requestId] of Array.from(resumeWaiterByTabRef.current.entries())) {
      if (!liveIds.has(tabId)) {
        resumeWaiterByTabRef.current.delete(tabId);
        cancelResumeWaiter(requestId, "cancelled", "Restored tab was closed");
      }
    }
    if (resumeWaiterBySessionRef.current.size === 0) return;
    for (const tab of tabs) {
      if (!tab.sessionId) continue;
      const requestId = resumeWaiterBySessionRef.current.get(tab.sessionId);
      if (!requestId) continue;
      const waiter = resumeWaitersRef.current.get(requestId);
      if (!waiter || waiter.tabId || waiter.excludeTabIds.has(tab.id)) continue;
      waiter.tabId = tab.id;
      resumeWaiterBySessionRef.current.delete(waiter.sessionId);
      resumeWaiterByTabRef.current.set(tab.id, requestId);
      const isTerminalTab = tab.type === "terminal";
      const settleMs = isTerminalTab ? 15000 : 6000;
      const timer = window.setTimeout(() => {
        resumeSettleTimersRef.current.delete(requestId);
        const tabAlive = useAppStore
          .getState()
          .tabs.some((candidate) => candidate.id === waiter.tabId);
        if (tabAlive) {
          resolveResumeWaiter(requestId, {
            tabId: waiter.tabId,
            status: "ready",
            readiness: isTerminalTab ? "client-started" : "view-opened",
            issue: null,
          });
        } else {
          cancelResumeWaiter(requestId, "cancelled", "Restored tab closed before it became ready");
        }
      }, settleMs);
      resumeSettleTimersRef.current.set(requestId, timer);
    }
  }, [tabs, resolveResumeWaiter, cancelResumeWaiter]);

  const openSavedSessionForRestore = useCallback(
    createOpenSavedSessionForRestore({
      resumeWaitersRef,
      resumeWaiterBySessionRef,
      cancelResumeWaiter,
      restoreFailedLocalTabsRef,
      removeTab,
      openQueuedSession,
    }),
    [openQueuedSession, cancelResumeWaiter, removeTab],
  );

  const openLocalTerminalForRestore = useCallback(
    createOpenLocalTerminalForRestore({
      restoreFailedLocalTabsRef,
      removeTab,
      openLocalTab,
    }),
    [openLocalTab, removeTab],
  );

  const loadSessionConfigForRestore = useCallback(async (savedSessionId: string): Promise<SessionConfig> => {
    try {
      return await getSession(savedSessionId);
    } catch {
      throw Object.assign(
        new Error(`Saved session ${savedSessionId} no longer exists`),
        { code: "missing-session" },
      );
    }
  }, []);

  const findExistingTabForEntry = useCallback((entry: SnapshotEntry): string | null => {
    if (entry.kind !== "saved-session") return null;
    const expectedType = primaryViewTypeForEntry(entry);
    const runtimeByTab = useAppStore.getState().terminalRuntimeByTab;
    const match = useAppStore.getState().tabs.find(
      (tab) =>
        tab.sessionId === entry.savedSessionId &&
        tab.type === expectedType &&
        // A disconnected (failed) terminal is not a restorable target; retry
        // must rebuild it, not "locate" it (design §4.2.5).
        runtimeByTab[tab.id]?.state !== "disconnected",
    );
    return match?.id ?? null;
  }, []);

  const cancelPendingAuthForRestore = useCallback(
    createCancelPendingAuthForRestore({
      setPendingAuth,
      cancelResumeWaiter,
      awaitingManualAuthRef,
      continueConnectQueueRef,
      resumeWaitersRef,
    }),
    [cancelResumeWaiter],
  );

  const restoreCallbacksRef = useRef({
    loadSessionConfig: loadSessionConfigForRestore,
    findExistingTab: findExistingTabForEntry,
    activateTab: setActiveTab,
    openSavedSession: openSavedSessionForRestore,
    openLocalTerminal: openLocalTerminalForRestore,
    cancelPendingAuth: cancelPendingAuthForRestore,
  });
  restoreCallbacksRef.current = {
    loadSessionConfig: loadSessionConfigForRestore,
    findExistingTab: findExistingTabForEntry,
    activateTab: setActiveTab,
    openSavedSession: openSavedSessionForRestore,
    openLocalTerminal: openLocalTerminalForRestore,
    cancelPendingAuth: cancelPendingAuthForRestore,
  };

  const welcomeRestore = useWelcomeSessionResume(
    homeActive,
    restoreCallbacksRef.current,
  );
  const welcomeRestoreViewRef = useRef(welcomeRestore.view);
  welcomeRestoreViewRef.current = welcomeRestore.view;
  const welcomeRestoreInstanceRef = useRef(welcomeRestore);
  welcomeRestoreInstanceRef.current = welcomeRestore;

  // -------------------------------------------------------------------------
  // Run-snapshot collector (design §4.2.1): eligible tabs + active identity,
  // deep-compare, debounced commit. Empty snapshots are never written.
  // -------------------------------------------------------------------------

  const buildRunSnapshotEntries = useCallback(createBuildRunSnapshotEntries({
    tabs,
    terminalCwds,
    welcomeRestoreInstanceRef,
    activeTabId,
  }), [tabs, activeTabId, terminalCwds]);

  const commitRunSnapshotNow = useCallback(createCommitRunSnapshotNow({
    welcomeRestoreViewRef,
    buildRunSnapshotEntries,
    snapshotFingerprintRef,
    runBatchIdRef,
    snapshotRevisionRef,
    setStatusMessage,
  }), [buildRunSnapshotEntries, setStatusMessage, tr]);

  // Always execute the latest collector closure when the pending timer
  // fires, so a change committed during the debounce window is not lost.
  const commitRunSnapshotNowRef = useRef(commitRunSnapshotNow);
  commitRunSnapshotNowRef.current = commitRunSnapshotNow;
  const commitRunSnapshotSoon = useCallback(() => {
    if (snapshotCommitTimerRef.current != null) return;
    snapshotCommitTimerRef.current = window.setTimeout(() => {
      snapshotCommitTimerRef.current = null;
      void commitRunSnapshotNowRef.current();
    }, 400);
  }, []);

  useEffect(() => {
    commitRunSnapshotSoon();
  }, [tabs, activeTabId, terminalCwds, commitRunSnapshotSoon]);
  return { welcomeRestore, resolveResumeWaiterForTab, cancelResumeWaiter, cancelAllResumeWaiters, resumeWaitersRef, resumeWaiterBySessionRef, resumeWaiterByTabRef, resumeSettleTimersRef, restoreFailedLocalTabsRef, runBatchIdRef, snapshotFingerprintRef, snapshotRevisionRef, snapshotCommitTimerRef };
}
