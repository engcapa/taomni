import { Fragment, Suspense, type PointerEvent as ReactPointerEvent } from "react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import { TerminalPanel, type TerminalLocalPathUploadRequest } from "../../components/terminal/TerminalPanel";
import { GitPanel } from "../../components/git/GitPanel";
import { WorkspaceGitManager } from "../../components/git/WorkspaceGitManager";
import { CodeWorkspaceTab, type CodeWorkspaceGitManagerPayload } from "../../components/editor/CodeWorkspaceTab";
import type { WorkspaceCommandRegistration } from "../../components/editor/workspace/workspaceCommands";
import { SettingsPanel } from "../../components/settings/SettingsPanel";
import { LanChatGate } from "../../components/lanchat/LanChatGate";
import { TunnelManager } from "../../components/tunnel/TunnelManager";
import { SocksCapPanel } from "../../components/sockscap/SocksCapPanel";
import { MfaTab } from "../../components/mfa/MfaTab";
import { FileBrowser, type SftpPendingUploadRequest } from "../../components/filebrowser/FileBrowser";
import { LocalFileBrowserPanel } from "../../components/filebrowser/LocalFileBrowserPanel";
import { ObjectStorageBrowser } from "../../components/objectstorage/ObjectStorageBrowser";
import { MailClientTab } from "../../components/mail/MailClientTab";
import { MailUnifiedTab } from "../../components/mail/MailUnifiedTab";
import { SftpSidebar } from "../../components/filebrowser/SftpSidebar";
import { writeTerminal } from "../../lib/ipc";
import { encodeBase64 } from "../../lib/ipc";
import type { VncSessionProperties } from "../../components/vnc/VncPropertiesDialog";
import { Lock, Unlock } from "lucide-react";
import type { Tab, MailTabInfo, RecentWorkspace } from "../../types";
import { buildTabDetailSummary } from "../../lib/tabDetails";
import { WelcomePanel } from "../../components/WelcomePanel";
import { type SessionConfig } from "../../lib/ipc";
import { type TerminalProfile } from "../../lib/terminalProfile";
import { getSessionNetworkSettings, toNetworkSettingsPayload } from "../../lib/networkSettings";
import { loadResizableLayout, saveResizableLayout } from "../../lib/resizableLayout";
import type { LocalLaunchOutcome, LocalShellSelection } from "../../types";
import { t as tr } from "../../lib/i18n";
import { alertAppDialog } from "../../lib/appDialogs";
import { chatBindingIdForTab } from "./sessionPolicy";
import { cumulativeWeightPercent } from "./splitLayout";
import { TerminalSplitToolbar } from "./TerminalSplitToolbar";
import { VncLoadingPanel, VncPanel, RdpLoadingPanel, RdpPanel, DbLoadingPanel, DbClientTab, RedisClientTab, HBaseShellTab, ProxyTestTab, UnavailablePanel } from "./panels";


