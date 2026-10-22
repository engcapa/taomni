import { getAppPlatform } from "../../lib/runtime";
import type { Tab } from "../../types";
import { useAppStore } from "../../stores/appStore";
import { normalizeLocalStartCwd } from "../../lib/terminalCwd";
import { useSessionStore } from "../../stores/sessionStore";
import { type SessionConfig } from "../../lib/ipc";
import { type TerminalProfile } from "../../lib/terminalProfile";
import type { LocalLaunchOutcome, LocalShellSelection, ResumeIssue, SnapshotEntry } from "../../types";
import { isResumeEligibleSavedSession, localTerminalEntry, savedSessionEntry, snapshotEntriesFingerprint, commitWelcomeRunSnapshot } from "../../lib/welcomeSessionResume";
import { type OpenEntryResult } from "../../hooks/useWelcomeSessionResume";
import { t as tr } from "../../lib/i18n";
import { type PendingAuth, type ResumeWaiter, type ResumeQueueContext, type ConnectQueueOutcome } from "./types";



export interface ResolveResumeWaiterContext {
  resumeWaitersRef: import("react").RefObject<Map<string, ResumeWaiter>>;
  resumeWaiterByTabRef: import("react").RefObject<Map<string, string>>;
  resumeWaiterBySessionRef: import("react").RefObject<Map<string, string>>;
  resumeSettleTimersRef: import("react").RefObject<Map<string, number>>;
}


export function createResolveResumeWaiter(controllerContext: ResolveResumeWaiterContext): (requestId: string, result: OpenEntryResult) => void {
  return (requestId: string, result: OpenEntryResult) => {
    const waiter = controllerContext.resumeWaitersRef.current.get(requestId);
    if (!waiter || waiter.settled) return;
    waiter.settled = true;
    controllerContext.resumeWaitersRef.current.delete(requestId);
    if (waiter.guardTimer != null) {
      window.clearTimeout(waiter.guardTimer);
      waiter.guardTimer = null;
    }
    if (waiter.tabId) controllerContext.resumeWaiterByTabRef.current.delete(waiter.tabId);
    if (controllerContext.resumeWaiterBySessionRef.current.get(waiter.sessionId) === requestId) {
      controllerContext.resumeWaiterBySessionRef.current.delete(waiter.sessionId);
    }
    const settleTimer = controllerContext.resumeSettleTimersRef.current.get(requestId);
    if (settleTimer != null) {
      window.clearTimeout(settleTimer);
      controllerContext.resumeSettleTimersRef.current.delete(requestId);
    }
    waiter.resolve(result);
  };
}



export interface CancelResumeWaiterContext {
  resolveResumeWaiter: (requestId: string, result: OpenEntryResult) => void;
}


export function createCancelResumeWaiter(controllerContext: CancelResumeWaiterContext): (requestId: string, code: ResumeIssue["code"], message: string) => void {
  return (requestId: string, code: ResumeIssue["code"], message: string) => {
      controllerContext.resolveResumeWaiter(requestId, {
        tabId: null,
        status: "cancelled",
        readiness: null,
        issue: { code, message },
      });
    };
}



export interface CancelAllResumeWaitersContext {
  resumeWaitersRef: import("react").RefObject<Map<string, ResumeWaiter>>;
  cancelResumeWaiter: (requestId: string, code: ResumeIssue["code"], message: string) => void;
}


export function createCancelAllResumeWaiters(controllerContext: CancelAllResumeWaitersContext): (code: ResumeIssue["code"], message: string) => void {
  return (code: ResumeIssue["code"], message: string) => {
      for (const requestId of Array.from(controllerContext.resumeWaitersRef.current.keys())) {
        controllerContext.cancelResumeWaiter(requestId, code, message);
      }
    };
}



