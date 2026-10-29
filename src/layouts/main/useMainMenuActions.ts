import { useCallback } from "react";
import type { AppCommand } from "../../components/menubar/commands";
import { t as tr } from "../../lib/i18n";
import { type MenuActionId } from "../../lib/nativeAppMenu";
import { createHandleCommand } from "./commandActions";
import { writeQuickConnectVisible } from "./sessionPolicy";
import { useMainLayoutState } from "./useMainLayoutState";
import { useMainMenuBridge } from "./useMainMenuBridge";
import { useMainSessionActions } from "./useMainSessionActions";
import { useMainUtilityTabs } from "./useMainUtilityTabs";
import { useMainWorkspaceOpening } from "./useMainWorkspaceOpening";


export interface UseMainMenuActionsContext {
  layout: ReturnType<typeof useMainLayoutState>;
  sessionActions: ReturnType<typeof useMainSessionActions>;
  utilityTabs: ReturnType<typeof useMainUtilityTabs>;
  workspaceOpening: ReturnType<typeof useMainWorkspaceOpening>;
}

export function useMainMenuActions(context: UseMainMenuActionsContext) {
  const { layout, sessionActions, utilityTabs, workspaceOpening } = context;

  const toggleQuickConnectVisible = useCallback(() => {
    const next = !layout.quickConnectVisible;
    layout.setQuickConnectVisible(next);
    writeQuickConnectVisible(next);
    layout.setStatusMessage(tr(next ? "status.quickConnectShown" : "status.quickConnectHidden"));
  }, [layout.quickConnectVisible, layout.setStatusMessage]);

  const handleCommand = useCallback(createHandleCommand({
    handleNewSession: sessionActions.handleNewSession,
    handleNewSftpSession: sessionActions.handleNewSftpSession,
    openLocalTab: sessionActions.openLocalTab,
    activeTab: layout.activeTab,
    removeTab: layout.removeTab,
    loadSessions: layout.loadSessions,
    setStatusMessage: layout.setStatusMessage,
    toggleXServer: layout.toggleXServer,
    toggleSidebar: layout.toggleSidebar,
    toggleQuickConnectVisible,
    setSidebarCollapsed: layout.setSidebarCollapsed,
    toggleTerminalSplit: layout.toggleTerminalSplit,
    toggleMultiExec: layout.toggleMultiExec,
    requestAppExit: sessionActions.requestAppExit,
    tabsRef: layout.tabsRef,
    setActiveTab: layout.setActiveTab,
    addTab: layout.addTab,
    t: layout.t,
    openPlaceholderTab: utilityTabs.openPlaceholderTab,
    openGitRepository: workspaceOpening.openGitRepository,
    openEmptyCodeWorkspaceTab: workspaceOpening.openEmptyCodeWorkspaceTab,
    openSettingsTab: utilityTabs.openSettingsTab,
    openLanChatTab: utilityTabs.openLanChatTab,
    openUnifiedMailTab: utilityTabs.openUnifiedMailTab,
    openMfaTab: utilityTabs.openMfaTab,
    setShowAbout: layout.setShowAbout,
  }), [
    layout.activeTab,
    sessionActions.handleNewSession,
    sessionActions.handleNewSftpSession,
    layout.loadSessions,
    sessionActions.openLocalTab,
    workspaceOpening.openGitRepository,
    workspaceOpening.openEmptyCodeWorkspaceTab,
    utilityTabs.openPlaceholderTab,
    utilityTabs.openSettingsTab,
    utilityTabs.openLanChatTab,
    utilityTabs.openMfaTab,
    layout.removeTab,
    sessionActions.requestAppExit,
    layout.setActiveTab,
    layout.setStatusMessage,
    layout.setSidebarCollapsed,
    toggleQuickConnectVisible,
    layout.toggleTerminalSplit,
    layout.toggleSidebar,
    layout.toggleXServer,
  ]);

  // Route a native-menu activation to the right place: session import/export
  // is handled by the shared hook, everything else reuses handleCommand.
  const dispatchMenuAction = useCallback((action: MenuActionId) => {
    if (action.startsWith("workspace-command:")) {
      layout.getActiveWorkspaceCommands()?.executeAction(action.slice("workspace-command:".length));
      return;
    }
    switch (action) {
      case "import-json": layout.importExport.importJson(); break;
      case "import-moba": layout.importExport.importMoba(); break;
      case "import-csv": layout.importExport.importCsv(); break;
      case "download-csv-template": layout.importExport.downloadCsvTemplate(); break;
      case "import-openssh": layout.importExport.importOpenSsh(); break;
      case "export-json": layout.importExport.exportJson(); break;
      case "export-moba": layout.importExport.exportMoba(); break;
      case "export-csv": layout.importExport.exportCsv(); break;
      case "export-html": layout.importExport.exportHtml(); break;
      default:
        handleCommand(action as AppCommand);
    }
  }, [layout.getActiveWorkspaceCommands, handleCommand, layout.importExport]);
  useMainMenuBridge({
    dispatchMenuAction,
    nativeMenu: layout.nativeMenu,
    activeTabClosable: layout.activeTabClosable,
    importExport: layout.importExport,
    quickConnectVisible: layout.quickConnectVisible,
    getActiveWorkspaceCommands: layout.getActiveWorkspaceCommands,
    subscribeWorkspaceCommands: layout.subscribeWorkspaceCommands,
    t: layout.t,
    setActiveTab: layout.setActiveTab,
    workspaceCommandRegistrationsRef: layout.workspaceCommandRegistrationsRef,
    handleCommand,
  });
  return { handleCommand };
}