export interface TabContentRouterProps {
  activeTab: Tab | undefined;
  welcomeRestore: import("../../hooks/useWelcomeSessionResume").UseWelcomeSessionResumeResult;
  openLocalTab: (title?: string, sessionId?: string, terminalProfile?: TerminalProfile, localShell?: LocalShellSelection, initialCwd?: string, chatTabId?: string) => Promise<LocalLaunchOutcome>;
  handleNewSession: (groupPath?: string | null) => void;
  handleOpenLocalPath: (target: string, opts?: { embedFolder?: boolean; title?: string; sessionId?: string; }) => Promise<void>;
  openLanChatTab: () => void;
  welcomeRecentSessions: SessionConfig[];
  recentWorkspaces: RecentWorkspace[];
  welcomeMailSessions: SessionConfig[];
  handleConnectSession: (session: SessionConfig) => void;
  handleConnectSessions: (targets: SessionConfig[]) => void;
  handleEditSession: (session: SessionConfig) => void;
  handleRevealRecentSession: (session: SessionConfig) => void;
  openRecentCodeWorkspace: (workspace: RecentWorkspace) => void;
  removeRecentWorkspace: (id: string) => void;
  clearRecentWorkspaces: () => void;
  revealRecentCodeWorkspace: (workspace: RecentWorkspace) => void;
  openNewCodeWorkspaceFromWelcome: () => Promise<void>;
  openSettingsTab: () => void;
  terminalSplitVisible: boolean;
  terminalSplitLayout: import("../../stores/appStore").TerminalSplitLayout;
  terminalSplitInputLockedTabIds: Set<string>;
  setTerminalSplitLayout: (layout: import("../../stores/appStore").TerminalSplitLayout) => void;
  clearTerminalSplitInputLocks: () => void;
  toggleTerminalSplit: () => void;
  splitPanesRef: import("react").RefObject<HTMLDivElement | null>;
  terminalPanesClass: string;
  splitGridColumnTemplate: string;
  splitGridRowTemplate: string;
  terminalTabs: Tab[];
  activeTabId: string | null;
  attachedSidebars: Record<string, boolean>;
  terminalProfileOverrides: Record<string, TerminalProfile>;
  terminalProfilesBySessionId: Map<string, TerminalProfile | undefined>;
  sessions: SessionConfig[];
  terminalRuntimeByTab: Record<string, import("../../stores/appStore").TerminalRuntimeInfo>;
  terminalCwds: Record<string, string>;
  t: import("../../lib/i18n").TranslateFn;
  handleTerminalProfileChange: (tabId: string, profile: TerminalProfile) => void;
  handleTerminalCwd: (tabId: string, cwd: string) => void;
  terminalCwdRequestTokens: Record<string, number>;
  terminalSessionIds: import("react").RefObject<Record<string, string>>;
  completeLocalLaunch: (tabId: string, outcome: LocalLaunchOutcome) => void;
  resolveResumeWaiterForTab: (tabId: string, status: "connected" | "failed", error?: unknown) => void;
  handleTerminalOutput: (tabId: string) => void;
  handleTerminalLocalPathUpload: (tabId: string, request: TerminalLocalPathUploadRequest) => Promise<void>;
  multiExecActive: boolean;
  multiExecSelectedTabIds: Set<string>;
  broadcastToSelectedTerminals: (data: string, sourceTabId?: string) => void;
  openDetachedTerminal: (tabId: string, tab: Tab, title: string) => void;
  aiFullyDisabled: boolean;
  terminalRailMerged: boolean;
  chatDrawerOpen: boolean;
  toggleTabChat: (tabId: string) => Promise<void>;
  toggleTerminalSftp: (tab: Tab) => void;
  terminalCwdsRef: import("react").RefObject<Record<string, string>>;
  queryTerminalCwd: (tabId: string) => Promise<string | null>;
  openGitRepository: (path?: string | null) => Promise<void>;
  terminalCwdVersions: Record<string, number>;
  toggleAttachedSidebar: (tabId: string) => void;
  requestTerminalCwd: (tabId: string) => boolean;
  pendingSftpUploadRequests: Record<string, SftpPendingUploadRequest>;
  setPendingSftpUploadRequests: import("react").Dispatch<import("react").SetStateAction<Record<string, SftpPendingUploadRequest>>>;
  setSftpDetachedTabs: import("react").Dispatch<import("react").SetStateAction<Record<string, boolean>>>;
  setAttachedSidebars: import("react").Dispatch<import("react").SetStateAction<Record<string, boolean>>>;
  openDetachedSftp: (params: import("../../types").SftpTabInfo, title: string) => void;
  splitGridColumns: number;
  splitPaneWeightsForTabs: number[];
  setActiveTab: (id: string) => void;
  toggleTerminalSplitInputLock: (tabId: string) => void;
  startLinearSplitResize: (index: number, event: ReactPointerEvent<HTMLDivElement>) => void;
  splitGridColumnWeightsForLayout: number[];
  startGridSplitResize: (axis: "column" | "row", index: number, event: ReactPointerEvent<HTMLDivElement>) => void;
  splitGridRowWeightsForLayout: number[];
  sftpTabs: Tab[];
  settingsTabs: Tab[];
  gitTabs: Tab[];
  openCodeWorkspaceTab: (repoRoot: string, initialPath?: string | null) => void;
  codeWorkspaceTabs: Tab[];
  openWorkspaceGitManager: (payload: CodeWorkspaceGitManagerPayload) => void;
  syncWorkspaceGitManager: (payload: CodeWorkspaceGitManagerPayload) => void;
  handleWorkspaceCommandsChange: (tabId: string, registration: WorkspaceCommandRegistration | null) => void;
  tabs: Tab[];
  unifiedMailAccounts: MailTabInfo[];
  openMailAccountById: (sessionId: string) => void;
  vncTabs: Tab[];
  persistVncProperties: (tabId: string, sessionId: string, properties: VncSessionProperties) => Promise<void>;
  rememberVncCredentials: (tabId: string, sessionId: string, password: string) => Promise<void>;
  openDetachedVnc: (tabId: string, info: NonNullable<Tab["vnc"]>, title: string) => void;
  rdpTabs: Tab[];
  openDetachedRdp: (tabId: string, info: NonNullable<Tab["rdp"]>, title: string) => void;
  fileBrowserTabs: Tab[];
  objectStorageTabs: Tab[];
  mailTabs: Tab[];
  handleEditSessionById: (sessionId: string) => void;
  dbTabs: Tab[];
  redisTabs: Tab[];
  hbaseTabs: Tab[];
  setStatusMessage: (message: string) => void;
  removeTab: (id: string) => void;
}