export interface ResolveResumeWaiterForTabContext {
  resumeWaiterByTabRef: import("react").RefObject<Map<string, string>>;
  resolveResumeWaiter: (requestId: string, result: OpenEntryResult) => void;
  resumeWaitersRef: import("react").RefObject<Map<string, ResumeWaiter>>;
  restoreFailedLocalTabsRef: import("react").RefObject<Map<string, string>>;
}


export function createResolveResumeWaiterForTab(controllerContext: ResolveResumeWaiterForTabContext): (tabId: string, status: "connected" | "failed", error?: unknown) => void {
  return (tabId: string, status: "connected" | "failed", error?: unknown) => {
      const requestId = controllerContext.resumeWaiterByTabRef.current.get(tabId);
      if (!requestId) return;
      if (status === "connected") {
        controllerContext.resolveResumeWaiter(requestId, {
          tabId,
          status: "ready",
          readiness: "connected",
          issue: null,
        });
      } else {
        const waiter = controllerContext.resumeWaitersRef.current.get(requestId);
        if (waiter) {
          controllerContext.restoreFailedLocalTabsRef.current.set(waiter.entryIdentity, tabId);
        }
        controllerContext.resolveResumeWaiter(requestId, {
          tabId,
          status: "failed",
          readiness: null,
          issue: { code: "connect", message: String(error ?? "Connection failed") },
        });
      }
    };
}



export interface OpenSavedSessionForRestoreContext {
  resumeWaitersRef: import("react").RefObject<Map<string, ResumeWaiter>>;
  resumeWaiterBySessionRef: import("react").RefObject<Map<string, string>>;
  cancelResumeWaiter: (requestId: string, code: ResumeIssue["code"], message: string) => void;
  restoreFailedLocalTabsRef: import("react").RefObject<Map<string, string>>;
  removeTab: (id: string) => void;
  openQueuedSession: (session: SessionConfig, localShellOverride?: LocalShellSelection, resume?: ResumeQueueContext) => ConnectQueueOutcome;
}


