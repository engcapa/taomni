import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle, type PanelSize } from "react-resizable-panels";
import { AboutDialog } from "../../components/AboutDialog";
import { CcAgentBridge } from "../../components/agent/CcAgentBridge";
import { ChatDrawer } from "../../components/chat/ChatDrawer";
import { ToolWindowRail } from "../../components/editor/workspace/panels/ToolWindowRail";
import { effectiveStripeWidth } from "../../components/editor/workspace/toolWindowLayout";
import { CallOverlay } from "../../components/lanchat/CallOverlay";
import { EdgeDrawer } from "../../components/lanchat/EdgeDrawer";
import { WhiteboardOverlay } from "../../components/lanchat/whiteboard/WhiteboardOverlay";
import { FloatingNotesPanel } from "../../components/notes/FloatingNotesPanel";
import { QuickConnect } from "../../components/quickconnect/QuickConnect";
import { AuthPrompt } from "../../components/session/AuthPrompt";
import { SessionEditor } from "../../components/session/SessionEditor";
import { Sidebar } from "../../components/sidebar/Sidebar";
import { StatusBar } from "../../components/statusbar/StatusBar";
import { AgentsPlatformView } from "../../components/agents/AgentsPlatformView";
import { MfaFloatingWindow } from "../../components/mfa/MfaFloatingWindow";
import { GlobalCommandModal } from "../../components/search/GlobalCommandModal";
import { RightContextPanel } from "../../components/workspace/RightContextPanel";
import { WorkspaceMainPanel } from "../../components/workspace/WorkspaceMainPanel";
import { useAppStore } from "../../stores/appStore";
import { useWorkspaceUiStore } from "../../stores/workspaceUiStore";
import { useWorkspaceRailStore } from "../../stores/workspaceRailStore";
import type { AppCommand } from "../../components/menubar/commands";
import { ControlBar } from "../../components/tabbar/ControlBar";
import { TabActionSlotProvider } from "../../components/tabbar/TabActionSlot";
import { TaoAlertPoller } from "../../components/tao/TaoAlertPoller";
import { TabOverview } from "../../components/tabbar/TabOverview";
import { MultiExecBar } from "../../components/terminal/MultiExecBar";
import { UpdateDialog } from "../../components/UpdateDialog";
import { VaultUnlockDialog } from "../../components/vault/VaultUnlockDialog";
import { WindowResizeHandles } from "../../components/window/WindowResizeHandles";
import { startWindowDrag } from "../../lib/windowDrag";
import { t as tr } from "../../lib/i18n";
import { loadResizableLayout, saveResizableLayout } from "../../lib/resizableLayout";
import { TabContentRouter } from "./TabContentRouter";
import { useMainConnectionActions } from "./useMainConnectionActions";
import { useMainLayoutChrome } from "./useMainLayoutChrome";
import { useMainLayoutState } from "./useMainLayoutState";
import { useMainMenuActions } from "./useMainMenuActions";
import { useMainSessionActions } from "./useMainSessionActions";
import { useMainTerminalIntegration } from "./useMainTerminalIntegration";
import { useMainUtilityTabs } from "./useMainUtilityTabs";
import { useMainWindowLifecycle } from "./useMainWindowLifecycle";
import { useMainWorkspaceOpening } from "./useMainWorkspaceOpening";
import { usePlatformShortcuts } from "./usePlatformShortcuts";


export interface MainLayoutViewProps {
  layout: ReturnType<typeof useMainLayoutState>;
  chrome: ReturnType<typeof useMainLayoutChrome>;
  menuActions: ReturnType<typeof useMainMenuActions>;
  sessionActions: ReturnType<typeof useMainSessionActions>;
  connections: ReturnType<typeof useMainConnectionActions>;
  terminals: ReturnType<typeof useMainTerminalIntegration>;
  windowLifecycle: ReturnType<typeof useMainWindowLifecycle>;
  workspaceOpening: ReturnType<typeof useMainWorkspaceOpening>;
  utilityTabs: ReturnType<typeof useMainUtilityTabs>;
}

