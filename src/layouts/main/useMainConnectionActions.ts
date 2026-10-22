import { useCallback } from "react";
import { t as tr } from "../../lib/i18n";
import { type SessionConfig } from "../../lib/ipc";
import { createHandleQuickConnect } from "./commandActions";
import { createHandleAuthSubmit } from "./connectionQueue";
import { useMainLayoutState } from "./useMainLayoutState";
import { useMainSessionActions } from "./useMainSessionActions";
import { useMainWorkspaceOpening } from "./useMainWorkspaceOpening";


export interface UseMainConnectionActionsContext {
  layout: ReturnType<typeof useMainLayoutState>;
  workspaceOpening: ReturnType<typeof useMainWorkspaceOpening>;
  sessionActions: ReturnType<typeof useMainSessionActions>;
}

export function useMainConnectionActions(context: UseMainConnectionActionsContext) {
  const { layout, workspaceOpening, sessionActions } = context;

  const handleConnectSession = useCallback((session: SessionConfig) => {
    layout.connectQueueRef.current.push({ session });
    workspaceOpening.continueConnectQueue();
  }, [workspaceOpening.continueConnectQueue]);

  const handleConnectSessions = useCallback((targets: SessionConfig[]) => {
    const seen = new Set<string>();
    const unique = targets.filter((session) => {
      if (seen.has(session.id)) return false;
      seen.add(session.id);
      return true;
    });
    if (unique.length === 0) return;
    layout.connectQueueRef.current.push(...unique.map((session) => ({ session })));
    workspaceOpening.continueConnectQueue();
  }, [workspaceOpening.continueConnectQueue]);

  const handleRevealRecentSession = useCallback((session: SessionConfig) => {
    layout.setActiveSideTab("sessions");
    layout.setSidebarCollapsed(false);
    layout.setSelectedSession(session.id);
    layout.setSearchQuery("");
    layout.setStatusMessage(tr("status.revealedSession", { name: session.name || session.host || session.session_type }));
  }, [layout.setActiveSideTab, layout.setSearchQuery, layout.setSelectedSession, layout.setSidebarCollapsed, layout.setStatusMessage, tr]);

  const handleAuthSubmit = useCallback(createHandleAuthSubmit({
    pendingAuth: layout.pendingAuth,
    updateSession: layout.updateSession,
    setPendingAuth: layout.setPendingAuth,
    awaitingManualAuthRef: layout.awaitingManualAuthRef,
    continueConnectQueueRef: layout.continueConnectQueueRef,
    openAfterJumpPassword: workspaceOpening.openAfterJumpPassword,
    openSftpTab: sessionActions.openSftpTab,
    openVncTab: sessionActions.openVncTab,
    openRdpTab: sessionActions.openRdpTab,
    openSshTab: workspaceOpening.openSshTab,
  }), [layout.pendingAuth, workspaceOpening.openAfterJumpPassword, sessionActions.openSftpTab, workspaceOpening.openSshTab, sessionActions.openVncTab, sessionActions.openRdpTab, layout.updateSession]);

  const handleQuickConnect = useCallback(createHandleQuickConnect({
    openLocalTab: sessionActions.openLocalTab,
    openBrowserSession: workspaceOpening.openBrowserSession,
    openMailTab: sessionActions.openMailTab,
    openCommandTerminalTab: workspaceOpening.openCommandTerminalTab,
    openVncTab: sessionActions.openVncTab,
    awaitingManualAuthRef: layout.awaitingManualAuthRef,
    setPendingAuth: layout.setPendingAuth,
    openSftpTab: sessionActions.openSftpTab,
    openRdpTab: sessionActions.openRdpTab,
    openSshTab: workspaceOpening.openSshTab,
    openUnsupportedTab: workspaceOpening.openUnsupportedTab,
    setStatusMessage: layout.setStatusMessage,
  }), [workspaceOpening.openBrowserSession, workspaceOpening.openCommandTerminalTab, sessionActions.openLocalTab, sessionActions.openMailTab, sessionActions.openRdpTab, sessionActions.openSftpTab, workspaceOpening.openSshTab, sessionActions.openVncTab, workspaceOpening.openUnsupportedTab, layout.setStatusMessage]);
  return {
    handleQuickConnect,
    handleConnectSession,
    handleConnectSessions,
    handleRevealRecentSession,
    handleAuthSubmit,
  };
}
