import { Bot,FolderOpen } from "lucide-react";
import { useCallback,useEffect,useMemo,useRef,useState } from "react";
import { createPortal } from "react-dom";
import { Panel,Group as PanelGroup,Separator as PanelResizeHandle,type PanelImperativeHandle,type PanelSize } from "react-resizable-panels";
import { AboutDialog } from "../components/AboutDialog";
import { CcAgentBridge } from "../components/agent/CcAgentBridge";
import { ChatDrawer } from "../components/chat/ChatDrawer";
import { ToolWindowRail,type ToolWindowRailItem } from "../components/editor/workspace/panels/ToolWindowRail";
import { effectiveStripeWidth } from "../components/editor/workspace/toolWindowLayout";
import { useToolWindowStripeStore } from "../components/editor/workspace/toolWindowStripeStore";
import type { WorkspaceCommandRegistration } from "../components/editor/workspace/workspaceCommands";
import { type SftpPendingUploadRequest } from "../components/filebrowser/FileBrowser";
import { CallOverlay } from "../components/lanchat/CallOverlay";
import { EdgeDrawer } from "../components/lanchat/EdgeDrawer";
import { WhiteboardOverlay } from "../components/lanchat/whiteboard/WhiteboardOverlay";
import type { AppCommand } from "../components/menubar/commands";
import { useSessionImportExport } from "../components/menubar/useSessionImportExport";
import { FloatingNotesPanel } from "../components/notes/FloatingNotesPanel";
import { QuickConnect } from "../components/quickconnect/QuickConnect";
import { AuthPrompt } from "../components/session/AuthPrompt";
import { SessionEditor } from "../components/session/SessionEditor";
import { useConfirmDialog } from "../components/sidebar/ConfirmDialog";
import { Sidebar } from "../components/sidebar/Sidebar";
import { StatusBar } from "../components/statusbar/StatusBar";
import { ControlBar } from "../components/tabbar/ControlBar";
import { TabActionSlotProvider } from "../components/tabbar/TabActionSlot";
import { TaoAlertPoller } from "../components/tao/TaoAlertPoller";
import { TaoRibbon } from "../components/tao/TaoRibbon";
import { MultiExecBar } from "../components/terminal/MultiExecBar";
import { type TerminalLocalPathUploadRequest } from "../components/terminal/TerminalPanel";
import { UpdateDialog } from "../components/UpdateDialog";
import { VaultUnlockDialog } from "../components/vault/VaultUnlockDialog";
import { WindowResizeHandles } from "../components/window/WindowResizeHandles";
import { useViewportSize } from "../hooks/useViewportSize";
import { resolveChatDock } from "../lib/chat/chatDock";
import { t as tr,useT } from "../lib/i18n";
import { VAULT_LOCKED_EVENT,encodeBase64,writeTerminal,type SessionConfig } from "../lib/ipc";
import { type MenuActionId } from "../lib/nativeAppMenu";
import { getSessionNetworkSettings,toNetworkSettingsPayload } from "../lib/networkSettings";
import { setActiveQueryTab } from "../lib/queryRegistry";
import { loadResizableLayout,saveResizableLayout } from "../lib/resizableLayout";
import { getAppPlatform,isTauriRuntime } from "../lib/runtime";
import { effectiveFileType,openExternalUrl,sftpOpenPath,sftpStat } from "../lib/sftp";
import { setActiveTerminalTab } from "../lib/terminal/terminalRegistry";
import { terminalCwdTitlePrefix } from "../lib/terminalCwd";
import { loadTerminalDefaultProfile,type TerminalProfile } from "../lib/terminalProfile";
import { useAiStore } from "../stores/aiStore";
import { computeNewTerminalTitle,useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";
import { totalUnread,useLanChatStore } from "../stores/lanChatStore";
import { useMainRailHostStore } from "../stores/mainRailHostStore";
import { useServersStore } from "../stores/serversStore";
import { useSessionStore } from "../stores/sessionStore";
import { useSftpStore } from "../stores/sftpStore";
import { sidebarRailGroup } from "../stores/sidebarRailPolicy";
import { useUpdateStore } from "../stores/updateStore";
import { useVaultStore } from "../stores/vaultStore";
import type { LocalLaunchOutcome,LocalShellSelection,MailTabInfo,RecentWorkspace,Tab } from "../types";
import { SAVED_PASSWORD_VAULT_REASON_KEY,passwordRefFromOptions } from "./main/authentication";
import { createHandleCommand,createHandleQuickConnect } from "./main/commandActions";
import { createContinueConnectQueue,createHandleAuthSubmit,createOpenAfterJumpPassword,createOpenQueuedSession,createQueueVaultUnlock } from "./main/connectionQueue";
import { createHandleDetachActiveTab,createOpenDetachedDatabase,createOpenDetachedGenericWindow,createOpenDetachedRdp,createOpenDetachedSftp,createOpenDetachedTerminal,createOpenDetachedVnc } from "./main/detachedWindows";
import { mailSmtpPasswordRefFromOptions,sessionToMailTabInfo } from "./main/mailSession";
import { chatBindingIdForTab,localShellSupportsCwdProbe,readQuickConnectVisible,writeQuickConnectVisible } from "./main/sessionPolicy";
import { TabContentRouter } from "./main/TabContentRouter";
import { type ConnectQueueEntry,type ControlToolExecutor,type PendingAuth } from "./main/types";
import { useApplicationExit } from "./main/useApplicationExit";
import { useControlTools } from "./main/useControlTools";
import { useDetachedWindowEvents } from "./main/useDetachedWindowEvents";
import { useMainMenuBridge } from "./main/useMainMenuBridge";
import { useProtocolTabs } from "./main/useProtocolTabs";
import { useSessionResume } from "./main/useSessionResume";
import { useShellSessionTabs } from "./main/useShellSessionTabs";
import { useTerminalProfiles } from "./main/useTerminalProfiles";
import { useTerminalSplitLayout } from "./main/useTerminalSplitLayout";
import { useWorkspaceTabs } from "./main/useWorkspaceTabs";














export function MainLayout() {
  const t = useT();
  const {
    tabs,
    activeTabId,
    sidebarCollapsed,
    mergeToolWindowRail,
    xServerEnabled,
    refreshXServer,
    addTab,
    removeTab,
    duplicateTab,
    updateTabTitle,
    assignTerminalAutoTitle,
    updateGitTabInfo,
    setActiveTab,
    moveTabToIndex,
    toggleSidebar,
    setSidebarCollapsed,
    setActiveSideTab,
    toggleXServer,
    setStatusMessage,
    multiExecActive,
    multiExecSelectedTabIds,
    terminalSplitActive,
    terminalSplitLayout,
    terminalSplitInputLockedTabIds,
    terminalRuntimeByTab,
    welcomeRecentSessionLimit,
    recentWorkspaces,
    toggleMultiExec,
    selectAllTerminalTabs,
    clearMultiExecSelection,
    setTerminalSplitActive,
    toggleTerminalSplit,
    setTerminalSplitLayout,
    toggleTerminalSplitInputLock,
    clearTerminalSplitInputLocks,
    setTabHasNewOutput,
    removeRecentWorkspace,
    clearRecentWorkspaces,
  } = useAppStore();
  const { loadSessions, markConnected, sessions, updateSession, setSelectedSession, setSearchQuery } = useSessionStore();
  const activeTab = tabs.find((t) => t.id === activeTabId);
  // ED-PARITY-027 A: every tab group restores its own sidebar state (tool
  // window tabs start collapsed to the rail).
  const activeRailGroup = sidebarRailGroup(activeTab?.type);
  useEffect(() => {
    useAppStore.getState().applySidebarForActiveTab();
  }, [activeRailGroup, mergeToolWindowRail]);
  const { terminalProfileOverrides, terminalProfilesBySessionId, handleTerminalProfileChange } = useTerminalProfiles({
    sessions,
    tabs,
  });
  const welcomeRecentSessions = useMemo(
    () =>
      sessions
        .filter((session) => session.last_connected_at)
        .slice()
        .sort((a, b) => (b.last_connected_at ?? 0) - (a.last_connected_at ?? 0))
        .slice(0, welcomeRecentSessionLimit),
    [sessions, welcomeRecentSessionLimit],
  );
  const welcomeMailSessions = useMemo(
    () =>
      sessions
        .filter((session) => session.session_type === "Mail")
        .slice()
        .sort((a, b) => (a.name || a.host || "").localeCompare(b.name || b.host || "")),
    [sessions],
  );
  const tabsRef = useRef(tabs);
  const executeControlToolRef = useRef<ControlToolExecutor | null>(null);
  const seenControlToolCallsRef = useRef<Set<string>>(new Set());
  const sidebarPanelRef = useRef<PanelImperativeHandle>(null);
  const lastSidebarSizeRef = useRef(22);
  const [showSessionEditor, setShowSessionEditor] = useState(false);
  const [editingSession, setEditingSession] = useState<SessionConfig | undefined>();
  const [newSessionGroupPath, setNewSessionGroupPath] = useState<string | null>(null);
  const [newSessionInitialProto, setNewSessionInitialProto] = useState<string | undefined>();
  const [pendingAuth, setPendingAuth] = useState<PendingAuth | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const [attachedSidebars, setAttachedSidebars] = useState<Record<string, boolean>>({});
  const [sftpDetachedTabs, setSftpDetachedTabs] = useState<Record<string, boolean>>({});
  const [pendingSftpUploadRequests, setPendingSftpUploadRequests] = useState<Record<string, SftpPendingUploadRequest>>({});
  const [quickConnectVisible, setQuickConnectVisible] = useState(readQuickConnectVisible);
  // The active tab's contextual action toolbar (Capture / Detach / Maximize …)
  // portals into this slot, which lives inside the ControlBar.
  const [tabActionSlot, setTabActionSlot] = useState<HTMLDivElement | null>(null);
  const [workspaceCommandRegistrations, setWorkspaceCommandRegistrations] = useState<Record<string, WorkspaceCommandRegistration>>({});
  const workspaceCommandRegistrationsRef = useRef<Record<string, WorkspaceCommandRegistration>>({});
  const handleWorkspaceCommandsChange = useCallback((tabId: string, registration: WorkspaceCommandRegistration | null) => {
    if (registration) {
      workspaceCommandRegistrationsRef.current = {
        ...workspaceCommandRegistrationsRef.current,
        [tabId]: registration,
      };
    } else if (tabId in workspaceCommandRegistrationsRef.current) {
      const next = { ...workspaceCommandRegistrationsRef.current };
      delete next[tabId];
      workspaceCommandRegistrationsRef.current = next;
    }
    setWorkspaceCommandRegistrations((current) => {
      if (registration) return current[tabId] === registration ? current : { ...current, [tabId]: registration };
      if (!(tabId in current)) return current;
      const next = { ...current };
      delete next[tabId];
      return next;
    });
  }, []);
  const activeWorkspaceCommandRegistration = activeTabId
    ? workspaceCommandRegistrations[activeTabId] ?? null
    : null;
  // On macOS we render a native global menu bar instead of the in-app app menu.
  // The native menu lives at the top of the screen, matching standard macOS
  // apps; the in-bar menu button is hidden there.
  const nativeMenu = isTauriRuntime() && getAppPlatform() === "macos";
  const importExport = useSessionImportExport();
  const exitRequestInFlightRef = useRef(false);
  const { confirm: confirmAppExit, render: appExitConfirmDialog } = useConfirmDialog();
  const [terminalCwds, setTerminalCwds] = useState<Record<string, string>>({});
  const [terminalCwdVersions, setTerminalCwdVersions] = useState<Record<string, number>>({});
  const [terminalCwdRequestTokens, setTerminalCwdRequestTokens] = useState<Record<string, number>>({});
  const [vaultUnlockReason, setVaultUnlockReason] = useState<string | null>(null);
  const pendingVaultActionRef = useRef<(() => void) | null>(null);
  const connectQueueRef = useRef<ConnectQueueEntry[]>([]);
  const connectQueueRunningRef = useRef(false);
  /// Pending Welcome local-terminal launches keyed by tab id (design §4.1.5).
  const pendingLocalLaunchesRef = useRef<Map<string, (outcome: LocalLaunchOutcome) => void>>(new Map());
  const awaitingManualAuthRef = useRef(false);
  const awaitingVaultUnlockRef = useRef(false);
  const continueConnectQueueRef = useRef<() => void>(() => undefined);
  const refreshVault = useVaultStore((s) => s.refresh);
  const unlockVault = useVaultStore((s) => s.unlock);
  const aiFullyDisabled = useAiStore((s) => s.config?.fully_disabled === true);
  const mainRailHost = useMainRailHostStore((s) => s.host);
  const stripeSettings = useToolWindowStripeStore((s) => s.settings);
  const toggleStripeNames = useToolWindowStripeStore((s) => s.toggleShowNames);
  const toggleTabChat = useChatStore((s) => s.toggleTabChat);
  const syncTabChatWithActiveTab = useChatStore((s) => s.syncTabChatWithActiveTab);
  const chatDrawerOpen = useChatStore((s) => s.drawerOpen);
  const chatDrawerPosition = useChatStore((s) => s.drawerPosition);
  const chatDrawerPinned = useChatStore((s) => s.drawerPinned);

  // Pull initial vault status so dialogs that consult it (SessionEditor,
  // TunnelEditor, AuthPrompt) render against fresh state.
  useEffect(() => {
    void refreshVault().catch(() => undefined);
  }, [refreshVault]);

  // Auto-update: silently check shortly after launch and then every 6 hours.
  // Checks are non-intrusive — they only flip the store to "available" so the
  // title-bar indicator lights up; the update window opens when the user clicks
  // it (or "Check for updates" in About), never on its own. No-op outside the
  // desktop app.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const runCheck = () => {
      const st = useUpdateStore.getState();
      // Don't disturb the user mid-flow: skip while the window is open or a
      // check/download/staged-install is in progress.
      if (st.dialogOpen) return;
      if (["checking", "downloading", "installing", "authorizing", "ready"].includes(st.status)) return;
      void st.check();
    };
    const initial = window.setTimeout(runCheck, 4000);
    const interval = window.setInterval(runCheck, 6 * 60 * 60 * 1000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, []);

  // Listen for VAULT_LOCKED events emitted by ipc helpers (e.g. when an
  // SSH connect tries to resolve a vault: reference while the vault is
  // locked). Surface the unlock dialog so the user can resolve it without
  // hunting through settings.
  useEffect(() => {
    const handler = (evt: Event) => {
      const detail = (evt as CustomEvent<{ reason?: string }>).detail;
      const reason =
        detail?.reason ??
        tr(SAVED_PASSWORD_VAULT_REASON_KEY);
      setVaultUnlockReason((prev) => prev ?? reason);
    };
    window.addEventListener(VAULT_LOCKED_EVENT, handler);
    return () => window.removeEventListener(VAULT_LOCKED_EVENT, handler);
  }, []);
  // Maps tab.id → backend terminal session ID (set once the SSH/local session connects).
  const terminalSessionIds = useRef<Record<string, string>>({});
  // Latest known cwd per tab, mirrored from terminalCwds so handleDuplicateTab
  // can read it synchronously without taking terminalCwds as a dependency
  // (which changes on every prompt once shell integration is active).
  const terminalCwdsRef = useRef<Record<string, string>>({});
  // Pending one-shot resolvers waiting on the next cwd report for a tab. Used
  // by queryTerminalCwd to turn the fire-and-forget OSC 7 round trip into an
  // awaitable promise (e.g. when duplicating a terminal tab).
  const cwdQueryResolversRef = useRef<Record<string, Array<(cwd: string | null) => void>>>({});
  const sftpUploadRequestSeqRef = useRef(0);

  const toggleAttachedSidebar = useCallback((tabId: string) => {
    setAttachedSidebars((prev) => ({ ...prev, [tabId]: !prev[tabId] }));
  }, []);

  const prevTabIdsRef = useRef<string[]>([]);
  useEffect(() => {
    const currentIds = tabs.filter((t) => t.type === "terminal").map((t) => t.id);
    const prevIds = prevTabIdsRef.current;

    // Find closed tabs
    const closedIds = prevIds.filter((id) => !currentIds.includes(id));
    if (closedIds.length > 0) {
      const store = useSftpStore.getState();
      for (const closedId of closedIds) {
        const sftpSessionId = `attached-${closedId}`;
        const detachedSessionId = `attached-${closedId}__detached`;
        void store.detach(sftpSessionId);
        void store.detach(detachedSessionId);
      }
      setSftpDetachedTabs((prev) => {
        const next = { ...prev };
        for (const closedId of closedIds) {
          delete next[closedId];
        }
        return next;
      });
      setPendingSftpUploadRequests((prev) => {
        const next = { ...prev };
        for (const closedId of closedIds) {
          delete next[`attached-${closedId}`];
          delete next[`attached-${closedId}__detached`];
        }
        return next;
      });
    }

    prevTabIdsRef.current = currentIds;
  }, [tabs]);

  const handleTerminalCwd = useCallback((tabId: string, cwd: string) => {
    terminalCwdsRef.current[tabId] = cwd;
    setTerminalCwds((prev) => (prev[tabId] === cwd ? prev : { ...prev, [tabId]: cwd }));
    setTerminalCwdVersions((prev) => ({ ...prev, [tabId]: (prev[tabId] ?? 0) + 1 }));
    // Mirror into the app store so the AI chat store can read the bound tab's
    // live cwd when sending a turn to Claude Code (Phase 3.3).
    useAppStore.getState().setTabCwd(tabId, cwd);
    assignTerminalAutoTitle(tabId, cwd);
    // Hand the freshly reported cwd to anyone awaiting it (e.g. a pending tab
    // duplication) before broadcasting to other windows.
    const resolvers = cwdQueryResolversRef.current[tabId];
    if (resolvers && resolvers.length > 0) {
      cwdQueryResolversRef.current[tabId] = [];
      for (const resolve of resolvers) resolve(cwd);
    }
    // Mirror the new cwd to any same-origin window (e.g. a detached SFTP
    // popup) so it can offer the same last-known terminal cwd for explicit
    // sync even though only the main window hosts the terminal. We publish
    // under both the raw tab
    // id AND the `attached-${tabId}` key, because a detached window that
    // was split off from an attached SSH sidebar uses the prefixed id as
    // its SFTP session id and would otherwise never see these updates.
    void import("../lib/sftpSync").then(({ broadcastCwdHint }) => {
      broadcastCwdHint(tabId, cwd);
      broadcastCwdHint(`attached-${tabId}`, cwd);
    });
  }, [assignTerminalAutoTitle]);

  // Ask a terminal tab for its current working directory and resolve once the
  // shell reports back via OSC 7. Resolves null if the terminal isn't ready or
  // the reply doesn't arrive in time (so callers can fall back gracefully).
  const queryTerminalCwd = useCallback((tabId: string): Promise<string | null> => {
    return new Promise((resolve) => {
      if (!terminalSessionIds.current[tabId]) {
        resolve(null);
        return;
      }
      const list = cwdQueryResolversRef.current[tabId] ?? [];
      list.push(resolve);
      cwdQueryResolversRef.current[tabId] = list;
      setTerminalCwdRequestTokens((prev) => ({ ...prev, [tabId]: (prev[tabId] ?? 0) + 1 }));
      window.setTimeout(() => {
        const pending = cwdQueryResolversRef.current[tabId];
        if (pending && pending.includes(resolve)) {
          cwdQueryResolversRef.current[tabId] = pending.filter((r) => r !== resolve);
          resolve(null);
        }
      }, 1200);
    });
  }, []);

  const duplicateTerminalProfileFor = useCallback((source: Tab): TerminalProfile | undefined => {
    if (source.type !== "terminal") return undefined;
    const liveProfile = terminalProfileOverrides[source.id]
      ?? (source.sessionId ? terminalProfilesBySessionId.get(source.sessionId) : undefined)
      ?? source.terminalProfile;
    return liveProfile ?? loadTerminalDefaultProfile();
  }, [terminalProfileOverrides, terminalProfilesBySessionId]);

  // Duplicate a tab. Terminal tabs try to open the copy in the source's current
  // directory. Shell integration makes shells report their cwd via OSC 7 on
  // every prompt, so we read the last-known cwd (terminalCwdsRef) with no
  // injection — nothing to echo, and a half-typed line in the source is never
  // touched. Only when no cwd was ever reported (integration absent, e.g.
  // cmd/zsh/custom local shells) do we fall back to a one-shot probe, and only
  // for local shells: the probe is skipped if a command is typed, and SSH never
  // probes its source (a duplicate with no known cwd just opens in the remote
  // default directory).
  const handleDuplicateTab = useCallback(
    async (tabId: string) => {
      const source = useAppStore.getState().tabs.find((t) => t.id === tabId);
      if (!source) return;
      let initialCwd: string | undefined;
      if (source.type === "terminal" && !source.adoptedTerminal) {
        const tracked = terminalCwdsRef.current[tabId];
        if (tracked) {
          initialCwd = tracked;
        } else if (!source.ssh && !source.commandTerminal && localShellSupportsCwdProbe(source.localShell)) {
          const cwd = await queryTerminalCwd(tabId);
          initialCwd = cwd ?? undefined;
        }
      }
      const terminalProfile = duplicateTerminalProfileFor(source);
      const terminalTitlePrefix = initialCwd ? terminalCwdTitlePrefix(initialCwd) ?? undefined : undefined;
      duplicateTab(tabId, {
        ...(initialCwd ? { terminalInitialCwd: initialCwd } : {}),
        ...(terminalProfile ? { terminalProfile } : {}),
        ...(terminalTitlePrefix ? { terminalTitlePrefix } : {}),
      });
    },
    [duplicateTab, duplicateTerminalProfileFor, queryTerminalCwd],
  );

  const requestTerminalCwd = useCallback((tabId: string): boolean => {
    if (!terminalSessionIds.current[tabId]) {
      setStatusMessage(tr("status.terminalNotReady"));
      return false;
    }
    setTerminalCwdRequestTokens((prev) => ({ ...prev, [tabId]: (prev[tabId] ?? 0) + 1 }));
    return true;
  }, [setStatusMessage]);

  const handleTerminalLocalPathUpload = useCallback(
    async (tabId: string, request: TerminalLocalPathUploadRequest): Promise<void> => {
      if (request.paths.length === 0) return;
      const remoteDir = request.cwd ?? terminalCwdsRef.current[tabId] ?? null;
      if (!remoteDir) {
        throw new Error(tr("status.terminalCwdUnknown"));
      }

      const sftpSessionId = `attached-${tabId}`;
      const id = ++sftpUploadRequestSeqRef.current;
      setTerminalSplitActive(false);
      setSftpDetachedTabs((prev) => ({ ...prev, [tabId]: false }));
      setAttachedSidebars((prev) => ({ ...prev, [tabId]: true }));
      setPendingSftpUploadRequests((prev) => ({
        ...prev,
        [sftpSessionId]: {
          id,
          paths: request.paths,
          remoteDir,
        },
      }));
    },
    [setTerminalSplitActive, tr],
  );

  const broadcastToSelectedTerminals = useCallback((data: string, sourceTabId?: string) => {
    const {
      multiExecSelectedTabIds: selectedIds,
      terminalSplitActive: splitActive,
      terminalSplitInputLockedTabIds: lockedIds,
    } = useAppStore.getState();
    for (const tabId of selectedIds) {
      if (tabId === sourceTabId) continue; // skip the source terminal — it handles its own input
      if (splitActive && lockedIds.has(tabId)) continue;
      const sessionId = terminalSessionIds.current[tabId];
      if (sessionId) {
        writeTerminal(sessionId, encodeBase64(data)).catch(console.error);
      }
    }
  }, []);

  const handleTerminalOutput = useCallback((tabId: string) => {
    if (tabId === useAppStore.getState().activeTabId) return;
    setTabHasNewOutput(tabId, true);
  }, [setTabHasNewOutput]);

  const openDetachedSftp = useCallback(createOpenDetachedSftp({
    setStatusMessage,
  }), [setStatusMessage]);

  /**
   * Hand off the credentials of a non-SFTP tab to a new OS window and
   * remove the source tab from this window. The new window opens its own
   * backend session of the same kind. Reattach reverses the move via the
   * `BroadcastChannel('taomni.detach.sync')` subscriber wired below.
   */
  const openDetachedGenericWindow = useCallback(
    createOpenDetachedGenericWindow({
    removeTab,
    setStatusMessage,
  }),
    [removeTab, setStatusMessage],
  );

  const openDetachedRdp = useCallback(
    createOpenDetachedRdp({
    openDetachedGenericWindow,
  }),
    [openDetachedGenericWindow],
  );

  const openDetachedVnc = useCallback(
    createOpenDetachedVnc({
    openDetachedGenericWindow,
    setStatusMessage,
  }),
    [openDetachedGenericWindow, setStatusMessage],
  );

  const openDetachedTerminal = useCallback(
    createOpenDetachedTerminal({
    terminalSessionIds,
    terminalProfileOverrides,
    terminalProfilesBySessionId,
    openDetachedGenericWindow,
  }),
    [openDetachedGenericWindow, terminalProfileOverrides, terminalProfilesBySessionId],
  );

  const openDetachedDatabase = useCallback(
    createOpenDetachedDatabase({
    openDetachedGenericWindow,
  }),
    [openDetachedGenericWindow],
  );

  const handleDetachActiveTab = useCallback(createHandleDetachActiveTab({
    openDetachedTerminal,
    openDetachedRdp,
    openDetachedVnc,
    openDetachedDatabase,
    openDetachedSftp,
  }), [openDetachedDatabase, openDetachedRdp, openDetachedSftp, openDetachedTerminal, openDetachedVnc]);
  useDetachedWindowEvents({
    tabsRef,
    setActiveTab,
    addTab,
    setStatusMessage,
  });

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  // Probe the local X server once at startup so the status pill reflects
  // reality (Xorg/XQuartz/VcXsrv/WSLg reachable or not) instead of a guess.
  useEffect(() => {
    void refreshXServer();
  }, [refreshXServer]);

  useEffect(() => {
    if (activeTabId) setTabHasNewOutput(activeTabId, false);
  }, [activeTabId, setTabHasNewOutput]);

  // Track which tab the AI Chat Drawer should consider "active" when the user
  // types `@terminal:last-N` or sends generated SQL back to a query tab.
  // `setActiveTerminalTab` is terminal-only (that registry pulls xterm
  // buffers), but a tab-bound chat drawer can belong to any tab kind that
  // exposes a chat toggle (terminal + rdp + database), so the drawer-sync gets the
  // active tab id for those kinds and survives tab switches.
  useEffect(() => {
    const terminalTabId = activeTab?.type === "terminal" ? activeTabId : null;
    setActiveTerminalTab(terminalTabId);
    setActiveQueryTab(activeTab?.type === "database" ? activeTabId : null);
    const chatBoundTabId = chatBindingIdForTab(activeTab);
    void syncTabChatWithActiveTab(chatBoundTabId);
  }, [activeTab, activeTabId, syncTabChatWithActiveTab]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    const panel = sidebarPanelRef.current;
    if (!panel) return;

    const frame = requestAnimationFrame(() => {
      if (sidebarCollapsed) {
        panel.collapse();
      } else {
        panel.resize(`${lastSidebarSizeRef.current}%`);
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [sidebarCollapsed]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        useServersStore.getState().openDialog(tr("servers.dialogTitle"));
        return;
      }
      const primary = event.ctrlKey || event.metaKey;
      if (!primary || event.altKey || event.key.toLowerCase() !== "l") return;

      if (event.shiftKey) {
        event.preventDefault();
        const aiOff = useAiStore.getState().config?.fully_disabled === true;
        const current = useAppStore.getState().tabs.find((tab) => tab.id === useAppStore.getState().activeTabId);
        const chatTabId = chatBindingIdForTab(current);
        if (!aiOff && chatTabId) {
          void toggleTabChat(chatTabId);
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleTabChat]);

  // Hydrate server configs + statuses once on mount so the servers dialog
  // opens with persisted settings and live run state.
  useEffect(() => {
    void useServersStore.getState().loadAll();
  }, []);
  const { requestAppExit } = useApplicationExit({
    tabsRef,
    confirmAppExit,
    exitRequestInFlightRef,
  });

  const handleNewSession = useCallback((groupPath: string | null = null) => {
    setEditingSession(undefined);
    setNewSessionGroupPath(groupPath);
    setNewSessionInitialProto(undefined);
    setShowSessionEditor(true);
  }, []);

  const handleNewSftpSession = useCallback(() => {
    setEditingSession(undefined);
    setNewSessionGroupPath(null);
    setNewSessionInitialProto("SFTP");
    setShowSessionEditor(true);
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
    addTab({
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
    if (sessionId) void markConnected(sessionId);
    // Structured launch outcome (design §4.1.5): resolved by the terminal's
    // onSessionReady / onSessionLaunchFailed callbacks, or cancelled when the
    // pending tab closes before either fires.
    return new Promise<LocalLaunchOutcome>((resolve) => {
      pendingLocalLaunchesRef.current.set(id, resolve);
    });
  }, [addTab, markConnected]);

  /** Resolve the structured local-launch request for `tabId` if still pending. */
  const completeLocalLaunch = useCallback((tabId: string, outcome: LocalLaunchOutcome) => {
    const resolve = pendingLocalLaunchesRef.current.get(tabId);
    if (resolve) {
      pendingLocalLaunchesRef.current.delete(tabId);
      resolve(outcome);
    }
  }, []);

  // Close-before-ready: a pending launch whose tab disappears completes as
  // cancelled so Welcome's per-directory pending state never leaks.
  useEffect(() => {
    if (pendingLocalLaunchesRef.current.size === 0) return;
    const liveIds = new Set(tabs.map((tab) => tab.id));
    for (const [tabId, resolve] of Array.from(pendingLocalLaunchesRef.current.entries())) {
      if (!liveIds.has(tabId)) {
        pendingLocalLaunchesRef.current.delete(tabId);
        resolve({ tabId, status: "cancelled" });
      }
    }
  }, [tabs]);

  const handleEditSession = useCallback((session: SessionConfig) => {
    setEditingSession(session);
    setNewSessionGroupPath(null);
    setShowSessionEditor(true);
  }, []);

  const handleEditSessionById = useCallback((sessionId: string) => {
    const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId);
    if (session) handleEditSession(session);
  }, [handleEditSession]);
  const { openFileBrowserTab, openSftpTab, openVncTab, openRdpTab, openDbTab, openHBaseShellTab, openProxyTestTab, openObjectStorageTab, openMailTab, persistVncProperties, rememberVncCredentials } = useProtocolTabs({
    addTab,
    markConnected,
    updateSession,
    setStatusMessage,
    tabsRef,
    setActiveTab,
  });

  // Open a local path or URL: http(s) URLs and files always go to the system handler;
  // folders open in an embedded Taomni tab when `embedFolder` is true, otherwise
  // they fall through to the OS file manager via sftpOpenPath.
  const handleOpenLocalPath = useCallback(async (
    target: string,
    opts: { embedFolder?: boolean; title?: string; sessionId?: string } = {},
  ) => {
    const trimmed = target.trim();
    if (!trimmed) return;
    const isUrl = /^https?:\/\//i.test(trimmed);
    if (isUrl) {
      try {
        await openExternalUrl(trimmed);
      } catch (err) {
        setStatusMessage(tr("status.openFailed", {
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
      setStatusMessage(tr("status.statFailed", {
        error: err instanceof Error ? err.message : String(err),
      }));
      return;
    }
    if (isDir && opts.embedFolder) {
      openFileBrowserTab(opts.title ?? trimmed, trimmed, opts.sessionId);
      return;
    }
    try {
      await sftpOpenPath(trimmed);
    } catch (err) {
      setStatusMessage(tr("status.openFailed", {
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [openFileBrowserTab, setStatusMessage]);

  const openFileSession = useCallback((session: SessionConfig) => {
    const target = session.host?.trim();
    if (!target) {
      setStatusMessage(tr("status.fileSessionMissing"));
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
    void markConnected(session.id);
  }, [handleOpenLocalPath, markConnected, setStatusMessage]);

  const revealRecentCodeWorkspace = useCallback((workspace: RecentWorkspace) => {
    const target = workspace.roots[0]?.path ?? workspace.looseFiles[0]?.path;
    if (!target) return;
    void handleOpenLocalPath(target, { embedFolder: false });
  }, [handleOpenLocalPath]);
  const { openGitRepository, openEmptyCodeWorkspaceTab, openRecentCodeWorkspace, openNewCodeWorkspaceFromWelcome, openCodeWorkspaceTab, openWorkspaceGitManager, syncWorkspaceGitManager } = useWorkspaceTabs({
    tabsRef,
    setActiveTab,
    addTab,
    updateGitTabInfo,
    removeTab,
    tabs,
    setStatusMessage,
  });
  const { openSshTab, openBrowserSession, openCommandTerminalTab, openUnsupportedTab } = useShellSessionTabs({
    setStatusMessage,
    markConnected,
    addTab,
  });

  const queueVaultUnlock = useCallback(createQueueVaultUnlock({
    connectQueueRef,
    awaitingVaultUnlockRef,
    pendingVaultActionRef,
    continueConnectQueueRef,
    setVaultUnlockReason,
  }), []);

  const openAfterJumpPassword = useCallback(createOpenAfterJumpPassword({
    sessions,
    awaitingManualAuthRef,
    setPendingAuth,
  }), [sessions]);

  const openQueuedSession = useCallback(createOpenQueuedSession({
    queueVaultUnlock,
    openAfterJumpPassword,
    openSshTab,
    awaitingManualAuthRef,
    setPendingAuth,
    openSftpTab,
    openLocalTab,
    openVncTab,
    openRdpTab,
    openFileSession,
    openBrowserSession,
    openCommandTerminalTab,
    openDbTab,
    openHBaseShellTab,
    openProxyTestTab,
    openObjectStorageTab,
    tabsRef,
    setActiveTab,
    openMailTab,
    openUnsupportedTab,
    markConnected,
  }), [
    markConnected,
    openBrowserSession,
    openCommandTerminalTab,
    openFileSession,
    openLocalTab,
    openSftpTab,
    openSshTab,
    openUnsupportedTab,
    openVncTab,
    openRdpTab,
    openDbTab,
    openHBaseShellTab,
    openProxyTestTab,
    openObjectStorageTab,
    openMailTab,
    queueVaultUnlock,
    openAfterJumpPassword,
    setActiveTab,
  ]);

  const continueConnectQueue = useCallback(createContinueConnectQueue({
    connectQueueRunningRef,
    awaitingManualAuthRef,
    awaitingVaultUnlockRef,
    connectQueueRef,
    openQueuedSession,
  }), [openQueuedSession]);

  useEffect(() => {
    continueConnectQueueRef.current = continueConnectQueue;
  }, [continueConnectQueue]);
  const { welcomeRestore, resolveResumeWaiterForTab, cancelResumeWaiter, cancelAllResumeWaiters } = useSessionResume({
    tabs,
    removeTab,
    openQueuedSession,
    openLocalTab,
    setPendingAuth,
    awaitingManualAuthRef,
    continueConnectQueueRef,
    setActiveTab,
    activeTab,
    terminalCwds,
    activeTabId,
    setStatusMessage,
  });

  const handleConnectSession = useCallback((session: SessionConfig) => {
    connectQueueRef.current.push({ session });
    continueConnectQueue();
  }, [continueConnectQueue]);

  const handleConnectSessions = useCallback((targets: SessionConfig[]) => {
    const seen = new Set<string>();
    const unique = targets.filter((session) => {
      if (seen.has(session.id)) return false;
      seen.add(session.id);
      return true;
    });
    if (unique.length === 0) return;
    connectQueueRef.current.push(...unique.map((session) => ({ session })));
    continueConnectQueue();
  }, [continueConnectQueue]);

  const handleRevealRecentSession = useCallback((session: SessionConfig) => {
    setActiveSideTab("sessions");
    setSidebarCollapsed(false);
    setSelectedSession(session.id);
    setSearchQuery("");
    setStatusMessage(tr("status.revealedSession", { name: session.name || session.host || session.session_type }));
  }, [setActiveSideTab, setSearchQuery, setSelectedSession, setSidebarCollapsed, setStatusMessage, tr]);

  const handleAuthSubmit = useCallback(createHandleAuthSubmit({
    pendingAuth,
    updateSession,
    setPendingAuth,
    awaitingManualAuthRef,
    continueConnectQueueRef,
    openAfterJumpPassword,
    openSftpTab,
    openVncTab,
    openRdpTab,
    openSshTab,
  }), [pendingAuth, openAfterJumpPassword, openSftpTab, openSshTab, openVncTab, openRdpTab, updateSession]);

  const handleQuickConnect = useCallback(createHandleQuickConnect({
    openLocalTab,
    openBrowserSession,
    openMailTab,
    openCommandTerminalTab,
    openVncTab,
    awaitingManualAuthRef,
    setPendingAuth,
    openSftpTab,
    openRdpTab,
    openSshTab,
    openUnsupportedTab,
    setStatusMessage,
  }), [openBrowserSession, openCommandTerminalTab, openLocalTab, openMailTab, openRdpTab, openSftpTab, openSshTab, openVncTab, openUnsupportedTab, setStatusMessage]);

  const openPlaceholderTab = useCallback((title: string, message: string) => {
    addTab({
      id: `placeholder-${Date.now()}`,
      type: "placeholder",
      title,
      closable: true,
      message,
    });
  }, [addTab]);

  const openSettingsTab = useCallback(() => {
    const existing = tabsRef.current.find((tab) => tab.type === "settings");
    if (existing) {
      setActiveTab(existing.id);
      return;
    }

    addTab({
      id: "settings",
      type: "settings",
      title: t("tabs.settings"),
      closable: true,
    });
  }, [addTab, setActiveTab]);

  useEffect(() => {
    const onOpenSettingsSection = () => {
      openSettingsTab();
    };
    window.addEventListener("taomni:open-settings-section", onOpenSettingsSection);
    return () => window.removeEventListener("taomni:open-settings-section", onOpenSettingsSection);
  }, [openSettingsTab]);
  useControlTools({
    tabsRef,
    loadSessions,
    openQueuedSession,
    setEditingSession,
    setNewSessionGroupPath,
    setNewSessionInitialProto,
    setShowSessionEditor,
    handleQuickConnect,
    setActiveTab,
    handleDuplicateTab,
    updateTabTitle,
    removeTab,
    moveTabToIndex,
    openSettingsTab,
    openLocalTab,
    openFileBrowserTab,
    executeControlToolRef,
    seenControlToolCallsRef,
  });

  const openLanChatTab = useCallback(() => {
    // If LanChat is currently docked as an edge drawer, undock it; the
    // edgeDock effect below restores and focuses the tab.
    if (useLanChatStore.getState().edgeDock) {
      useLanChatStore.getState().closeEdgeDock();
      return;
    }
    const existing = tabsRef.current.find((tab) => tab.type === "lan-chat");
    if (existing) {
      setActiveTab(existing.id);
      return;
    }
    addTab({
      id: "lan-chat",
      type: "lan-chat",
      title: t("tabs.lanChat"),
      closable: true,
    });
  }, [addTab, setActiveTab]);

  /** MFA authenticator: one tab per window (docs-feature/mfa-authenticator-design.md). */
  const openMfaTab = useCallback(() => {
    const existing = tabsRef.current.find((tab) => tab.type === "mfa");
    if (existing) {
      setActiveTab(existing.id);
      return;
    }
    addTab({
      id: "mfa",
      type: "mfa",
      title: t("tabs.mfa"),
      closable: true,
    });
  }, [addTab, setActiveTab]);

  /** Unified mail across every saved mail account (TASK-16, DEC-12). */
  const openUnifiedMailTab = useCallback(() => {
    const existing = tabsRef.current.find((tab) => tab.type === "mail-unified");
    if (existing) {
      setActiveTab(existing.id);
      return;
    }
    addTab({
      id: "mail-unified",
      type: "mail-unified",
      title: t("tabs.mailUnified"),
      closable: true,
    });
  }, [addTab, setActiveTab]);

  // Saved mail sessions plus every open mail tab (quick-connect accounts are
  // not saved); an open tab's info wins because it carries its credentials.
  const unifiedMailAccounts = useMemo(() => {
    const byId = new Map<string, MailTabInfo>();
    for (const session of sessions) {
      if (session.session_type !== "Mail") continue;
      byId.set(session.id, sessionToMailTabInfo(
        session,
        passwordRefFromOptions(session) ?? undefined,
        mailSmtpPasswordRefFromOptions(session) ?? undefined,
      ));
    }
    for (const tab of tabs) {
      if (tab.type === "mail" && tab.mail) byId.set(tab.mail.sessionId, tab.mail);
    }
    return [...byId.values()];
  }, [sessions, tabs]);

  const openMailAccountById = useCallback((sessionId: string) => {
    const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId);
    if (session) openQueuedSession(session);
  }, [openQueuedSession]);

  // Initialize LanChat at app startup (not only when the tab opens) so roster,
  // unread, and desktop notifications work even while the tab is closed.
  useEffect(() => {
    void useLanChatStore.getState().init();
  }, []);

  // Keep the lan-chat tab and the in-app edge drawer mutually exclusive.
  // Docking (null → side) hides the main-window tab; undocking (side → null,
  // via the drawer close button or Esc) restores and focuses it. Chat state
  // survives because the store stays alive regardless of the tab's presence.
  const edgeDock = useLanChatStore((s) => s.edgeDock);
  const prevEdgeDock = useRef(edgeDock);
  useEffect(() => {
    const prev = prevEdgeDock.current;
    prevEdgeDock.current = edgeDock;
    if (prev === null && edgeDock !== null) {
      removeTab("lan-chat");
    } else if (prev !== null && edgeDock === null) {
      if (!tabsRef.current.some((tab) => tab.id === "lan-chat")) {
        addTab({
          id: "lan-chat",
          type: "lan-chat",
          title: tr("tabs.lanChat"),
          closable: true,
        });
      }
      setActiveTab("lan-chat");
    }
  }, [edgeDock, addTab, removeTab, setActiveTab]);

  // Mirror total LanChat unread onto the lan-chat tab's new-output indicator
  // (cleared while that tab is active).
  const lanUnread = useLanChatStore((s) => totalUnread(s.conversations));
  useEffect(() => {
    const hasUnread = lanUnread > 0 && activeTabId !== "lan-chat";
    setTabHasNewOutput("lan-chat", hasUnread);
  }, [lanUnread, activeTabId, setTabHasNewOutput]);

  const toggleQuickConnectVisible = useCallback(() => {
    const next = !quickConnectVisible;
    setQuickConnectVisible(next);
    writeQuickConnectVisible(next);
    setStatusMessage(tr(next ? "status.quickConnectShown" : "status.quickConnectHidden"));
  }, [quickConnectVisible, setStatusMessage]);

  const handleCommand = useCallback(createHandleCommand({
    handleNewSession,
    handleNewSftpSession,
    openLocalTab,
    activeTab,
    removeTab,
    loadSessions,
    setStatusMessage,
    toggleXServer,
    toggleSidebar,
    toggleQuickConnectVisible,
    setSidebarCollapsed,
    toggleTerminalSplit,
    toggleMultiExec,
    requestAppExit,
    tabsRef,
    setActiveTab,
    addTab,
    t,
    openPlaceholderTab,
    openGitRepository,
    openEmptyCodeWorkspaceTab,
    openSettingsTab,
    openLanChatTab,
    openUnifiedMailTab,
    openMfaTab,
    setShowAbout,
  }), [
    activeTab,
    handleNewSession,
    handleNewSftpSession,
    loadSessions,
    openLocalTab,
    openGitRepository,
    openEmptyCodeWorkspaceTab,
    openPlaceholderTab,
    openSettingsTab,
    openLanChatTab,
    openMfaTab,
    removeTab,
    requestAppExit,
    setActiveTab,
    setStatusMessage,
    setSidebarCollapsed,
    toggleQuickConnectVisible,
    toggleTerminalSplit,
    toggleSidebar,
    toggleXServer,
  ]);

  // Route a native-menu activation to the right place: session import/export
  // is handled by the shared hook, everything else reuses handleCommand.
  const dispatchMenuAction = useCallback((action: MenuActionId) => {
    if (action.startsWith("workspace-command:")) {
      activeWorkspaceCommandRegistration?.executeAction(action.slice("workspace-command:".length));
      return;
    }
    switch (action) {
      case "import-json": importExport.importJson(); break;
      case "import-moba": importExport.importMoba(); break;
      case "import-csv": importExport.importCsv(); break;
      case "download-csv-template": importExport.downloadCsvTemplate(); break;
      case "import-openssh": importExport.importOpenSsh(); break;
      case "export-json": importExport.exportJson(); break;
      case "export-moba": importExport.exportMoba(); break;
      case "export-csv": importExport.exportCsv(); break;
      case "export-html": importExport.exportHtml(); break;
      default:
        handleCommand(action as AppCommand);
    }
  }, [activeWorkspaceCommandRegistration, handleCommand, importExport]);
  useMainMenuBridge({
    dispatchMenuAction,
    nativeMenu,
    activeTab,
    importExport,
    quickConnectVisible,
    activeWorkspaceCommandRegistration,
    t,
    setActiveTab,
    workspaceCommandRegistrationsRef,
    handleCommand,
  });

  const terminalTabs = tabs.filter((t) => t.type === "terminal");
  const sftpTabs = tabs.filter((t) => t.type === "sftp" && t.sftp);
  const settingsTabs = tabs.filter((t) => t.type === "settings");
  const gitTabs = tabs.filter((t) => t.type === "git" && t.git);
  const codeWorkspaceTabs = tabs.filter((t) => t.type === "code-workspace" && t.codeWorkspace);
  const vncTabs = tabs.filter((t) => t.type === "vnc" && t.vnc);
  const rdpTabs = tabs.filter((t) => t.type === "rdp" && t.rdp);
  const fileBrowserTabs = tabs.filter((t) => t.type === "file-browser" && t.fileBrowser);
  const objectStorageTabs = tabs.filter((t) => t.type === "object-storage" && t.objectStorage);
  const dbTabs = tabs.filter((t) => t.type === "database" && t.db);
  const redisTabs = tabs.filter((t) => t.type === "redis" && t.db);
  const hbaseTabs = tabs.filter((t) => t.type === "hbase-shell" && t.hbase);
  const mailTabs = tabs.filter((t) => t.type === "mail" && t.mail);
  const terminalSplitVisible =
    terminalSplitActive && terminalTabs.length > 0 && activeTab?.type === "terminal";
  // ED-PARITY-027 B: a terminal's tool windows (attached SFTP, Chat) move from
  // its floating actions into the collapsed sidebar rail.
  const terminalRailMerged = mergeToolWindowRail && sidebarCollapsed && !!mainRailHost
    && activeTab?.type === "terminal" && !terminalSplitVisible;
  const toggleTerminalSftp = (tab: Tab) => {
    if (sftpDetachedTabs[tab.id] && tab.ssh) {
      openDetachedSftp(
        {
          sessionId: `attached-${tab.id}`,
          host: tab.ssh.host,
          port: tab.ssh.port,
          username: tab.ssh.username,
          authMethod: tab.ssh.authMethod,
          authData: tab.ssh.authData,
          networkSettingsJson: JSON.stringify(
            toNetworkSettingsPayload(getSessionNetworkSettings(tab.ssh.optionsJson)),
          ),
          initialPath: terminalCwds[tab.id],
          attachedToTerminal: true,
        },
        `${tab.title} — SFTP`,
      );
    } else {
      toggleAttachedSidebar(tab.id);
    }
  };
  const terminalRailItems: ToolWindowRailItem[] = [];
  if (terminalRailMerged && activeTab) {
    const railTab = activeTab;
    if (railTab.ssh) {
      terminalRailItems.push({
        id: "sftp",
        label: t("terminal.sftpFloatingButtonLabel"),
        icon: <FolderOpen />,
        active: !!attachedSidebars[railTab.id],
        testId: "attached-sftp-toggle",
        onSelect: () => toggleTerminalSftp(railTab),
      });
    }
    if (!aiFullyDisabled) {
      terminalRailItems.push({
        id: "chat",
        label: t("terminal.chatFloatingButtonLabel"),
        icon: <Bot />,
        active: chatDrawerOpen && activeTabId === railTab.id,
        testId: "tab-chat-toggle",
        onSelect: () => void toggleTabChat(chatBindingIdForTab(railTab) ?? railTab.id),
      });
    }
  }
  const effectiveMultiExecSelectedCount = terminalSplitActive
    ? [...multiExecSelectedTabIds].filter((id) => !terminalSplitInputLockedTabIds.has(id)).length
    : multiExecSelectedTabIds.size;
  const { terminalPanesClass, splitGridColumnTemplate, splitGridRowTemplate, splitGridColumns, splitPaneWeightsForTabs, startLinearSplitResize, splitGridColumnWeightsForLayout, startGridSplitResize, splitGridRowWeightsForLayout, splitPanesRef } = useTerminalSplitLayout({
    terminalTabs,
    terminalSplitVisible,
    terminalSplitLayout,
  });

  // macOS uses the native overlay title bar (traffic lights + native resize),
  // so the custom resize handles are Windows/Linux only.
  const isMac = getAppPlatform() === "macos";
  const chatDockViewport = useViewportSize();
  // After the drawer has been opened once, keep ChatDrawer mounted (hidden)
  // across tab switches so the transcript does not remount and re-animate.
  const [chatDrawerKeepAlive, setChatDrawerKeepAlive] = useState(false);
  useEffect(() => {
    if (chatDrawerOpen) setChatDrawerKeepAlive(true);
  }, [chatDrawerOpen]);
  const chatDrawerSurfaceActive = !aiFullyDisabled && (chatDrawerOpen || chatDrawerKeepAlive);
  const chatDockMode = chatDrawerSurfaceActive
    ? resolveChatDock(chatDrawerPosition, chatDrawerPinned, chatDockViewport.width, chatDockViewport.height)
    : "floating";
  const chatDrawerInline = chatDockMode === "side-inline";
  const chatDrawerTopPinned = chatDockMode === "stacked-inline" && chatDrawerPosition === "top";
  const chatDrawerBottomPinned = chatDockMode === "stacked-inline" && chatDrawerPosition === "bottom";
  const chatDrawerFloating = chatDrawerSurfaceActive && chatDockMode === "floating";

  return (
    <TabActionSlotProvider slot={tabActionSlot}>
    <div
      className="taomni-main-window relative w-full h-full flex flex-col"
      style={{ background: "var(--taomni-chrome-bg)" }}
    >
      {!isMac && <WindowResizeHandles />}
      <div data-testid="app-titlebar" className="min-w-0">
        <ControlBar
          activeTabClosable={!!activeTab?.closable}
          nativeMenu={nativeMenu}
          xServerEnabled={xServerEnabled}
          quickConnectVisible={quickConnectVisible}
          workspaceCommands={activeWorkspaceCommandRegistration?.items ?? []}
          onCommand={handleCommand}
          onWorkspaceCommand={(commandId) => activeWorkspaceCommandRegistration?.executeAction(commandId)}
          onToggleSidebar={toggleSidebar}
          onStartLocalTerminal={(localShell) =>
            openLocalTab(localShell?.name ?? tr("tabs.localTerminal"), undefined, undefined, localShell)
          }
          onConnectSession={handleConnectSession}
          onOpenSessionEditor={() => handleNewSession()}
          onDuplicateTab={handleDuplicateTab}
          onDetachActiveTab={
            activeTab && (
              (activeTab.type === "terminal" && !terminalSplitVisible) ||
              (activeTab.type === "rdp" && !!activeTab.rdp) ||
              (activeTab.type === "vnc" && !!activeTab.vnc) ||
              (activeTab.type === "database" && !!activeTab.db) ||
              (activeTab.type === "sftp" && !!activeTab.sftp)
            )
              ? handleDetachActiveTab
              : undefined
          }
          onCloseWindow={requestAppExit}
          slotRef={setTabActionSlot}
        />
      </div>
      {quickConnectVisible && (
        <QuickConnect
          onConnectInput={handleQuickConnect}
          onConnectSession={handleConnectSession}
          onHome={() => setActiveTab("welcome")}
        />
      )}

      {chatDrawerTopPinned && <ChatDrawer />}

      <div className="flex-1 flex min-h-0">
        {terminalRailMerged && mainRailHost && terminalRailItems.length > 0 && createPortal(
          <ToolWindowRail
            side="left"
            embedded
            top={terminalRailItems}
            width={effectiveStripeWidth(stripeSettings, "left")}
            showNames={stripeSettings.showNames}
            onToggleShowNames={toggleStripeNames}
            onHide={(id) => terminalRailItems.find((item) => item.id === id)?.onSelect()}
          />,
          mainRailHost,
        )}
        {sidebarCollapsed && (
          <div data-testid="collapsed-sidebar-rail" className="h-full shrink-0 overflow-visible">
            <Sidebar
              compact
              onNewSession={handleNewSession}
              onNewSftpSession={handleNewSftpSession}
              onEditSession={handleEditSession}
              onConnectSession={handleConnectSession}
              onOpenSettings={() => handleCommand("settings")}
              onCommand={handleCommand}
            />
          </div>
        )}
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
            panelRef={sidebarPanelRef}
            id="sidebar"
            defaultSize="22%"
            minSize="15%"
            maxSize="40%"
            collapsible
            collapsedSize={0}
            // The panel's default scroll container can pan the fixed rail when
            // a focused/selected session is scrolled into view. Its children
            // own their scrolling; this frame must keep the rail in place.
            style={{ overflow: "clip" }}
            onResize={(size: PanelSize, _id, prevSize?: PanelSize) => {
              const percentage = size.asPercentage;
              if (percentage > 2) {
                lastSidebarSizeRef.current = percentage;
              }
              // The first report is the restored layout, which may carry another
              // tab group's collapsed sidebar (ED-PARITY-027); the store's state
              // wins and the sync effect resizes the panel to it.
              if (!prevSize) return;
              setSidebarCollapsed(percentage <= 2);
            }}
          >
            <div data-testid="expanded-sidebar-panel" className="h-full overflow-clip" style={sidebarCollapsed ? { display: "none" } : undefined}>
              <Sidebar
                onNewSession={handleNewSession}
                onNewSftpSession={handleNewSftpSession}
                onEditSession={handleEditSession}
                onConnectSession={handleConnectSession}
                onOpenSettings={() => handleCommand("settings")}
                onCommand={handleCommand}
              />
            </div>
          </Panel>

          <PanelResizeHandle
            id="main-sidebar-resize-handle"
            data-testid="main-sidebar-resize-handle"
            className={sidebarCollapsed ? "hidden" : "w-[6px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize"}
          />

          <Panel id="content">
            <div className="h-full flex min-w-0">
              {chatDrawerInline && chatDrawerPosition === "left" && <ChatDrawer />}
              <div className="h-full flex flex-col min-w-0 flex-1">
              {multiExecActive && (
                <MultiExecBar
                  selectedCount={effectiveMultiExecSelectedCount}
                  totalTerminalCount={tabs.filter((t) => t.type === "terminal").length}
                  onSend={broadcastToSelectedTerminals}
                  onSelectAll={selectAllTerminalTabs}
                  onClearSelection={clearMultiExecSelection}
                  onClose={toggleMultiExec}
                />
              )}
              <TabContentRouter
  activeTab={activeTab}
  welcomeRestore={welcomeRestore}
  openLocalTab={openLocalTab}
  handleNewSession={handleNewSession}
  handleOpenLocalPath={handleOpenLocalPath}
  openLanChatTab={openLanChatTab}
  welcomeRecentSessions={welcomeRecentSessions}
  recentWorkspaces={recentWorkspaces}
  welcomeMailSessions={welcomeMailSessions}
  handleConnectSession={handleConnectSession}
  handleConnectSessions={handleConnectSessions}
  handleEditSession={handleEditSession}
  handleRevealRecentSession={handleRevealRecentSession}
  openRecentCodeWorkspace={openRecentCodeWorkspace}
  removeRecentWorkspace={removeRecentWorkspace}
  clearRecentWorkspaces={clearRecentWorkspaces}
  revealRecentCodeWorkspace={revealRecentCodeWorkspace}
  openNewCodeWorkspaceFromWelcome={openNewCodeWorkspaceFromWelcome}
  openSettingsTab={openSettingsTab}
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
  setSftpDetachedTabs={setSftpDetachedTabs}
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
  sftpTabs={sftpTabs}
  settingsTabs={settingsTabs}
  gitTabs={gitTabs}
  openCodeWorkspaceTab={openCodeWorkspaceTab}
  codeWorkspaceTabs={codeWorkspaceTabs}
  openWorkspaceGitManager={openWorkspaceGitManager}
  syncWorkspaceGitManager={syncWorkspaceGitManager}
  handleWorkspaceCommandsChange={handleWorkspaceCommandsChange}
  tabs={tabs}
  unifiedMailAccounts={unifiedMailAccounts}
  openMailAccountById={openMailAccountById}
  vncTabs={vncTabs}
  persistVncProperties={persistVncProperties}
  rememberVncCredentials={rememberVncCredentials}
  openDetachedVnc={openDetachedVnc}
  rdpTabs={rdpTabs}
  openDetachedRdp={openDetachedRdp}
  fileBrowserTabs={fileBrowserTabs}
  objectStorageTabs={objectStorageTabs}
  mailTabs={mailTabs}
  handleEditSessionById={handleEditSessionById}
  dbTabs={dbTabs}
  redisTabs={redisTabs}
  hbaseTabs={hbaseTabs}
  setStatusMessage={setStatusMessage}
  removeTab={removeTab}
/>
              </div>
              {chatDrawerInline && chatDrawerPosition === "right" && <ChatDrawer />}
            </div>
          </Panel>
        </PanelGroup>
        {chatDrawerFloating && <ChatDrawer />}
        {!aiFullyDisabled && <TaoRibbon />}
        <FloatingNotesPanel />
        <TaoAlertPoller />
      </div>

      {chatDrawerBottomPinned && <ChatDrawer />}

      <StatusBar />

      <CcAgentBridge />

      {showSessionEditor && (
        <SessionEditor
          session={editingSession}
          defaultGroupPath={newSessionGroupPath}
          initialProto={newSessionInitialProto}
          onClose={() => {
            setShowSessionEditor(false);
            setEditingSession(undefined);
            setNewSessionGroupPath(null);
            setNewSessionInitialProto(undefined);
          }}
        />
      )}

      {pendingAuth && (
        <AuthPrompt
          host={pendingAuth.kind === "jump" ? pendingAuth.host : pendingAuth.session.host}
          username={pendingAuth.kind === "jump" ? pendingAuth.username : pendingAuth.session.username ?? "root"}
          onSubmit={handleAuthSubmit}
          onCancel={() => {
            if (pendingAuth.kind === "session" && pendingAuth.resumeRequestId) {
              cancelResumeWaiter(pendingAuth.resumeRequestId, "authentication", "Authentication cancelled");
            }
            setPendingAuth(null);
            awaitingManualAuthRef.current = false;
            continueConnectQueueRef.current();
          }}
        />
      )}

      {vaultUnlockReason && (
        <VaultUnlockDialog
          reason={vaultUnlockReason}
          onCancel={() => {
            pendingVaultActionRef.current = null;
            awaitingVaultUnlockRef.current = false;
            connectQueueRef.current = [];
            setVaultUnlockReason(null);
            cancelAllResumeWaiters("authentication", "Vault unlock cancelled");
          }}
          onSubmit={async (pw) => {
            await unlockVault(pw);
            const pending = pendingVaultActionRef.current;
            pendingVaultActionRef.current = null;
            setVaultUnlockReason(null);
            awaitingVaultUnlockRef.current = false;
            if (pending) pending();
          }}
        />
      )}

      {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}
      <UpdateDialog />

      {/* Session import preview — driven by the native macOS menu's
          import actions (no-op elsewhere, where the ControlBar app menu hosts
          its own). */}
      {nativeMenu && importExport.previewNode}

      {appExitConfirmDialog}
      <CallOverlay />
      <WhiteboardOverlay />
      <EdgeDrawer />
    </div>
    </TabActionSlotProvider>
  );
}