export function MainLayoutView(props: MainLayoutViewProps) {
  const { layout, chrome, menuActions, sessionActions, connections, terminals, windowLifecycle, workspaceOpening, utilityTabs } = props;
  const { pendingAuth } = layout;
  const activeSideTab = useAppStore((s) => s.activeSideTab);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const setForceRailMerge = useWorkspaceRailStore((s) => s.setForceMerge);
  const openGlobalSearch = useWorkspaceUiStore((s) => s.openGlobalSearch);
  usePlatformShortcuts();

  // Tools and the main menu share the context-free editor entry point.
  const handleSidebarCommand = menuActions.handleCommand;

  // The command palette is mounted outside the menu-action tree; it asks the
  // shell to run a command through this event.
  useEffect(() => {
    const handler = (event: Event) => {
      const command = (event as CustomEvent<string>).detail;
      if (command) menuActions.handleCommand(command as AppCommand);
    };
    window.addEventListener("taomni:command", handler);
    return () => window.removeEventListener("taomni:command", handler);
  }, [menuActions]);

  // Workspaces mode merges the legacy Code Workspace rail into the primary
  // rail; other modes restore the ED-PARITY-027 behaviour.
  useEffect(() => {
    setForceRailMerge(activeSideTab === "workspaces");
    return () => setForceRailMerge(false);
  }, [activeSideTab, setForceRailMerge]);

  // Home opens as the wide launch surface from the prototype. The toolbar
  // toggles can still reveal either companion panel on demand.
  useEffect(() => {
    if (activeSideTab !== "home") return;
    useAppStore.getState().setSidebarCollapsed(true);
    useAppStore.getState().setRightSidebarCollapsed(true);
  }, [activeSideTab]);

  return ((
    <TabActionSlotProvider slot={layout.tabActionSlot}>
      <div
        className="taomni-main-window relative w-full h-full flex flex-col"
        style={{ background: "var(--taomni-chrome-bg)" }}
      >
        {!chrome.isMac && <WindowResizeHandles topEdgeSize={2} />}
        {/* Keep the outermost 2px and corners resizable. The remaining top
            frame is a common move target in every platform view. */}
        <div
          data-testid="main-window-top-drag-region"
          data-window-drag
          aria-hidden="true"
          className="fixed inset-x-[14px] top-[2px] h-[4px] z-[9999] cursor-grab active:cursor-grabbing"
          onMouseDown={startWindowDrag}
        />
        {chrome.chatDrawerTopPinned && <ChatDrawer />}

        <div data-testid="platform-workbench" className="taomni-platform-workbench flex-1 flex min-h-0">
          {chrome.terminalRailMerged && layout.mainRailHost && chrome.terminalRailItems.length > 0 && createPortal(
            <ToolWindowRail
              side="left"
              embedded
              top={chrome.terminalRailItems}
              width={effectiveStripeWidth(layout.stripeSettings, "left")}
              showNames={layout.stripeSettings.showNames}
              onToggleShowNames={layout.toggleStripeNames}
              onHide={(id) => chrome.terminalRailItems.find((item) => item.id === id)?.onSelect()}
            />,
            layout.mainRailHost,
          )}
          <div data-testid={layout.sidebarCollapsed ? "collapsed-sidebar-rail" : undefined} className="h-full shrink-0">
            <Sidebar
              railOnly
              compact={layout.sidebarCollapsed}
              onOpenSettings={() => menuActions.handleCommand("settings")}
            />
          </div>
          <PanelGroup
            orientation="horizontal"
            id="main-layout"
            defaultLayout={loadResizableLayout("main-layout", ["sidebar", "content"])}
            onLayoutChanged={saveResizableLayout("main-layout")}
            className="flex-1 min-w-0"
            // Size the resize hit target to match the 6px visible divider.
            // Sizing the hit target to the divider width keeps it from bleeding onto content/terminal.
            resizeTargetMinimumSize={{ coarse: 6, fine: 6 }}
          >
            <Panel
              panelRef={layout.sidebarPanelRef}
              id="sidebar"
              defaultSize="260px"
              minSize="180px"
              maxSize="520px"
              collapsible
              collapsedSize={0}
              // The panel's default scroll container can pan the fixed rail when
              // a focused/selected session is scrolled into view. Its children
              // own their scrolling; this frame must keep the rail in place.
              style={{ overflow: "clip" }}
              onResize={(size: PanelSize, _id, prevSize?: PanelSize) => {
                const percentage = size.asPercentage;
                if (percentage > 2) {
                  layout.lastSidebarSizeRef.current = percentage;
                }
                // The first report is the restored layout, which may carry another
                // tab group's collapsed sidebar (ED-PARITY-027); the store's state
                // wins and the sync effect resizes the panel to it.
                if (!prevSize) return;
                const collapsed = percentage <= 2;
                // A resize that applies the store's current state is not a
                // manual preference change (for example returning from Home).
                if (collapsed !== useAppStore.getState().sidebarCollapsed) {
                  layout.setSidebarCollapsed(collapsed);
                }
              }}
            >
              <div data-testid="expanded-sidebar-panel" className="taomni-navigator-frame h-full overflow-clip" style={layout.sidebarCollapsed ? { display: "none" } : undefined}>
                <Sidebar
                  panelOnly
                  onNewSession={sessionActions.handleNewSession}
                  onNewSftpSession={sessionActions.handleNewSftpSession}
                  onEditSession={sessionActions.handleEditSession}
                  onConnectSession={connections.handleConnectSession}
                  onOpenSettings={() => menuActions.handleCommand("settings")}
                  onCommand={handleSidebarCommand}
                  onStartLocalTerminal={() => sessionActions.openLocalTab(tr("tabs.localTerminal"))}
                />
              </div>
            </Panel>

            <PanelResizeHandle
              id="main-sidebar-resize-handle"
              data-testid="main-sidebar-resize-handle"
              className="taomni-platform-resizer"
              // Keep the separator in layout so the panel library retains its
              // adjacent-panel mapping when Home collapses the navigator.
              style={layout.sidebarCollapsed ? { width: 0, visibility: "hidden", pointerEvents: "none" } : undefined}
            />

            <Panel id="content">
              <div className="h-full flex min-w-0">
                {chrome.chatDrawerInline && layout.chatDrawerPosition === "left" && <ChatDrawer />}
                <div data-testid="main-canvas-frame" className="taomni-main-canvas-frame h-full flex flex-col min-w-0 flex-1">
        <div data-testid="app-titlebar" className="min-w-0">
          <ControlBar
            activeTabClosable={layout.activeTabClosable}
            nativeMenu={layout.nativeMenu}
            xServerEnabled={layout.xServerEnabled}
            quickConnectVisible={layout.quickConnectVisible}
            workspaceCommands={layout.activeWorkspaceCommandRegistration?.items ?? []}
            onCommand={menuActions.handleCommand}
            onWorkspaceCommand={(commandId) => layout.activeWorkspaceCommandRegistration?.executeAction(commandId)}
            onToggleSidebar={layout.toggleSidebar}
            onStartLocalTerminal={(localShell) =>
              sessionActions.openLocalTab(localShell?.name ?? tr("tabs.localTerminal"), undefined, undefined, localShell)
            }
            onConnectSession={connections.handleConnectSession}
            onOpenSessionEditor={() => sessionActions.handleNewSession()}
            onDuplicateTab={terminals.handleDuplicateTab}
            onDetachActiveTab={
              layout.activeTab && (
                (layout.activeTab.type === "terminal" && !chrome.terminalSplitVisible) ||
                (layout.activeTab.type === "rdp" && !!layout.activeTab.rdp) ||
                (layout.activeTab.type === "vnc" && !!layout.activeTab.vnc) ||
                (layout.activeTab.type === "database" && !!layout.activeTab.db) ||
                (layout.activeTab.type === "sftp" && !!layout.activeTab.sftp)
              )
                ? windowLifecycle.handleDetachActiveTab
                : undefined
            }
            onCloseWindow={sessionActions.requestAppExit}
            leftSidebarCollapsed={sidebarCollapsed}
            onOpenGlobalSearch={openGlobalSearch}
            slotRef={layout.setTabActionSlot}
          />
        </div>
        {layout.quickConnectVisible && (
          <QuickConnect
            onConnectInput={connections.handleQuickConnect}
            onConnectSession={connections.handleConnectSession}
            onHome={() => layout.setActiveTab("welcome")}
          />
        )}


                  {layout.multiExecActive && (
                    <MultiExecBar
                      selectedCount={chrome.effectiveMultiExecSelectedCount}
                      totalTerminalCount={layout.tabs.filter((t) => t.type === "terminal").length}
                      onSend={terminals.broadcastToSelectedTerminals}
                      onSelectAll={layout.selectAllTerminalTabs}
                      onClearSelection={layout.clearMultiExecSelection}
                      onClose={layout.toggleMultiExec}
                    />
                  )}
                  <div className="flex min-h-0 flex-1 flex-col" style={{ display: activeSideTab === "workspaces" ? "flex" : "none" }}>
                    <WorkspaceMainPanel onEditSession={sessionActions.handleEditSessionById} visible={activeSideTab === "workspaces"} onCommandsChange={layout.handleWorkspaceCommandsChange} />
                  </div>
                  {activeSideTab === "agents" && <AgentsPlatformView />}
                  <div data-testid="global-session-surface" className="flex min-h-0 flex-1 flex-col" style={{ display: activeSideTab === "workspaces" || activeSideTab === "agents" ? "none" : "flex" }}>
                  <TabContentRouter
                    activeTab={activeSideTab === "home" ? undefined : layout.activeTab}
                    showHome={activeSideTab === "home"}
                    toolsView={activeSideTab === "tools"}
                    welcomeRestore={workspaceOpening.welcomeRestore}
                    openLocalTab={sessionActions.openLocalTab}
                    handleNewSession={sessionActions.handleNewSession}
                    handleOpenLocalPath={workspaceOpening.handleOpenLocalPath}
                    openLanChatTab={utilityTabs.openLanChatTab}
                    welcomeRecentSessions={layout.welcomeRecentSessions}
                    recentWorkspaces={layout.recentWorkspaces}
                    welcomeMailSessions={layout.welcomeMailSessions}
                    handleConnectSession={connections.handleConnectSession}
                    handleConnectSessions={connections.handleConnectSessions}
                    handleEditSession={sessionActions.handleEditSession}
                    handleRevealRecentSession={connections.handleRevealRecentSession}
                    openRecentCodeWorkspace={workspaceOpening.openRecentCodeWorkspace}
                    removeRecentWorkspace={layout.removeRecentWorkspace}
                    clearRecentWorkspaces={layout.clearRecentWorkspaces}
                    revealRecentCodeWorkspace={workspaceOpening.revealRecentCodeWorkspace}
                    openNewCodeWorkspaceFromWelcome={workspaceOpening.openNewCodeWorkspaceFromWelcome}
                    openSettingsTab={utilityTabs.openSettingsTab}
                    terminalSplitVisible={activeSideTab !== "home" && activeSideTab !== "workspaces" && activeSideTab !== "agents" && chrome.terminalSplitVisible}
                    terminalSplitLayout={layout.terminalSplitLayout}
                    terminalSplitInputLockedTabIds={layout.terminalSplitInputLockedTabIds}
                    setTerminalSplitLayout={layout.setTerminalSplitLayout}
                    clearTerminalSplitInputLocks={layout.clearTerminalSplitInputLocks}
                    toggleTerminalSplit={layout.toggleTerminalSplit}
                    splitPanesRef={chrome.splitPanesRef}
                    terminalPanesClass={chrome.terminalPanesClass}
                    splitGridColumnTemplate={chrome.splitGridColumnTemplate}
                    splitGridRowTemplate={chrome.splitGridRowTemplate}
                    terminalTabs={chrome.terminalTabs}
                    activeTabId={activeSideTab === "home" || activeSideTab === "workspaces" || activeSideTab === "agents" ? null : layout.activeTabId}
                    attachedSidebars={layout.attachedSidebars}
                    terminalProfileOverrides={layout.terminalProfileOverrides}
                    terminalProfilesBySessionId={layout.terminalProfilesBySessionId}
                    sessions={layout.sessions}
                    terminalRuntimeByTab={layout.terminalRuntimeByTab}
                    terminalCwds={layout.terminalCwds}
                    t={layout.t}
                    handleTerminalProfileChange={layout.handleTerminalProfileChange}
                    handleTerminalCwd={terminals.handleTerminalCwd}
                    terminalCwdRequestTokens={layout.terminalCwdRequestTokens}
                    terminalSessionIds={layout.terminalSessionIds}
                    completeLocalLaunch={sessionActions.completeLocalLaunch}
                    resolveResumeWaiterForTab={workspaceOpening.resolveResumeWaiterForTab}
                    handleTerminalOutput={terminals.handleTerminalOutput}
                    handleTerminalLocalPathUpload={terminals.handleTerminalLocalPathUpload}
                    multiExecActive={layout.multiExecActive}
                    multiExecSelectedTabIds={layout.multiExecSelectedTabIds}
                    broadcastToSelectedTerminals={terminals.broadcastToSelectedTerminals}
                    openDetachedTerminal={windowLifecycle.openDetachedTerminal}
                    aiFullyDisabled={layout.aiFullyDisabled}
                    terminalRailMerged={chrome.terminalRailMerged}
                    chatDrawerOpen={layout.chatDrawerOpen}
                    toggleTabChat={layout.toggleTabChat}
                    toggleTerminalSftp={chrome.toggleTerminalSftp}
                    terminalCwdsRef={layout.terminalCwdsRef}
                    queryTerminalCwd={terminals.queryTerminalCwd}
                    openGitRepository={workspaceOpening.openGitRepository}
                    terminalCwdVersions={layout.terminalCwdVersions}
                    toggleAttachedSidebar={terminals.toggleAttachedSidebar}
                    requestTerminalCwd={terminals.requestTerminalCwd}
                    pendingSftpUploadRequests={layout.pendingSftpUploadRequests}
                    setPendingSftpUploadRequests={layout.setPendingSftpUploadRequests}
                    setSftpDetachedTabs={layout.setSftpDetachedTabs}
                    setAttachedSidebars={layout.setAttachedSidebars}
                    openDetachedSftp={windowLifecycle.openDetachedSftp}
                    splitGridColumns={chrome.splitGridColumns}
                    splitPaneWeightsForTabs={chrome.splitPaneWeightsForTabs}
                    setActiveTab={layout.setActiveTab}
                    toggleTerminalSplitInputLock={layout.toggleTerminalSplitInputLock}
                    startLinearSplitResize={chrome.startLinearSplitResize}
                    splitGridColumnWeightsForLayout={chrome.splitGridColumnWeightsForLayout}
                    startGridSplitResize={chrome.startGridSplitResize}
                    splitGridRowWeightsForLayout={chrome.splitGridRowWeightsForLayout}
                    sftpTabs={chrome.sftpTabs}
                    settingsTabs={chrome.settingsTabs}
                    gitTabs={chrome.gitTabs}
                    openCodeWorkspaceTab={workspaceOpening.openCodeWorkspaceTab}
                    codeWorkspaceTabs={chrome.codeWorkspaceTabs}
                    openWorkspaceGitManager={workspaceOpening.openWorkspaceGitManager}
                    syncWorkspaceGitManager={workspaceOpening.syncWorkspaceGitManager}
                    handleWorkspaceCommandsChange={layout.handleWorkspaceCommandsChange}
                    tabs={layout.tabs}
                    unifiedMailAccounts={utilityTabs.unifiedMailAccounts}
                    openMailAccountById={utilityTabs.openMailAccountById}
                    vncTabs={chrome.vncTabs}
                    persistVncProperties={sessionActions.persistVncProperties}
                    rememberVncCredentials={sessionActions.rememberVncCredentials}
                    openDetachedVnc={windowLifecycle.openDetachedVnc}
                    rdpTabs={chrome.rdpTabs}
                    openDetachedRdp={windowLifecycle.openDetachedRdp}
                    fileBrowserTabs={chrome.fileBrowserTabs}
                    objectStorageTabs={chrome.objectStorageTabs}
                    mailTabs={chrome.mailTabs}
                    handleEditSessionById={sessionActions.handleEditSessionById}
                    dbTabs={chrome.dbTabs}
                    redisTabs={chrome.redisTabs}
                    hbaseTabs={chrome.hbaseTabs}
                    setStatusMessage={layout.setStatusMessage}
                    removeTab={layout.removeTab}
                  />
                  </div>
                </div>
                {chrome.chatDrawerInline && layout.chatDrawerPosition === "right" && <ChatDrawer />}
              </div>
            </Panel>
          </PanelGroup>
          {chrome.chatDrawerFloating && <ChatDrawer />}
          <TabOverview />
          <RightContextPanel />
          <FloatingNotesPanel />
          <TaoAlertPoller />
        </div>

        {chrome.chatDrawerBottomPinned && <ChatDrawer />}

        <StatusBar />

        <MfaFloatingWindow
          onExpand={() => {
            useAppStore.getState().setActiveSideTab("sessions");
            menuActions.handleCommand("mfa");
          }}
        />
        <GlobalCommandModal />

        <CcAgentBridge />

        {layout.showSessionEditor && (
          <SessionEditor
            session={layout.editingSession}
            defaultGroupPath={layout.newSessionGroupPath}
            initialProto={layout.newSessionInitialProto}
            onClose={() => {
              layout.setShowSessionEditor(false);
              layout.setEditingSession(undefined);
              layout.setNewSessionGroupPath(null);
              layout.setNewSessionInitialProto(undefined);
            }}
          />
        )}

        {pendingAuth && (
          <AuthPrompt
            host={pendingAuth.kind === "jump" ? pendingAuth.host : pendingAuth.session.host}
            username={pendingAuth.kind === "jump" ? pendingAuth.username : pendingAuth.session.username ?? "root"}
            onSubmit={connections.handleAuthSubmit}
            onCancel={() => {
              if (pendingAuth.kind === "session" && pendingAuth.resumeRequestId) {
                workspaceOpening.cancelResumeWaiter(pendingAuth.resumeRequestId, "authentication", "Authentication cancelled");
              }
              layout.setPendingAuth(null);
              layout.awaitingManualAuthRef.current = false;
              layout.continueConnectQueueRef.current();
            }}
          />
        )}

        {layout.vaultUnlockReason && (
          <VaultUnlockDialog
            reason={layout.vaultUnlockReason}
            onCancel={() => {
              layout.pendingVaultActionRef.current = null;
              layout.awaitingVaultUnlockRef.current = false;
              layout.connectQueueRef.current = [];
              layout.setVaultUnlockReason(null);
              workspaceOpening.cancelAllResumeWaiters("authentication", "Vault unlock cancelled");
            }}
            onSubmit={async (pw) => {
              await layout.unlockVault(pw);
              const pending = layout.pendingVaultActionRef.current;
              layout.pendingVaultActionRef.current = null;
              layout.setVaultUnlockReason(null);
              layout.awaitingVaultUnlockRef.current = false;
              if (pending) pending();
            }}
          />
        )}

        {layout.showAbout && <AboutDialog onClose={() => layout.setShowAbout(false)} />}
        <UpdateDialog />

        {/* Session import preview — driven by the native macOS menu's
          import actions (no-op elsewhere, where the ControlBar app menu hosts
          its own). */}
        {layout.nativeMenu && layout.importExport.previewNode}

        {layout.appExitConfirmDialog}
        <CallOverlay />
        <WhiteboardOverlay />
        <EdgeDrawer />
      </div>
    </TabActionSlotProvider>
  ));
}