export function TabContentRouter(viewProps: TabContentRouterProps) {
  const { activeTab, activeTabId, aiFullyDisabled, attachedSidebars, broadcastToSelectedTerminals, chatDrawerOpen, clearRecentWorkspaces, clearTerminalSplitInputLocks, codeWorkspaceTabs, completeLocalLaunch, dbTabs, fileBrowserTabs, gitTabs, handleConnectSession, handleConnectSessions, handleEditSession, handleEditSessionById, handleNewSession, handleOpenLocalPath, handleRevealRecentSession, handleTerminalCwd, handleTerminalLocalPathUpload, handleTerminalOutput, handleTerminalProfileChange, handleWorkspaceCommandsChange, hbaseTabs, mailTabs, multiExecActive, multiExecSelectedTabIds, objectStorageTabs, openCodeWorkspaceTab, openDetachedRdp, openDetachedSftp, openDetachedTerminal, openDetachedVnc, openGitRepository, openLanChatTab, openLocalTab, openMailAccountById, openNewCodeWorkspaceFromWelcome, openRecentCodeWorkspace, openSettingsTab, openWorkspaceGitManager, pendingSftpUploadRequests, persistVncProperties, queryTerminalCwd, rdpTabs, recentWorkspaces, redisTabs, rememberVncCredentials, removeRecentWorkspace, removeTab, requestTerminalCwd, resolveResumeWaiterForTab, revealRecentCodeWorkspace, sessions, setActiveTab, setAttachedSidebars, setPendingSftpUploadRequests, setSftpDetachedTabs, setStatusMessage, setTerminalSplitLayout, settingsTabs, sftpTabs, splitGridColumnTemplate, splitGridColumnWeightsForLayout, splitGridColumns, splitGridRowTemplate, splitGridRowWeightsForLayout, splitPaneWeightsForTabs, splitPanesRef, startGridSplitResize, startLinearSplitResize, syncWorkspaceGitManager, t, tabs, terminalCwdRequestTokens, terminalCwdVersions, terminalCwds, terminalCwdsRef, terminalPanesClass, terminalProfileOverrides, terminalProfilesBySessionId, terminalRailMerged, terminalRuntimeByTab, terminalSessionIds, terminalSplitInputLockedTabIds, terminalSplitLayout, terminalSplitVisible, terminalTabs, toggleAttachedSidebar, toggleTabChat, toggleTerminalSftp, toggleTerminalSplit, toggleTerminalSplitInputLock, unifiedMailAccounts, vncTabs, welcomeMailSessions, welcomeRecentSessions, welcomeRestore } = viewProps;
 return (<div className="flex-1 min-h-0 overflow-hidden relative">
                {/* Welcome stays mounted so filters, scroll, and shell
                    selections survive switching to another tab. */}
                <div
                  data-testid="welcome-tab-panel"
                  className="absolute inset-0"
                  style={{ display: (activeTab?.type === "welcome" || !activeTab) ? "block" : "none" }}
                >
                  <WelcomePanel
                    active={activeTab?.type === "welcome" || !activeTab}
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
                    onOpenLanChat={openLanChatTab}
                    recentSessions={welcomeRecentSessions}
                    recentWorkspaces={recentWorkspaces}
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

                {/* All terminal tabs stay mounted. Single-tab mode hides
                    inactive panes; split mode only changes the pane wrappers. */}
                <div
                  data-testid="terminal-split-stage"
                  data-active={terminalSplitVisible || undefined}
                  data-split-layout={terminalSplitVisible ? terminalSplitLayout : undefined}
                  className={terminalSplitVisible ? "absolute inset-0 z-10 flex flex-col" : "contents"}
                >
                  <div style={{ display: terminalSplitVisible ? "block" : "none" }}>
                    <TerminalSplitToolbar
                      layout={terminalSplitLayout}
                      lockedCount={terminalSplitInputLockedTabIds.size}
                      onLayoutChange={setTerminalSplitLayout}
                      onClearLocks={clearTerminalSplitInputLocks}
                      onClose={toggleTerminalSplit}
                    />
                  </div>
                  <div
                    ref={splitPanesRef}
                    data-testid="terminal-split-panes"
                    data-layout={terminalSplitVisible ? terminalSplitLayout : undefined}
                    className={terminalPanesClass}
                    style={terminalSplitVisible && terminalSplitLayout === "grid"
                      ? {
                        gridTemplateColumns: splitGridColumnTemplate,
                        gridTemplateRows: splitGridRowTemplate,
                      }
                      : undefined}
                  >
                    {terminalTabs.map((tab, index) => {
                      const isActive = activeTabId === tab.id;
                      const inputLocked = terminalSplitVisible && terminalSplitInputLockedTabIds.has(tab.id);
                      const sidebarOpen = !terminalSplitVisible && !!attachedSidebars[tab.id] && !!tab.ssh;
                      const liveTerminalProfile = terminalProfileOverrides[tab.id]
                        ?? (tab.sessionId ? terminalProfilesBySessionId.get(tab.sessionId) : undefined)
                        ?? tab.terminalProfile;
                      const tabDetails = buildTabDetailSummary(
                        tab,
                        sessions,
                        terminalRuntimeByTab[tab.id],
                        terminalCwds[tab.id],
                        t,
                      );
                      const terminalNode = (
                        <div className="h-full w-full relative">
                          <TerminalPanel
                            tabId={tab.id}
                            tabTitle={tab.title}
                            ssh={tab.ssh}
                            commandTerminal={tab.commandTerminal}
                            localShell={tab.localShell}
                            sockscapTerminal={tab.sockscapTerminal}
                            terminalProfile={liveTerminalProfile}
                            onTerminalProfileChange={(profile) => handleTerminalProfileChange(tab.id, profile)}
                            adoptedTerminal={tab.adoptedTerminal}
                            initialCwd={tab.terminalInitialCwd}
                            visible={terminalSplitVisible || isActive}
                            activeForShortcuts={isActive}
                            inputLocked={inputLocked}
                            onCwdChange={(cwd) => handleTerminalCwd(tab.id, cwd)}
                            cwdRequestToken={terminalCwdRequestTokens[tab.id] ?? 0}
                            onSessionReady={(sid) => {
                              terminalSessionIds.current[tab.id] = sid;
                              completeLocalLaunch(tab.id, { tabId: tab.id, status: "started" });
                              resolveResumeWaiterForTab(tab.id, "connected");
                            }}
                            onSessionLaunchFailed={(error) => {
                              completeLocalLaunch(tab.id, {
                                tabId: tab.id,
                                status: "failed",
                                error: String(error),
                              });
                              resolveResumeWaiterForTab(tab.id, "failed", error);
                            }}
                            onOutput={() => handleTerminalOutput(tab.id)}
                            onUploadLocalPaths={
                              tab.ssh
                                ? (request) => handleTerminalLocalPathUpload(tab.id, request)
                                : undefined
                            }
                            multiExecActive={multiExecActive}
                            isMultiExecTarget={
                              multiExecActive &&
                              multiExecSelectedTabIds.has(tab.id) &&
                              !inputLocked
                            }
                            onInputBroadcast={
                              multiExecActive && !inputLocked && (terminalSplitVisible || isActive)
                                ? (data) => broadcastToSelectedTerminals(data, tab.id)
                                : undefined
                            }
                            detachToggle={!terminalSplitVisible ? {
                              onDetach: () => openDetachedTerminal(tab.id, tab, tab.title),
                            } : undefined}
                            chatToggle={!aiFullyDisabled && !(terminalRailMerged && isActive) ? {
                              open: chatDrawerOpen && activeTabId === tab.id,
                              onToggle: () => void toggleTabChat(chatBindingIdForTab(tab) ?? tab.id),
                            } : undefined}
                            sftpToggle={!terminalSplitVisible && tab.ssh && !(terminalRailMerged && isActive) ? {
                              open: sidebarOpen,
                              onToggle: () => toggleTerminalSftp(tab),
                            } : undefined}
                            gitToggle={!tab.ssh && !tab.commandTerminal ? {
                              cwd: terminalCwds[tab.id] ?? null,
                              onOpen: async () => {
                                const cwd = terminalCwdsRef.current[tab.id] ?? await queryTerminalCwd(tab.id);
                                if (!cwd) {
                                  await alertAppDialog({
                                    title: "Git Repository",
                                    message: "The current terminal directory is not available yet.",
                                  });
                                  return;
                                }
                                await openGitRepository(cwd);
                              },
                            } : undefined}
                          />
                        </div>
                      );
                      const sftpSidebarNode = sidebarOpen && tab.ssh ? (
                        <SftpSidebar
                          sessionId={`attached-${tab.id}`}
                          host={tab.ssh.host}
                          port={tab.ssh.port}
                          username={tab.ssh.username}
                          authMethod={tab.ssh.authMethod}
                          authData={tab.ssh.authData}
                          networkSettingsJson={JSON.stringify(
                            toNetworkSettingsPayload(getSessionNetworkSettings(tab.ssh.optionsJson)),
                          )}
                          cwdHint={terminalCwds[tab.id] ?? null}
                          cwdHintVersion={terminalCwdVersions[tab.id] ?? 0}
                          title={`SFTP — ${tab.ssh.username}@${tab.ssh.host}`}
                          onClose={() => toggleAttachedSidebar(tab.id)}
                          onRequestTerminalCwd={() => requestTerminalCwd(tab.id)}
                          pendingUploadRequest={pendingSftpUploadRequests[`attached-${tab.id}`] ?? null}
                          onPendingUploadRequestHandled={(requestId) => {
                            const sftpSessionId = `attached-${tab.id}`;
                            setPendingSftpUploadRequests((prev) => {
                              if (prev[sftpSessionId]?.id !== requestId) return prev;
                              const next = { ...prev };
                              delete next[sftpSessionId];
                              return next;
                            });
                          }}
                          onOpenTerminalHere={(p) => {
                            const sid = terminalSessionIds.current[tab.id];
                            if (!sid) return;
                            const escaped = p.replace(/'/g, "'\\''");
                            // The leading space is a sacrificial guard: Windows
                            // OpenSSH/ConPTY intermittently drops the first byte of
                            // a pty write (observed as "d '<path>'"), and bash
                            // ignores the extra space. It also keeps the line out of
                            // history for shells with ignorespace enabled.
                            void writeTerminal(sid, encodeBase64(` cd '${escaped}'\r`));
                          }}
                          onDetach={() => {
                            setSftpDetachedTabs((prev) => ({ ...prev, [tab.id]: true }));
                            setAttachedSidebars((prev) => ({ ...prev, [tab.id]: false }));
                            openDetachedSftp(
                              {
                                sessionId: `attached-${tab.id}`,
                                host: tab.ssh!.host,
                                port: tab.ssh!.port,
                                username: tab.ssh!.username,
                                authMethod: tab.ssh!.authMethod,
                                authData: tab.ssh!.authData,
                                networkSettingsJson: JSON.stringify(
                                  toNetworkSettingsPayload(getSessionNetworkSettings(tab.ssh!.optionsJson)),
                                ),
                                initialPath: terminalCwds[tab.id],
                                attachedToTerminal: true,
                              },
                              `${tab.title} — SFTP`,
                            );
                          }}
                        />
                      ) : null;
                      const gridColumn = index % splitGridColumns + 1;
                      const gridRow = Math.floor(index / splitGridColumns) + 1;
                      return (
                        <Fragment key={tab.id}>
                        <div
                          data-testid="terminal-split-pane"
                          data-tab-id={tab.id}
                          data-active={isActive || undefined}
                          data-input-locked={inputLocked || undefined}
                          className={
                            terminalSplitVisible
                              ? "relative min-w-0 min-h-0 flex flex-col overflow-hidden border-r border-b border-[var(--taomni-divider)]"
                              : "absolute inset-0"
                          }
                          style={terminalSplitVisible
                            ? terminalSplitLayout === "grid"
                              ? { gridColumn, gridRow }
                              : {
                                flexGrow: splitPaneWeightsForTabs[index],
                                flexShrink: 1,
                                flexBasis: 0,
                              }
                            : { display: isActive ? "block" : "none" }}
                          onMouseDownCapture={() => {
                            if (terminalSplitVisible && activeTabId !== tab.id) {
                              setActiveTab(tab.id);
                            }
                          }}
                        >
                          <div
                            className="h-7 shrink-0 items-center gap-2 px-2 text-[11px]"
                            style={{
                              display: terminalSplitVisible ? "flex" : "none",
                              background: isActive ? "var(--taomni-selected)" : "var(--taomni-chrome-bg)",
                              borderBottom: "1px solid var(--taomni-divider)",
                              color: "var(--taomni-text)",
                            }}
                          >
                            <button
                              type="button"
                              className="min-w-0 flex-1 truncate text-left"
                              onClick={() => setActiveTab(tab.id)}
                              title={tab.title}
                            >
                              {tab.title}
                            </button>
                            <span
                              data-testid={`terminal-split-activity-${tab.id}`}
                              className="max-w-[150px] truncate rounded px-1.5 py-0.5 text-[10px] text-[var(--taomni-text-muted)]"
                              style={{ background: "var(--taomni-hover)" }}
                              title={tabDetails.activityLabel}
                            >
                              {tabDetails.activityLabel}
                            </span>
                            <button
                              type="button"
                              data-testid={`terminal-split-lock-${tab.id}`}
                              aria-label={inputLocked ? t("terminalSplit.unlockInput", { title: tab.title }) : t("terminalSplit.lockInput", { title: tab.title })}
                              title={inputLocked ? t("terminalSplit.unlockTitle") : t("terminalSplit.lockTitle")}
                              className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
                              style={inputLocked ? { color: "var(--taomni-accent)" } : undefined}
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleTerminalSplitInputLock(tab.id);
                              }}
                            >
                              {inputLocked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                            </button>
                          </div>
                          {/* Always render the PanelGroup so the terminal Panel
                              stays mounted across sidebar open/close. */}
                          <div className={terminalSplitVisible ? "flex-1 min-h-0" : "h-full"}>
                            <PanelGroup
                              orientation="horizontal"
                              id={`terminal-sftp-${tab.id}`}
                              defaultLayout={loadResizableLayout(
                                `terminal-sftp-${tab.id}`,
                                sftpSidebarNode ? ["terminal", "sftp"] : ["terminal"],
                              )}
                              onLayoutChanged={saveResizableLayout(`terminal-sftp-${tab.id}`)}
                            >
                              <Panel id="terminal" defaultSize="62%" minSize="25%" className="min-w-0">
                                <div className="h-full">{terminalNode}</div>
                              </Panel>
                              {sftpSidebarNode && (
                                <>
                                  <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize" />
                                  <Panel
                                    id="sftp"
                                    defaultSize="38%"
                                    minSize="20%"
                                    maxSize="70%"
                                    className="min-w-0"
                                  >
                                    <div
                                      className="h-full"
                                      style={{
                                        borderLeft: "1px solid var(--taomni-divider)",
                                        background: "var(--taomni-bg)",
                                      }}
                                    >
                                      {sftpSidebarNode}
                                    </div>
                                  </Panel>
                                </>
                              )}
                            </PanelGroup>
                          </div>
                        </div>
                        {terminalSplitVisible && terminalSplitLayout !== "grid" && index < terminalTabs.length - 1 && (
                          <div
                            data-testid="terminal-split-resize-handle"
                            data-orientation={terminalSplitLayout}
                            className={
                              terminalSplitLayout === "horizontal"
                                ? "w-1.5 shrink-0 cursor-col-resize bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors"
                                : "h-1.5 shrink-0 cursor-row-resize bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors"
                            }
                            onPointerDown={(event) => startLinearSplitResize(index, event)}
                            role="separator"
                            aria-orientation={terminalSplitLayout === "horizontal" ? "vertical" : "horizontal"}
                            title={t("terminalSplit.resizePanes")}
                          />
                        )}
                        </Fragment>
                      );
                    })}
                    {terminalSplitVisible && terminalSplitLayout === "grid" && (
                      <>
                        {splitGridColumnWeightsForLayout.slice(0, -1).map((_, index) => (
                          <div
                            key={`grid-col-${index}`}
                            data-testid="terminal-split-grid-column-resize-handle"
                            className="absolute top-0 bottom-0 z-30 w-1.5 -translate-x-1/2 cursor-col-resize bg-transparent hover:bg-[var(--taomni-accent)]/70"
                            style={{ left: `${cumulativeWeightPercent(splitGridColumnWeightsForLayout, index)}%` }}
                            onPointerDown={(event) => startGridSplitResize("column", index, event)}
                            role="separator"
                            aria-orientation="vertical"
                            title={t("terminalSplit.resizeColumn")}
                          />
                        ))}
                        {splitGridRowWeightsForLayout.slice(0, -1).map((_, index) => (
                          <div
                            key={`grid-row-${index}`}
                            data-testid="terminal-split-grid-row-resize-handle"
                            className="absolute left-0 right-0 z-30 h-1.5 -translate-y-1/2 cursor-row-resize bg-transparent hover:bg-[var(--taomni-accent)]/70"
                            style={{ top: `${cumulativeWeightPercent(splitGridRowWeightsForLayout, index)}%` }}
                            onPointerDown={(event) => startGridSplitResize("row", index, event)}
                            role="separator"
                            aria-orientation="horizontal"
                            title={t("terminalSplit.resizeRow")}
                          />
                        ))}
                      </>
                    )}
                  </div>
                </div>

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

                {activeTab?.type === "lan-chat" && <LanChatGate />}

                {tabs.some((tab) => tab.type === "mail-unified") && (
                  <div className="absolute inset-0" style={{ display: activeTab?.type === "mail-unified" ? "block" : "none" }}>
                    <MailUnifiedTab
                      accounts={unifiedMailAccounts}
                      visible={activeTab?.type === "mail-unified"}
                      onOpenAccount={openMailAccountById}
                    />
                  </div>
                )}

                {/* VNC tabs — always mounted so connection survives tab switches */}
                {vncTabs.map((tab) => {
                  const vnc = tab.vnc;
                  if (!vnc) return null;
                  const isActive = activeTabId === tab.id;
                  return (
                    <div
                      key={tab.id}
                      className="absolute inset-0"
                      style={{ display: isActive ? "block" : "none" }}
                    >
                      <Suspense fallback={<VncLoadingPanel />}>
                        <VncPanel
                          tabId={tab.id}
                          host={vnc.host}
                          port={vnc.port}
                          username={vnc.username}
                          password={vnc.password}
                          networkSettingsJson={vnc.networkSettingsJson}
                          securityPolicy={vnc.securityPolicy}
                          viewOnly={vnc.viewOnly}
                          clipboardPolicy={vnc.clipboardPolicy}
                          viewerOptions={vnc.viewerOptions}
                          onSessionPropertiesChange={(properties) => {
                            void persistVncProperties(tab.id, vnc.sessionId, properties);
                          }}
                          onCredentialsChange={({ password: typed }) => {
                            void rememberVncCredentials(tab.id, vnc.sessionId, typed);
                          }}
                          visible={isActive}
                          onDetach={() => openDetachedVnc(tab.id, vnc, tab.title)}
                        />
                      </Suspense>
                    </div>
                  );
                })}

                {/* RDP tabs */}
                {rdpTabs.map((tab) => {
                  const rdp = tab.rdp;
                  if (!rdp) return null;
                  const isActive = activeTabId === tab.id;
                  return (
                    <div
                      key={tab.id}
                      className="absolute inset-0"
                      style={{ display: isActive ? "block" : "none" }}
                    >
                      <Suspense fallback={<RdpLoadingPanel />}>
                        <RdpPanel
                          tabId={tab.id}
                          host={rdp.host}
                          port={rdp.port}
                          username={rdp.username}
                          password={rdp.password}
                          options={rdp.options}
                          networkSettingsJson={rdp.networkSettingsJson}
                          visible={isActive}
                          onDetach={() => openDetachedRdp(tab.id, rdp, tab.title)}
                        />
                      </Suspense>
                    </div>
                  );
                })}

                {/* Embedded local file-browser tabs (File session type). */}
                {fileBrowserTabs.map((tab) => {
                  if (!tab.fileBrowser) return null;
                  const isActive = activeTabId === tab.id;
                  return (
                    <div
                      key={tab.id}
                      className="absolute inset-0"
                      style={{ display: isActive ? "block" : "none" }}
                    >
                      <LocalFileBrowserPanel
                        tabId={tab.id}
                        initialPath={tab.fileBrowser.initialPath}
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

                {mailTabs.map((tab) => {
                  if (!tab.mail) return null;
                  const isActive = activeTabId === tab.id;
                  return (
                    <div
                      key={tab.id}
                      className="absolute inset-0"
                      style={{ display: isActive ? "block" : "none" }}
                    >
                      <MailClientTab
                        tabId={tab.id}
                        info={tab.mail}
                        visible={isActive}
                        onEditSession={handleEditSessionById}
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

                {activeTab?.type === "sockscap" && (
                  <SocksCapPanel
                    onStatusMessage={setStatusMessage}
                    onClose={() => removeTab(activeTab.id)}
                  />
                )}

                {activeTab?.type === "mfa" && <MfaTab onStatusMessage={setStatusMessage} />}

                {activeTab?.type === "proxy-test" && activeTab.proxyTest && (
                  <Suspense fallback={null}>
                    <ProxyTestTab info={activeTab.proxyTest} />
                  </Suspense>
                )}

                {/* Non-terminal, non-sftp, non-vnc, non-rdp, non-welcome, non-settings, non-nettools tabs */}
                {activeTab &&
                  activeTab.type !== "welcome" &&
                  activeTab.type !== "terminal" &&
                  activeTab.type !== "sftp" &&
                  activeTab.type !== "vnc" &&
                  activeTab.type !== "rdp" &&
                  activeTab.type !== "file-browser" &&
                  activeTab.type !== "database" &&
                  activeTab.type !== "redis" &&
                  activeTab.type !== "hbase-shell" &&
                  activeTab.type !== "mail" &&
                  activeTab.type !== "mail-unified" &&
                  activeTab.type !== "settings" &&
                  activeTab.type !== "git" &&
                  activeTab.type !== "nettools" &&
                  activeTab.type !== "sockscap" &&
                  activeTab.type !== "lan-chat" &&
                  activeTab.type !== "mfa" &&
                  activeTab.type !== "proxy-test" && (
                  <UnavailablePanel title={activeTab.title} message={activeTab.message} />
                )}
              </div>);
}
