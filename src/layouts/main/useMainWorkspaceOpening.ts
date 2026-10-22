import { useCallback, useEffect } from "react";
import { t as tr } from "../../lib/i18n";
import { type SessionConfig } from "../../lib/ipc";
import { effectiveFileType, openExternalUrl, sftpOpenPath, sftpStat } from "../../lib/sftp";
import type { RecentWorkspace } from "../../types";
import { createContinueConnectQueue, createOpenAfterJumpPassword, createOpenQueuedSession, createQueueVaultUnlock } from "./connectionQueue";
import { useMainLayoutState } from "./useMainLayoutState";
import { useMainSessionActions } from "./useMainSessionActions";
import { useSessionResume } from "./useSessionResume";
import { useShellSessionTabs } from "./useShellSessionTabs";
import { useWorkspaceTabs } from "./useWorkspaceTabs";


export interface UseMainWorkspaceOpeningContext {
  layout: ReturnType<typeof useMainLayoutState>;
  sessionActions: ReturnType<typeof useMainSessionActions>;
}

export function useMainWorkspaceOpening(context: UseMainWorkspaceOpeningContext) {
  const { layout, sessionActions } = context;

  // Open a local path or URL: http(s) URLs and files always go to the system handler;
  // folders open in an embedded Taomni tab when `embedFolder` is true, otherwise
  // they fall through to the OS file manager via sftpOpenPath.
  const handleOpenLocalPath = useCallback(async (
    target: string,
    opts: { embedFolder?: boolean; title?: string; sessionId?: string; } = {},
  ) => {
    const trimmed = target.trim();
    if (!trimmed) return;
    const isUrl = /^https?:\/\//i.test(trimmed);
    if (isUrl) {
      try {
        await openExternalUrl(trimmed);
      } catch (err) {
        layout.setStatusMessage(tr("status.openFailed", {
          error: err instanceof Error ? err.message : String(err),
        }));
      }
      return;
    }
    let isDir = false;
    try {
      const info = await sftpStat("", trimmed, "local");
      isDir = effectiveFileType(info) === "dir";
    } catch (err) {
      layout.setStatusMessage(tr("status.statFailed", {
        error: err instanceof Error ? err.message : String(err),
      }));
      return;
    }
    if (isDir && opts.embedFolder) {
      sessionActions.openFileBrowserTab(opts.title ?? trimmed, trimmed, opts.sessionId);
      return;
    }
    try {
      await sftpOpenPath(trimmed);
    } catch (err) {
      layout.setStatusMessage(tr("status.openFailed", {
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [sessionActions.openFileBrowserTab, layout.setStatusMessage]);

  const openFileSession = useCallback((session: SessionConfig) => {
    const target = session.host?.trim();
    if (!target) {
      layout.setStatusMessage(tr("status.fileSessionMissing"));
      return;
    }
    let embed = true;
    try {
      const opts = JSON.parse(session.options_json || "{}") as Record<string, unknown>;
      if (typeof opts.fileEmbedInTab === "boolean") embed = opts.fileEmbedInTab;
    } catch {
      /* defaults */
    }
    void handleOpenLocalPath(target, {
      embedFolder: embed,
      title: session.name || target,
      sessionId: session.id,
    });
    void layout.markConnected(session.id);
  }, [handleOpenLocalPath, layout.markConnected, layout.setStatusMessage]);

  const revealRecentCodeWorkspace = useCallback((workspace: RecentWorkspace) => {
    const target = workspace.roots[0]?.path ?? workspace.looseFiles[0]?.path;
    if (!target) return;
    void handleOpenLocalPath(target, { embedFolder: false });
  }, [handleOpenLocalPath]);
  const {
    openGitRepository,
    openEmptyCodeWorkspaceTab,
    openRecentCodeWorkspace,
    openNewCodeWorkspaceFromWelcome,
    openCodeWorkspaceTab,
    openWorkspaceGitManager,
    syncWorkspaceGitManager,
  } = useWorkspaceTabs({
    tabsRef: layout.tabsRef,
    setActiveTab: layout.setActiveTab,
    addTab: layout.addTab,
    updateGitTabInfo: layout.updateGitTabInfo,
    removeTab: layout.removeTab,
    tabs: layout.tabs,
    setStatusMessage: layout.setStatusMessage,
  });
  const { openSshTab, openBrowserSession, openCommandTerminalTab, openUnsupportedTab } = useShellSessionTabs({
    setStatusMessage: layout.setStatusMessage,
    markConnected: layout.markConnected,
    addTab: layout.addTab,
  });

  const queueVaultUnlock = useCallback(createQueueVaultUnlock({
    connectQueueRef: layout.connectQueueRef,
    awaitingVaultUnlockRef: layout.awaitingVaultUnlockRef,
    pendingVaultActionRef: layout.pendingVaultActionRef,
    continueConnectQueueRef: layout.continueConnectQueueRef,
    setVaultUnlockReason: layout.setVaultUnlockReason,
  }), []);

  const openAfterJumpPassword = useCallback(createOpenAfterJumpPassword({
    sessions: layout.sessions,
    awaitingManualAuthRef: layout.awaitingManualAuthRef,
    setPendingAuth: layout.setPendingAuth,
  }), [layout.sessions]);

  const openQueuedSession = useCallback(createOpenQueuedSession({
    queueVaultUnlock,
    openAfterJumpPassword,
    openSshTab,
    awaitingManualAuthRef: layout.awaitingManualAuthRef,
    setPendingAuth: layout.setPendingAuth,
    openSftpTab: sessionActions.openSftpTab,
    openLocalTab: sessionActions.openLocalTab,
    openVncTab: sessionActions.openVncTab,
    openRdpTab: sessionActions.openRdpTab,
    openFileSession,
    openBrowserSession,
    openCommandTerminalTab,
    openDbTab: sessionActions.openDbTab,
    openHBaseShellTab: sessionActions.openHBaseShellTab,
    openProxyTestTab: sessionActions.openProxyTestTab,
    openObjectStorageTab: sessionActions.openObjectStorageTab,
    tabsRef: layout.tabsRef,
    setActiveTab: layout.setActiveTab,
    openMailTab: sessionActions.openMailTab,
    openUnsupportedTab,
    markConnected: layout.markConnected,
  }), [
    layout.markConnected,
    openBrowserSession,
    openCommandTerminalTab,
    openFileSession,
    sessionActions.openLocalTab,
    sessionActions.openSftpTab,
    openSshTab,
    openUnsupportedTab,
    sessionActions.openVncTab,
    sessionActions.openRdpTab,
    sessionActions.openDbTab,
    sessionActions.openHBaseShellTab,
    sessionActions.openProxyTestTab,
    sessionActions.openObjectStorageTab,
    sessionActions.openMailTab,
    queueVaultUnlock,
    openAfterJumpPassword,
    layout.setActiveTab,
  ]);

  const continueConnectQueue = useCallback(createContinueConnectQueue({
    connectQueueRunningRef: layout.connectQueueRunningRef,
    awaitingManualAuthRef: layout.awaitingManualAuthRef,
    awaitingVaultUnlockRef: layout.awaitingVaultUnlockRef,
    connectQueueRef: layout.connectQueueRef,
    openQueuedSession,
  }), [openQueuedSession]);

  useEffect(() => {
    layout.continueConnectQueueRef.current = continueConnectQueue;
  }, [continueConnectQueue]);
  const { welcomeRestore, resolveResumeWaiterForTab, cancelResumeWaiter, cancelAllResumeWaiters } = useSessionResume({
    tabs: layout.tabs,
    removeTab: layout.removeTab,
    openQueuedSession,
    openLocalTab: sessionActions.openLocalTab,
    setPendingAuth: layout.setPendingAuth,
    awaitingManualAuthRef: layout.awaitingManualAuthRef,
    continueConnectQueueRef: layout.continueConnectQueueRef,
    setActiveTab: layout.setActiveTab,
    activeTab: layout.activeTab,
    terminalCwds: layout.terminalCwds,
    activeTabId: layout.activeTabId,
    setStatusMessage: layout.setStatusMessage,
  });
  return {
    continueConnectQueue,
    openAfterJumpPassword,
    openSshTab,
    openBrowserSession,
    openCommandTerminalTab,
    openUnsupportedTab,
    openQueuedSession,
    openGitRepository,
    openEmptyCodeWorkspaceTab,
    welcomeRestore,
    handleOpenLocalPath,
    openRecentCodeWorkspace,
    revealRecentCodeWorkspace,
    openNewCodeWorkspaceFromWelcome,
    resolveResumeWaiterForTab,
    openCodeWorkspaceTab,
    openWorkspaceGitManager,
    syncWorkspaceGitManager,
    cancelResumeWaiter,
    cancelAllResumeWaiters,
  };
}