export function createOpenSavedSessionForRestore(controllerContext: OpenSavedSessionForRestoreContext): (session: SessionConfig, context: { operationId: string; entryIdentity: string; }) => Promise<OpenEntryResult> {
  return (
      session: SessionConfig,
      context: { operationId: string; entryIdentity: string },
    ): Promise<OpenEntryResult> => {
      return new Promise<OpenEntryResult>((resolve) => {
        const requestId = `resume-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
        const excludeTabIds = new Set(
          useAppStore
            .getState()
            .tabs.filter((tab) => tab.sessionId === session.id)
            .map((tab) => tab.id),
        );
        const waiter: ResumeWaiter = {
          requestId,
          operationId: context.operationId,
          entryIdentity: context.entryIdentity,
          sessionId: session.id,
          tabId: null,
          resolve,
          settled: false,
          excludeTabIds,
          guardTimer: null,
        };
        controllerContext.resumeWaitersRef.current.set(requestId, waiter);
        controllerContext.resumeWaiterBySessionRef.current.set(session.id, requestId);
        waiter.guardTimer = window.setTimeout(() => {
          controllerContext.cancelResumeWaiter(requestId, "connect", "Restore entry timed out waiting for dispatch");
        }, 60000);
        // A retry replaces the operation-owned failed tab (design §4.2.5).
        const previousFailed = controllerContext.restoreFailedLocalTabsRef.current.get(context.entryIdentity);
        if (previousFailed) {
          controllerContext.restoreFailedLocalTabsRef.current.delete(context.entryIdentity);
          if (useAppStore.getState().tabs.some((tab) => tab.id === previousFailed)) {
            controllerContext.removeTab(previousFailed);
          }
        }
        controllerContext.openQueuedSession(session, undefined, {
          requestId,
          operationId: context.operationId,
          entryIdentity: context.entryIdentity,
        });
      });
    };
}



export interface OpenLocalTerminalForRestoreContext {
  restoreFailedLocalTabsRef: import("react").RefObject<Map<string, string>>;
  removeTab: (id: string) => void;
  openLocalTab: (title?: string, sessionId?: string, terminalProfile?: TerminalProfile, localShell?: LocalShellSelection, initialCwd?: string, chatTabId?: string) => Promise<LocalLaunchOutcome>;
}


export function createOpenLocalTerminalForRestore(controllerContext: OpenLocalTerminalForRestoreContext): (entry: Extract<SnapshotEntry, { kind: "local-terminal"; }>, _context: { operationId: string; }) => Promise<OpenEntryResult> {
  return async (
      entry: Extract<SnapshotEntry, { kind: "local-terminal" }>,
      _context: { operationId: string },
    ): Promise<OpenEntryResult> => {
      // Retry of an operation-owned failed tab replaces it (never stacks).
      const previousFailed = controllerContext.restoreFailedLocalTabsRef.current.get(entry.identity);
      if (previousFailed) {
        controllerContext.restoreFailedLocalTabsRef.current.delete(entry.identity);
        if (useAppStore.getState().tabs.some((tab) => tab.id === previousFailed)) {
          controllerContext.removeTab(previousFailed);
        }
      }
      const shellSelection: LocalShellSelection = {
        id: entry.shellId,
        name: entry.displayName,
        ...(entry.shellArgs.length > 0 ? { args: [...entry.shellArgs] } : {}),
      };
      const outcome = await controllerContext.openLocalTab(
        entry.displayName,
        undefined,
        undefined,
        shellSelection,
        entry.confirmedCwd,
        entry.identity.startsWith("local:") ? entry.identity.slice("local:".length) : undefined,
      );
      switch (outcome.status) {
        case "started":
          return { tabId: outcome.tabId, status: "ready", readiness: "connected", issue: null };
        case "failed":
          if (outcome.tabId) {
            controllerContext.restoreFailedLocalTabsRef.current.set(entry.identity, outcome.tabId);
          }
          return {
            tabId: outcome.tabId,
            status: "failed",
            readiness: null,
            issue: { code: "connect", message: outcome.error ?? "Local terminal failed to start" },
          };
        default:
          return {
            tabId: outcome.tabId,
            status: "cancelled",
            readiness: null,
            issue: { code: "cancelled", message: "Local terminal launch cancelled" },
          };
      }
    };
}



export interface CancelPendingAuthForRestoreContext {
  setPendingAuth: import("react").Dispatch<import("react").SetStateAction<PendingAuth | null>>;
  cancelResumeWaiter: (requestId: string, code: ResumeIssue["code"], message: string) => void;
  awaitingManualAuthRef: import("react").RefObject<boolean>;
  continueConnectQueueRef: import("react").RefObject<() => void>;
  resumeWaitersRef: import("react").RefObject<Map<string, ResumeWaiter>>;
}


export function createCancelPendingAuthForRestore(controllerContext: CancelPendingAuthForRestoreContext): (operationId: string) => void {
  return (operationId: string) => {
      controllerContext.setPendingAuth((current) => {
        if (current && current.kind === "session" && current.restoreOperationId === operationId) {
          if (current.resumeRequestId) {
            controllerContext.cancelResumeWaiter(current.resumeRequestId, "cancelled", "Restore cancelled");
          }
          controllerContext.awaitingManualAuthRef.current = false;
          controllerContext.continueConnectQueueRef.current();
          return null;
        }
        return current;
      });
      for (const [requestId, waiter] of Array.from(controllerContext.resumeWaitersRef.current.entries())) {
        if (waiter.operationId === operationId) {
          controllerContext.cancelResumeWaiter(requestId, "cancelled", "Restore cancelled");
        }
      }
    };
}



export interface BuildRunSnapshotEntriesContext {
  tabs: Tab[];
  terminalCwds: Record<string, string>;
  welcomeRestoreInstanceRef: import("react").RefObject<import("../../hooks/useWelcomeSessionResume").UseWelcomeSessionResumeResult>;
  activeTabId: string | null;
}


export function createBuildRunSnapshotEntries(controllerContext: BuildRunSnapshotEntriesContext): () => { entries: SnapshotEntry[]; activeIdentity: string | null; } {
  return () => {
    const sessionsById = new Map(
      useSessionStore.getState().sessions.map((session) => [session.id, session]),
    );
    const entries: SnapshotEntry[] = [];
    const identityByTab = new Map<string, string>();
    for (const tab of controllerContext.tabs) {
      let entry: SnapshotEntry | null = null;
      if (tab.type === "terminal") {
        if (tab.sessionId) {
          const session = sessionsById.get(tab.sessionId);
          if (session && isResumeEligibleSavedSession(session)) {
            entry = savedSessionEntry(session);
          }
        } else if (
          tab.localShell &&
          tab.localShell.id !== "wsl.exe" &&
          !tab.localShell.id.startsWith("wsl:")
        ) {
          const rawCwd = controllerContext.terminalCwds[tab.id] ?? null;
          const confirmedCwd = rawCwd ? normalizeLocalStartCwd(rawCwd, getAppPlatform()) : null;
          if (confirmedCwd) {
            entry = localTerminalEntry({
              tabId: tab.chatTabId ?? tab.id,
              displayName: tab.localShell.name,
              shellId: tab.localShell.id,
              shellArgs: tab.localShell.args,
              confirmedCwd,
            });
          }
        }
      } else if (
        tab.sessionId &&
        ["sftp", "vnc", "rdp", "database", "redis", "hbase-shell", "proxy-test", "object-storage", "mail", "file-browser"].includes(tab.type)
      ) {
        const session = sessionsById.get(tab.sessionId);
        if (session && isResumeEligibleSavedSession(session)) {
          entry = savedSessionEntry(session);
        }
      }
      if (entry && !controllerContext.welcomeRestoreInstanceRef.current.isIdentitySuppressed(entry.identity)) {
        entries.push(entry);
        identityByTab.set(tab.id, entry.identity);
      }
    }
    const activeIdentity = identityByTab.get(controllerContext.activeTabId ?? "") ?? null;
    return { entries, activeIdentity };
  };
}



export interface CommitRunSnapshotNowContext {
  welcomeRestoreViewRef: import("react").RefObject<import("../../hooks/useWelcomeSessionResume").RestoreViewState>;
  buildRunSnapshotEntries: () => { entries: SnapshotEntry[]; activeIdentity: string | null; };
  snapshotFingerprintRef: import("react").RefObject<string>;
  runBatchIdRef: import("react").RefObject<string>;
  snapshotRevisionRef: import("react").RefObject<number>;
  setStatusMessage: (message: string) => void;
}


export function createCommitRunSnapshotNow(controllerContext: CommitRunSnapshotNowContext): () => Promise<void> {
  return async () => {
    const state = controllerContext.welcomeRestoreViewRef.current.state;
    if (state === "restoring" || state === "awaiting-auth") return; // suppression
    const { entries, activeIdentity } = controllerContext.buildRunSnapshotEntries();
    if (entries.length === 0) return; // never write empty snapshots
    const fingerprint = snapshotEntriesFingerprint(entries, activeIdentity);
    if (fingerprint === controllerContext.snapshotFingerprintRef.current) return;
    try {
      const response = await commitWelcomeRunSnapshot({
        batchId: controllerContext.runBatchIdRef.current,
        entries,
        activeIdentity,
        expectedRevision: controllerContext.snapshotRevisionRef.current || undefined,
        restored: false,
      });
      if (response.record) controllerContext.snapshotRevisionRef.current = response.record.revision;
      if (response.applied) controllerContext.snapshotFingerprintRef.current = fingerprint;
    } catch (error) {
      controllerContext.setStatusMessage(tr("welcome.snapshotSaveFailed", { error: String(error) }));
    }
  };
}
