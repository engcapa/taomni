import { Suspense } from "react";
import { ViewerShell } from "../../components/viewer/ViewerShell";
import { CodeWorkspaceTab } from "../../components/editor/CodeWorkspaceTab";
import { FileBrowser } from "../../components/filebrowser/FileBrowser";
import { GitPanel } from "../../components/git/GitPanel";
import { WorkspaceGitManager } from "../../components/git/WorkspaceGitManager";
import { ObjectStorageBrowser } from "../../components/objectstorage/ObjectStorageBrowser";
import { SettingsPanel } from "../../components/settings/SettingsPanel";
import { TunnelManager } from "../../components/tunnel/TunnelManager";
import { TaoHomeHost } from "../../components/tao/home/TaoHomeHost";
import { t as tr } from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import {
  DbClientTab,
  DbLoadingPanel,
  HBaseShellTab,
  RedisClientTab,
  UnavailablePanel,
} from "./panels";
import { type TabContentRouterProps } from "./tabs/TabContentRouterProps";
import { TerminalTabContents } from "./tabs/TerminalTabContents";
import { PluginTabPanels } from "../../components/plugins/PluginTabPanels";

export function TabContentRouter(viewProps: TabContentRouterProps) {
  const storeRecentWorkspaces = useAppStore((state) => state.recentWorkspaces);
  const {
    activeTab,
    activeTabId,
    aiFullyDisabled,
    attachedSidebars,
    broadcastToSelectedTerminals,
    chatDrawerOpen,
    clearRecentWorkspaces,
    clearTerminalSplitInputLocks,
    codeWorkspaceTabs,
    completeLocalLaunch,
    dbTabs,
    gitTabs,
    handleConnectSession,
    handleConnectSessions,
    handleEditSession,
    handleEditSessionById,
    handleNewSession,
    handleOpenLocalPath,
    handleRevealRecentSession,
    handleTerminalCwd,
    handleTerminalLocalPathUpload,
    handleTerminalOutput,
    handleTerminalProfileChange,
    handleWorkspaceCommandsChange,
    hbaseTabs,
    multiExecActive,
    multiExecSelectedTabIds,
    objectStorageTabs,
    openCodeWorkspaceTab,
    openDetachedRdp,
    openDetachedSftp,
    openDetachedTerminal,
    openDetachedVnc,
    openGitRepository,
    openLocalTab,
    openMailAccountById,
    openNewCodeWorkspaceFromWelcome,
    openRecentCodeWorkspace,
    openSettingsTab,
    openWorkspaceGitManager,
    pendingSftpUploadRequests,
    persistVncProperties,
    queryTerminalCwd,
    recentWorkspaces,
    redisTabs,
    rememberVncCredentials,
    removeRecentWorkspace,
    removeTab,
    requestTerminalCwd,
    resolveResumeWaiterForTab,
    revealRecentCodeWorkspace,
    sessions,
    setActiveTab,
    setAttachedSidebars,
    setPendingSftpUploadRequests,
    setStatusMessage,
    setTerminalSplitLayout,
    settingsTabs,
    sftpTabs,
    splitGridColumnTemplate,
    splitGridColumnWeightsForLayout,
    splitGridColumns,
    splitGridRowTemplate,
    splitGridRowWeightsForLayout,
    splitPaneWeightsForTabs,
    splitPanesRef,
    startGridSplitResize,
    startLinearSplitResize,
    syncWorkspaceGitManager,
    t,
    tabs,
    terminalCwdRequestTokens,
    terminalCwdVersions,
    terminalCwds,
    terminalCwdsRef,
    terminalPanesClass,
    terminalProfileOverrides,
    terminalProfilesBySessionId,
    terminalRailMerged,
    terminalRuntimeByTab,
    terminalSessionIds,
    terminalSplitInputLockedTabIds,
    terminalSplitLayout,
    terminalSplitVisible,
    terminalTabs,
    toggleAttachedSidebar,
    toggleTabChat,
    toggleTerminalSftp,
    toggleTerminalSplit,
    toggleTerminalSplitInputLock,
    unifiedMailAccounts,
    welcomeMailSessions,
    welcomeRecentSessions,
    welcomeRestore,
  } = viewProps;
  return (<div className="flex-1 min-h-0 overflow-hidden relative">
    <PluginTabPanels
      tabs={tabs}
      activeTabId={activeTabId}
      onOpenSettings={openSettingsTab}
      onClose={removeTab}
      onStatusMessage={setStatusMessage}
      onPersistVncProperties={async (tabId, sessionId, properties) => persistVncProperties(tabId, sessionId, properties)}
      onRememberVncCredentials={async (tabId, sessionId, password) => rememberVncCredentials(tabId, sessionId, password)}
      onDetachVnc={openDetachedVnc}
      onDetachRdp={openDetachedRdp}
      unifiedMailAccounts={unifiedMailAccounts}
      onOpenMailAccount={openMailAccountById}
      onEditMailSession={handleEditSessionById}
    />
    {tabs.filter((tab) => tab.type === "file-viewer" && tab.fileViewer).map((tab) => <div key={tab.id} className="absolute inset-0" style={{ display: activeTabId === tab.id ? "block" : "none" }}><ViewerShell viewer={tab.fileViewer!} active={activeTabId === tab.id} /></div>)}
    {/* Welcome stays mounted so filters, scroll, and shell
                    selections survive switching to another tab. */}
    <div
      data-testid="welcome-tab-panel"
      className="absolute inset-0"
      style={{ display: (viewProps.showHome ?? (activeTab?.type === "welcome" || !activeTab)) ? "block" : "none" }}
    >
      <TaoHomeHost
        active={viewProps.showHome ?? (activeTab?.type === "welcome" || !activeTab)}
        restore={{
          view: welcomeRestore.view,
          outcomes: welcomeRestore.outcomes,
          onStartRestore: welcomeRestore.startRestore,
          onRetryFailed: welcomeRestore.retryFailed,
          onCancelRestore: welcomeRestore.cancelRestore,
          onClearRecord: () => void welcomeRestore.clearRecord(),
        }}
        onStartLocalTerminal={(localShell, cwd) => openLocalTab(localShell?.name ?? tr("tabs.localTerminal"), undefined, undefined, localShell, cwd)}
        onNewSession={handleNewSession}
        onOpenLocalPath={(path, opts) => void handleOpenLocalPath(path, opts)}
        recentSessions={welcomeRecentSessions}
        recentWorkspaces={recentWorkspaces ?? storeRecentWorkspaces}
        mailSessions={welcomeMailSessions}
        onOpenMailSession={handleConnectSession}
        onOpenRecentSession={handleConnectSession}
        onOpenRecentSessions={handleConnectSessions}
        onEditRecentSession={handleEditSession}
        onRevealRecentSession={handleRevealRecentSession}
        onOpenRecentWorkspace={openRecentCodeWorkspace}
        onRemoveRecentWorkspace={(workspace) => removeRecentWorkspace(workspace.id)}
        onClearRecentWorkspaces={clearRecentWorkspaces}
        onRevealRecentWorkspace={revealRecentCodeWorkspace}
        onOpenNewWorkspace={() => void openNewCodeWorkspaceFromWelcome()}
        onOpenSettings={openSettingsTab}
      />
    </div>

    {viewProps.showHome === false && (!activeTab || activeTab.type === "welcome") && (
      <div data-testid={viewProps.toolsView ? "tools-empty-state" : "sessions-empty-state"} className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-ui-body">
        <span className="text-ui-title font-semibold">{t(viewProps.toolsView ? "platform.toolsEmpty" : "platform.sessionsEmpty")}</span>
        {!viewProps.toolsView && <button type="button" data-testid="sessions-empty-new-session" className="taomni-btn" onClick={() => handleNewSession()}>{t("menu.newSession")}</button>}
      </div>
    )}

    {/* All terminal tabs stay mounted. Single-tab mode hides
                    inactive panes; split mode only changes the pane wrappers. */}
    <TerminalTabContents
      terminalSplitVisible={terminalSplitVisible}
      terminalSplitLayout={terminalSplitLayout}
      terminalSplitInputLockedTabIds={terminalSplitInputLockedTabIds}
      setTerminalSplitLayout={setTerminalSplitLayout}
      clearTerminalSplitInputLocks={clearTerminalSplitInputLocks}
      toggleTerminalSplit={toggleTerminalSplit}
      splitPanesRef={splitPanesRef}
      terminalPanesClass={terminalPanesClass}
      splitGridColumnTemplate={splitGridColumnTemplate}
      splitGridRowTemplate={splitGridRowTemplate}
      terminalTabs={terminalTabs}
      activeTabId={activeTabId}
      attachedSidebars={attachedSidebars}
      terminalProfileOverrides={terminalProfileOverrides}
      terminalProfilesBySessionId={terminalProfilesBySessionId}
      sessions={sessions}
      terminalRuntimeByTab={terminalRuntimeByTab}
      terminalCwds={terminalCwds}
      t={t}
      handleTerminalProfileChange={handleTerminalProfileChange}
      handleTerminalCwd={handleTerminalCwd}
      terminalCwdRequestTokens={terminalCwdRequestTokens}
      terminalSessionIds={terminalSessionIds}
      completeLocalLaunch={completeLocalLaunch}
      resolveResumeWaiterForTab={resolveResumeWaiterForTab}
      handleTerminalOutput={handleTerminalOutput}
      handleTerminalLocalPathUpload={handleTerminalLocalPathUpload}
      multiExecActive={multiExecActive}
      multiExecSelectedTabIds={multiExecSelectedTabIds}
      broadcastToSelectedTerminals={broadcastToSelectedTerminals}
      openDetachedTerminal={openDetachedTerminal}
      aiFullyDisabled={aiFullyDisabled}
      terminalRailMerged={terminalRailMerged}
      chatDrawerOpen={chatDrawerOpen}
      toggleTabChat={toggleTabChat}
      toggleTerminalSftp={toggleTerminalSftp}
      terminalCwdsRef={terminalCwdsRef}
      queryTerminalCwd={queryTerminalCwd}
      openGitRepository={openGitRepository}
      terminalCwdVersions={terminalCwdVersions}
      toggleAttachedSidebar={toggleAttachedSidebar}
      requestTerminalCwd={requestTerminalCwd}
      pendingSftpUploadRequests={pendingSftpUploadRequests}
      setPendingSftpUploadRequests={setPendingSftpUploadRequests}
      setAttachedSidebars={setAttachedSidebars}
      openDetachedSftp={openDetachedSftp}
      splitGridColumns={splitGridColumns}
      splitPaneWeightsForTabs={splitPaneWeightsForTabs}
      setActiveTab={setActiveTab}
      toggleTerminalSplitInputLock={toggleTerminalSplitInputLock}
      startLinearSplitResize={startLinearSplitResize}
      splitGridColumnWeightsForLayout={splitGridColumnWeightsForLayout}
      startGridSplitResize={startGridSplitResize}
      splitGridRowWeightsForLayout={splitGridRowWeightsForLayout}
    />

    {/* SFTP standalone tabs stay mounted so transfers can finish
                    even when the user switches to another tab. */}
    {sftpTabs.map((tab) => {
      if (!tab.sftp) return null;
      const isActive = activeTabId === tab.id;
      return (
        <div
          key={tab.id}
          className="absolute inset-0"
          style={{ display: isActive ? "block" : "none" }}
        >
          <FileBrowser
            sessionId={tab.sftp.sessionId}
            host={tab.sftp.host}
            port={tab.sftp.port}
            username={tab.sftp.username}
            authMethod={tab.sftp.authMethod}
            authData={tab.sftp.authData}
            networkSettingsJson={tab.sftp.networkSettingsJson ?? null}
            initialPath={tab.sftp.initialPath}
            initialLocalPath={tab.sftp.initialLocalPath}
            pathMappings={tab.sftp.pathMappings}
            detachable
            onDetach={() => openDetachedSftp(tab.sftp!, tab.title)}
          />
        </div>
      );
    })}

    {settingsTabs.map((tab) => {
      const isActive = activeTabId === tab.id;
      return (
        <div
          key={tab.id}
          data-testid="settings-tab-panel"
          className="absolute inset-0"
          style={{ display: isActive ? "block" : "none" }}
        >
          <SettingsPanel />
        </div>
      );
    })}

    {/* Git tabs stay mounted so repository views, loaded logs, and
                    scroll position survive switching to another app tab. */}
    {gitTabs.map((tab) => {
      if (!tab.git) return null;
      const isActive = activeTabId === tab.id;
      const workspaceRoots = tab.git.workspaceRoots ?? [];
      return (
        <div
          key={tab.id}
          className="absolute inset-0"
          style={{ display: isActive ? "block" : "none" }}
        >
          {workspaceRoots.length > 0 ? (
            <WorkspaceGitManager
              workspaceName={tab.git.workspaceName}
              roots={workspaceRoots}
              activeRepoRoot={tab.git.activeRepoRoot ?? tab.git.repoRoot}
              visible={isActive}
              onOpenWorkspace={openCodeWorkspaceTab}
            />
          ) : (
            <GitPanel
              repoRoot={tab.git.repoRoot}
              visible={isActive}
              onOpenWorkspace={openCodeWorkspaceTab}
            />
          )}
        </div>
      );
    })}

    {codeWorkspaceTabs.map((tab) => {
      if (!tab.codeWorkspace) return null;
      const isActive = activeTabId === tab.id;
      return (
        <div
          key={tab.id}
          className="absolute inset-0"
          style={{ display: isActive ? "block" : "none" }}
        >
          <CodeWorkspaceTab
            tabId={tab.id}
            workspace={tab.codeWorkspace}
            visible={isActive}
            onOpenGitManager={openWorkspaceGitManager}
            onSyncGitManager={syncWorkspaceGitManager}
            onCommandsChange={handleWorkspaceCommandsChange}
          />
        </div>
      );
    })}

    {/* Object-storage (S3 / Azure Blob) browser tabs — always
                    mounted so in-flight transfers survive tab switches. */}
    {objectStorageTabs.map((tab) => {
      if (!tab.objectStorage) return null;
      const isActive = activeTabId === tab.id;
      return (
        <div
          key={tab.id}
          className="absolute inset-0"
          style={{ display: isActive ? "block" : "none" }}
        >
          <ObjectStorageBrowser
            sessionId={tab.objectStorage.sessionId}
            config={tab.objectStorage.config}
            title={tab.title}
          />
        </div>
      );
    })}

    {/* SQL database client tabs — always mounted so long queries
                    keep running across tab switches. */}
    {dbTabs.map((tab) => {
      if (!tab.db) return null;
      const isActive = activeTabId === tab.id;
      return (
        <div
          key={tab.id}
          className="absolute inset-0"
          style={{ display: isActive ? "block" : "none" }}
        >
          <Suspense fallback={<DbLoadingPanel />}>
            <DbClientTab
              tabId={tab.id}
              info={tab.db}
              visible={isActive}
            />
          </Suspense>
        </div>
      );
    })}

    {/* Redis client tabs — always mounted (CLI/monitor stay alive). */}
    {redisTabs.map((tab) => {
      if (!tab.db) return null;
      const isActive = activeTabId === tab.id;
      return (
        <div
          key={tab.id}
          className="absolute inset-0"
          style={{ display: isActive ? "block" : "none" }}
        >
          <Suspense fallback={<DbLoadingPanel />}>
            <RedisClientTab
              tabId={tab.id}
              info={tab.db}
              visible={isActive}
            />
          </Suspense>
        </div>
      );
    })}

    {/* HBase shell UI tabs - always mounted so command history and
                    active REST sessions survive tab switches. */}
    {hbaseTabs.map((tab) => {
      if (!tab.hbase) return null;
      const isActive = activeTabId === tab.id;
      return (
        <div
          key={tab.id}
          className="absolute inset-0"
          style={{ display: isActive ? "block" : "none" }}
        >
          <Suspense fallback={<DbLoadingPanel />}>
            <HBaseShellTab tabId={tab.id} info={tab.hbase} visible={isActive} />
          </Suspense>
        </div>
      );
    })}

    {activeTab?.type === "nettools" && (
      <TunnelManager
        onStatusMessage={setStatusMessage}
        onClose={() => removeTab(activeTab.id)}
      />
    )}

    {/* Non-terminal, non-sftp, non-vnc, non-rdp, non-welcome, non-settings, non-nettools tabs */}
    {activeTab &&
      activeTab.type !== "welcome" &&
      activeTab.type !== "terminal" &&
      activeTab.type !== "sftp" &&
      activeTab.type !== "vnc" &&
      activeTab.type !== "rdp" &&
      activeTab.type !== "file-viewer" &&
      activeTab.type !== "database" &&
      activeTab.type !== "redis" &&
      activeTab.type !== "hbase-shell" &&
      activeTab.type !== "mail" &&
      activeTab.type !== "mail-unified" &&
      activeTab.type !== "settings" &&
      activeTab.type !== "git" &&
      activeTab.type !== "nettools" &&
      activeTab.type !== "sockscap" &&
      activeTab.type !== "mfa" &&
      activeTab.type !== "servers" &&
      activeTab.type !== "plugin" &&
      activeTab.type !== "proxy-test" && (
        <UnavailablePanel title={activeTab.title} message={activeTab.message} />
      )}
  </div>);
}

export { type TabContentRouterProps } from "./tabs/TabContentRouterProps";
