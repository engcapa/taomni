import { sshBrowserMode } from "../../../lib/sshSessionOptions";
import { parseSessionOptions } from "../../../lib/terminalProfile";
import { Lock, Unlock } from "lucide-react";
import { Fragment } from "react";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { SftpSidebar } from "../../../components/filebrowser/SftpSidebar";
import { TerminalPanel } from "../../../components/terminal/TerminalPanel";
import { alertAppDialog } from "../../../lib/appDialogs";
import { encodeBase64, writeTerminal } from "../../../lib/ipc";
import { getSessionNetworkSettings, toNetworkSettingsPayload } from "../../../lib/networkSettings";
import { loadResizableLayout, saveResizableLayout } from "../../../lib/resizableLayout";
import { buildTabDetailSummary } from "../../../lib/tabDetails";
import { chatBindingIdForTab } from "../sessionPolicy";
import { cumulativeWeightPercent } from "../splitLayout";
import { TerminalSplitToolbar } from "../TerminalSplitToolbar";

export interface TerminalTabContentsProps {
  terminalSplitVisible: boolean;
  terminalSplitLayout: import("../../../stores/appStore").TerminalSplitLayout;
  terminalSplitInputLockedTabIds: Set<string>;
  setTerminalSplitLayout: (layout: import("../../../stores/appStore").TerminalSplitLayout) => void;
  clearTerminalSplitInputLocks: () => void;
  toggleTerminalSplit: () => void;
  splitPanesRef: import("react").RefObject<HTMLDivElement | null>;
  terminalPanesClass: string;
  splitGridColumnTemplate: string;
  splitGridRowTemplate: string;
  terminalTabs: import("../../../types").Tab[];
  activeTabId: string | null;
  attachedSidebars: Record<string, boolean>;
  terminalProfileOverrides: Record<string, import("../../../lib/terminalProfile").TerminalProfile>;
  terminalProfilesBySessionId: Map<string, import("../../../lib/terminalProfile").TerminalProfile | undefined>;
  sessions: import("../../../lib/ipc").SessionConfig[];
  terminalRuntimeByTab: Record<string, import("../../../stores/appStore").TerminalRuntimeInfo>;
  terminalCwds: Record<string, string>;
  t: import("../../../lib/i18n").TranslateFn;
  handleTerminalProfileChange: (tabId: string, profile: import("../../../lib/terminalProfile").TerminalProfile) => void;
  handleTerminalCwd: (tabId: string, cwd: string) => void;
  terminalCwdRequestTokens: Record<string, number>;
  terminalSessionIds: import("react").RefObject<Record<string, string>>;
  completeLocalLaunch: (tabId: string, outcome: import("../../../types").LocalLaunchOutcome) => void;
  resolveResumeWaiterForTab: (tabId: string, status: "connected" | "failed", error?: unknown) => void;
  handleTerminalOutput: (tabId: string) => void;
  handleTerminalLocalPathUpload: (tabId: string, request: import("../../../components/terminal/TerminalPanel").TerminalLocalPathUploadRequest) => Promise<void>;
  multiExecActive: boolean;
  multiExecSelectedTabIds: Set<string>;
  broadcastToSelectedTerminals: (data: string, sourceTabId?: string) => void;
  openDetachedTerminal: (tabId: string, tab: import("../../../types").Tab, title: string) => void;
  aiFullyDisabled: boolean;
  terminalRailMerged: boolean;
  chatDrawerOpen: boolean;
  toggleTabChat: (tabId: string) => Promise<void>;
  toggleTerminalSftp: (tab: import("../../../types").Tab) => void;
  terminalCwdsRef: import("react").RefObject<Record<string, string>>;
  queryTerminalCwd: (tabId: string) => Promise<string | null>;
  openGitRepository: (path?: string | null) => Promise<void>;
  terminalCwdVersions: Record<string, number>;
  toggleAttachedSidebar: (tabId: string) => void;
  requestTerminalCwd: (tabId: string) => boolean;
  pendingSftpUploadRequests: Record<string, import("../../../components/filebrowser/FileBrowser").SftpPendingUploadRequest>;
  setPendingSftpUploadRequests: import("react").Dispatch<import("react").SetStateAction<Record<string, import("../../../components/filebrowser/FileBrowser").SftpPendingUploadRequest>>>;
  setSftpDetachedTabs: import("react").Dispatch<import("react").SetStateAction<Record<string, boolean>>>;
  setAttachedSidebars: import("react").Dispatch<import("react").SetStateAction<Record<string, boolean>>>;
  openDetachedSftp: (params: import("../../../types").SftpTabInfo, title: string) => void;
  splitGridColumns: number;
  splitPaneWeightsForTabs: number[];
  setActiveTab: (id: string) => void;
  toggleTerminalSplitInputLock: (tabId: string) => void;
  startLinearSplitResize: (index: number, event: import("react").PointerEvent<HTMLDivElement>) => void;
  splitGridColumnWeightsForLayout: number[];
  startGridSplitResize: (axis: "column" | "row", index: number, event: import("react").PointerEvent<HTMLDivElement>) => void;
  splitGridRowWeightsForLayout: number[];
}

export function TerminalTabContents(inputs: TerminalTabContentsProps) {
  const {
    terminalSplitVisible,
    terminalSplitLayout,
    terminalSplitInputLockedTabIds,
    setTerminalSplitLayout,
    clearTerminalSplitInputLocks,
    toggleTerminalSplit,
    splitPanesRef,
    terminalPanesClass,
    splitGridColumnTemplate,
    splitGridRowTemplate,
    terminalTabs,
    activeTabId,
    attachedSidebars,
    terminalProfileOverrides,
    terminalProfilesBySessionId,
    sessions,
    terminalRuntimeByTab,
    terminalCwds,
    t,
    handleTerminalProfileChange,
    handleTerminalCwd,
    terminalCwdRequestTokens,
    terminalSessionIds,
    completeLocalLaunch,
    resolveResumeWaiterForTab,
    handleTerminalOutput,
    handleTerminalLocalPathUpload,
    multiExecActive,
    multiExecSelectedTabIds,
    broadcastToSelectedTerminals,
    openDetachedTerminal,
    aiFullyDisabled,
    terminalRailMerged,
    chatDrawerOpen,
    toggleTabChat,
    toggleTerminalSftp,
    terminalCwdsRef,
    queryTerminalCwd,
    openGitRepository,
    terminalCwdVersions,
    toggleAttachedSidebar,
    requestTerminalCwd,
    pendingSftpUploadRequests,
    setPendingSftpUploadRequests,
    setSftpDetachedTabs,
    setAttachedSidebars,
    openDetachedSftp,
    splitGridColumns,
    splitPaneWeightsForTabs,
    setActiveTab,
    toggleTerminalSplitInputLock,
    startLinearSplitResize,
    splitGridColumnWeightsForLayout,
    startGridSplitResize,
    splitGridRowWeightsForLayout,
  } = inputs;
  return (<div
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
              sftpToggle={!terminalSplitVisible && tab.ssh && sshBrowserMode(parseSessionOptions(tab.ssh.optionsJson).sshBrowser) !== "disabled" && !(terminalRailMerged && isActive) ? {
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
        const sftpSidebarNode = sidebarOpen && tab.ssh && sshBrowserMode(parseSessionOptions(tab.ssh.optionsJson).sshBrowser) !== "disabled" ? (
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
  </div>);
}
