import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { activeWorkspaceRuntimeTabId } from "../../lib/workspaceRuntimeIdentity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type PanelImperativeHandle } from "react-resizable-panels";
import { useToolWindowStripeStore } from "../../components/editor/workspace/toolWindowStripeStore";
import type { WorkspaceCommandRegistration } from "../../components/editor/workspace/workspaceCommands";
import { type SftpPendingUploadRequest } from "../../components/filebrowser/FileBrowser";
import { useSessionImportExport } from "../../components/menubar/useSessionImportExport";
import { useConfirmDialog } from "../../components/sidebar/ConfirmDialog";
import { t as tr, useT } from "../../lib/i18n";
import { VAULT_LOCKED_EVENT, type SessionConfig } from "../../lib/ipc";
import { getAppPlatform, isTauriRuntime } from "../../lib/runtime";
import { useAiStore } from "../../stores/aiStore";
import { useAppStore } from "../../stores/appStore";
import { useChatStore } from "../../stores/chatStore";
import { useMainRailHostStore } from "../../stores/mainRailHostStore";
import { useSessionStore } from "../../stores/sessionStore";
import { sidebarRailGroup } from "../../stores/sidebarRailPolicy";
import { useUpdateStore } from "../../stores/updateStore";
import { useVaultStore } from "../../stores/vaultStore";
import type { LocalLaunchOutcome } from "../../types";
import { SAVED_PASSWORD_VAULT_REASON_KEY } from "./authentication";
import { readQuickConnectVisible } from "./sessionPolicy";
import { type ConnectQueueEntry, type ControlToolExecutor, type PendingAuth } from "./types";
import { useTerminalProfiles } from "./useTerminalProfiles";


export interface UseMainLayoutStateContext {

}

export function useMainLayoutState(context: UseMainLayoutStateContext) {
  const { } = context;
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
  const primaryMode = useAppStore((state) => state.activeSideTab);
  const platformTabClosable = useWorkspacePlatformStore((state) => {
    const workspace = state.workspaces.find((item) => item.id === state.activeWorkspaceId);
    return !!workspace?.openTabs.find((tab) => tab.id === workspace.activeTabId)?.closable;
  });
  const activeTabClosable = primaryMode === "workspaces" ? platformTabClosable : !!activeTab?.closable;
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
  const lastSidebarSizeRef = useRef(0);
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
  const platformActiveTabId = useWorkspacePlatformStore((state) => activeWorkspaceRuntimeTabId(state.getWorkspace()));
  const commandTabId = primaryMode === "workspaces" ? platformActiveTabId : primaryMode === "sessions" ? activeTabId : undefined;
  const activeWorkspaceCommandRegistration = commandTabId ? workspaceCommandRegistrations[commandTabId] ?? null : null;
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
      const detail = (evt as CustomEvent<{ reason?: string; }>).detail;
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
  return {
    setAttachedSidebars,
    tabs,
    setSftpDetachedTabs,
    setPendingSftpUploadRequests,
    terminalCwdsRef,
    setTerminalCwds,
    setTerminalCwdVersions,
    assignTerminalAutoTitle,
    cwdQueryResolversRef,
    terminalSessionIds,
    setTerminalCwdRequestTokens,
    terminalProfileOverrides,
    terminalProfilesBySessionId,
    duplicateTab,
    setStatusMessage,
    sftpUploadRequestSeqRef,
    setTerminalSplitActive,
    setTabHasNewOutput,
    removeTab,
    tabsRef,
    setActiveTab,
    addTab,
    loadSessions,
    refreshXServer,
    activeTabId,
    activeTab,
    activeTabClosable,
    syncTabChatWithActiveTab,
    sidebarPanelRef,
    sidebarCollapsed,
    lastSidebarSizeRef,
    toggleTabChat,
    confirmAppExit,
    exitRequestInFlightRef,
    setEditingSession,
    setNewSessionGroupPath,
    setNewSessionInitialProto,
    setShowSessionEditor,
    markConnected,
    pendingLocalLaunchesRef,
    updateSession,
    updateGitTabInfo,
    connectQueueRef,
    awaitingVaultUnlockRef,
    pendingVaultActionRef,
    continueConnectQueueRef,
    setVaultUnlockReason,
    sessions,
    awaitingManualAuthRef,
    setPendingAuth,
    connectQueueRunningRef,
    terminalCwds,
    setActiveSideTab,
    setSidebarCollapsed,
    setSelectedSession,
    setSearchQuery,
    pendingAuth,
    t,
    updateTabTitle,
    moveTabToIndex,
    executeControlToolRef,
    seenControlToolCallsRef,
    quickConnectVisible,
    setQuickConnectVisible,
    toggleXServer,
    toggleSidebar,
    toggleTerminalSplit,
    toggleMultiExec,
    setShowAbout,
    activeWorkspaceCommandRegistration,
    importExport,
    nativeMenu,
    workspaceCommandRegistrationsRef,
    terminalSplitActive,
    mergeToolWindowRail,
    mainRailHost,
    sftpDetachedTabs,
    attachedSidebars,
    aiFullyDisabled,
    chatDrawerOpen,
    multiExecSelectedTabIds,
    terminalSplitInputLockedTabIds,
    terminalSplitLayout,
    chatDrawerPosition,
    chatDrawerPinned,
    tabActionSlot,
    xServerEnabled,
    setTabActionSlot,
    stripeSettings,
    toggleStripeNames,
    multiExecActive,
    selectAllTerminalTabs,
    clearMultiExecSelection,
    welcomeRecentSessions,
    recentWorkspaces,
    welcomeMailSessions,
    removeRecentWorkspace,
    clearRecentWorkspaces,
    setTerminalSplitLayout,
    clearTerminalSplitInputLocks,
    terminalRuntimeByTab,
    handleTerminalProfileChange,
    terminalCwdRequestTokens,
    terminalCwdVersions,
    pendingSftpUploadRequests,
    toggleTerminalSplitInputLock,
    handleWorkspaceCommandsChange,
    showSessionEditor,
    editingSession,
    newSessionGroupPath,
    newSessionInitialProto,
    vaultUnlockReason,
    unlockVault,
    showAbout,
    appExitConfirmDialog,
  };
}
