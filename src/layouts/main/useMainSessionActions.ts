import { useCallback, useEffect } from "react";
import { t as tr } from "../../lib/i18n";
import { type SessionConfig } from "../../lib/ipc";
import { terminalCwdTitlePrefix } from "../../lib/terminalCwd";
import { loadTerminalDefaultProfile, type TerminalProfile } from "../../lib/terminalProfile";
import { computeNewTerminalTitle, useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import type { LocalLaunchOutcome, LocalShellSelection } from "../../types";
import { useApplicationExit } from "./useApplicationExit";
import { useMainLayoutState } from "./useMainLayoutState";
import { useProtocolTabs } from "./useProtocolTabs";


export interface UseMainSessionActionsContext {
  layout: ReturnType<typeof useMainLayoutState>;
}

export function useMainSessionActions(context: UseMainSessionActionsContext) {
  const { layout } = context;
  const { requestAppExit } = useApplicationExit({
    tabsRef: layout.tabsRef,
    confirmAppExit: layout.confirmAppExit,
    exitRequestInFlightRef: layout.exitRequestInFlightRef,
  });

  const handleNewSession = useCallback((groupPath: string | null = null) => {
    layout.setEditingSession(undefined);
    layout.setNewSessionGroupPath(groupPath);
    layout.setNewSessionInitialProto(undefined);
    layout.setShowSessionEditor(true);
  }, []);

  const handleNewSftpSession = useCallback(() => {
    layout.setEditingSession(undefined);
    layout.setNewSessionGroupPath(null);
    layout.setNewSessionInitialProto("SFTP");
    layout.setShowSessionEditor(true);
  }, []);

  const openLocalTab = useCallback((
    title?: string,
    sessionId?: string,
    terminalProfile?: TerminalProfile,
    localShell?: LocalShellSelection,
    initialCwd?: string,
    chatTabId?: string,
  ): Promise<LocalLaunchOutcome> => {
    // UUID-based tab id: callers of the structured launch outcome correlate
    // by tab id, so same-millisecond ids must never collide.
    const id = `local-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
    const resolvedTerminalProfile = terminalProfile ?? loadTerminalDefaultProfile();
    const initialTitlePrefix = initialCwd ? terminalCwdTitlePrefix(initialCwd) : null;
    const requestedTitle = initialTitlePrefix || title || tr("tabs.localTerminal");
    const resolvedTitle = computeNewTerminalTitle(
      requestedTitle,
      useAppStore.getState().tabs
        .filter((tab) => tab.type === "terminal")
        .map((tab) => tab.title),
    );
    layout.addTab({
      id,
      ...(chatTabId?.trim() ? { chatTabId: chatTabId.trim() } : {}),
      type: "terminal",
      title: resolvedTitle,
      sessionId,
      localShell,
      terminalProfile: resolvedTerminalProfile,
      terminalInitialCwd: initialCwd,
      terminalTitleMode: initialTitlePrefix ? "auto" : "pending-auto",
      terminalTitleOperation: "new",
      closable: true,
    });
    if (sessionId) void layout.markConnected(sessionId);
    // Structured launch outcome (design §4.1.5): resolved by the terminal's
    // onSessionReady / onSessionLaunchFailed callbacks, or cancelled when the
    // pending tab closes before either fires.
    return new Promise<LocalLaunchOutcome>((resolve) => {
      layout.pendingLocalLaunchesRef.current.set(id, resolve);
    });
  }, [layout.addTab, layout.markConnected]);

  /** Resolve the structured local-launch request for `tabId` if still pending. */
  const completeLocalLaunch = useCallback((tabId: string, outcome: LocalLaunchOutcome) => {
    const resolve = layout.pendingLocalLaunchesRef.current.get(tabId);
    if (resolve) {
      layout.pendingLocalLaunchesRef.current.delete(tabId);
      resolve(outcome);
    }
  }, []);

  // Close-before-ready: a pending launch whose tab disappears completes as
  // cancelled so Welcome's per-directory pending state never leaks.
  useEffect(() => {
    if (layout.pendingLocalLaunchesRef.current.size === 0) return;
    const liveIds = new Set(layout.tabs.map((tab) => tab.id));
    for (const [tabId, resolve] of Array.from(layout.pendingLocalLaunchesRef.current.entries())) {
      if (!liveIds.has(tabId)) {
        layout.pendingLocalLaunchesRef.current.delete(tabId);
        resolve({ tabId, status: "cancelled" });
      }
    }
  }, [layout.tabs]);

  const handleEditSession = useCallback((session: SessionConfig) => {
    layout.setEditingSession(session);
    layout.setNewSessionGroupPath(null);
    layout.setShowSessionEditor(true);
  }, []);

  const handleEditSessionById = useCallback((sessionId: string) => {
    const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId);
    if (session) handleEditSession(session);
  }, [handleEditSession]);
  const {
    openFileBrowserTab,
    openSftpTab,
    openVncTab,
    openRdpTab,
    openDbTab,
    openHBaseShellTab,
    openProxyTestTab,
    openObjectStorageTab,
    openMailTab,
    persistVncProperties,
    rememberVncCredentials,
  } = useProtocolTabs({
    addTab: layout.addTab,
    markConnected: layout.markConnected,
    updateSession: layout.updateSession,
    setStatusMessage: layout.setStatusMessage,
    tabsRef: layout.tabsRef,
    setActiveTab: layout.setActiveTab,
  });
  return {
    openFileBrowserTab,
    openSftpTab,
    openLocalTab,
    openVncTab,
    openRdpTab,
    openDbTab,
    openHBaseShellTab,
    openProxyTestTab,
    openObjectStorageTab,
    openMailTab,
    handleNewSession,
    handleNewSftpSession,
    requestAppExit,
    handleEditSession,
    completeLocalLaunch,
    persistVncProperties,
    rememberVncCredentials,
    handleEditSessionById,
  };
}
