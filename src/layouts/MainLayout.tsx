import {
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { MenuBar } from "../components/menubar/MenuBar";
import { Ribbon, type RibbonCommand } from "../components/menubar/Ribbon";
import { QuickConnect } from "../components/quickconnect/QuickConnect";
import { Sidebar } from "../components/sidebar/Sidebar";
import { useConfirmDialog } from "../components/sidebar/ConfirmDialog";
import { CompactTitleBar } from "../components/tabbar/CompactTitleBar";
import { TabBar } from "../components/tabbar/TabBar";
import { StatusBar } from "../components/statusbar/StatusBar";
import { AppTitleBar } from "../components/window/AppTitleBar";
import { WindowResizeHandles } from "../components/window/WindowResizeHandles";
import { TerminalPanel } from "../components/terminal/TerminalPanel";
import { MultiExecBar } from "../components/terminal/MultiExecBar";
import { SessionEditor } from "../components/session/SessionEditor";
import { AuthPrompt } from "../components/session/AuthPrompt";
import { SettingsPanel } from "../components/settings/SettingsPanel";
import { TunnelManager } from "../components/tunnel/TunnelManager";
import { FileBrowser } from "../components/filebrowser/FileBrowser";
import { LocalFileBrowserPanel } from "../components/filebrowser/LocalFileBrowserPanel";
import { SftpSidebar } from "../components/filebrowser/SftpSidebar";
import { getAppPlatform, isTauriRuntime } from "../lib/runtime";
import { openSftpWindow } from "../lib/sftp";
import { openDetachedWindow } from "../lib/detachWindowing";
import { sftpOpenPath, sftpStat, effectiveFileType } from "../lib/sftp";
import { writeTerminal } from "../lib/ipc";
import { encodeBase64 } from "../lib/ipc";
import {
  clearDetachedHandoff,
  detachedWindowUrl,
  writeDetachedHandoff,
} from "../components/filebrowser/SftpDetachedWindow";
import {
  writeDetachedHandoff as writeGenericHandoff,
  clearDetachedHandoff as clearGenericHandoff,
  detachedWindowUrl as detachedGenericUrl,
  subscribeReattach,
  drainPendingReattach,
  clearReattachHandoff,
  type DetachedKind,
  type ReattachMessage,
} from "../lib/detachedSession";
import type { DetachedRdpParams, DetachedVncParams, DetachedTerminalParams, DetachedDbParams } from "../components/detached/DetachedSessionWindow";
import { Columns2, Grid2X2, Lock, Rows3, Unlock, X } from "lucide-react";
import type { SftpTabInfo, Tab, DbConnectInfo } from "../types";
import { useAppStore, type TerminalSplitLayout } from "../stores/appStore";
import { useSessionStore } from "../stores/sessionStore";
import { WelcomePanel } from "../components/WelcomePanel";
import { AboutDialog } from "../components/AboutDialog";
import { ServersDialog } from "../components/servers/ServersDialog";
import { useServersStore } from "../stores/serversStore";
import { parseQuickConnectInput } from "../lib/quickConnect";
import { exitApp, type SessionConfig } from "../lib/ipc";
import {
  vaultPut,
  isVaultLockedError,
  VAULT_LOCKED_EVENT,
} from "../lib/ipc";
import { useVaultStore } from "../stores/vaultStore";
import { VaultUnlockDialog } from "../components/vault/VaultUnlockDialog";
import { parseSessionOptions } from "../lib/terminalProfile";
import { getSessionTerminalProfile, type TerminalProfile } from "../lib/terminalProfile";
import { getSessionNetworkSettings, toNetworkSettingsPayload } from "../lib/networkSettings";
import { parseRdpOptions } from "../types/rdp";
import type { LocalShellSelection } from "../types";
import { ChatDrawer } from "../components/chat/ChatDrawer";
import { useChatStore } from "../stores/chatStore";
import { useAiStore } from "../stores/aiStore";
import { setActiveTerminalTab, getTerminal, markTerminalDetachPending, clearTerminalDetachPending } from "../lib/terminal/terminalRegistry";
import { setActiveQueryTab } from "../lib/queryRegistry";
import { t as tr, useT } from "../lib/i18n";

const VncPanel = lazy(() => import("../components/vnc/VncPanel"));
const RdpPanel = lazy(() => import("../components/rdp/RdpPanel"));
const DbClientTab = lazy(() => import("../components/database/DbClientTab"));
const RedisClientTab = lazy(() => import("../components/database/RedisClientTab"));

interface PendingAuth {
  session: SessionConfig;
}

type ConnectQueueOutcome = "opened" | "awaiting-auth" | "awaiting-vault";

const MIN_SPLIT_WEIGHT = 0.35;
const SAVED_PASSWORD_VAULT_REASON_KEY = "vault.unlockReasonDefault";
const RIBBON_VISIBLE_KEY = "taomni.ribbonVisible";
const QUICK_CONNECT_VISIBLE_KEY = "taomni.quickConnectVisible";

function macCommandDigitIndex(event: KeyboardEvent): number | null {
  if (
    getAppPlatform() !== "macos" ||
    !event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return null;
  }

  const digit =
    /^[1-9]$/.test(event.key)
      ? event.key
      : event.code.match(/^(?:Digit|Numpad)([1-9])$/)?.[1];
  if (!digit) return null;

  const number = Number.parseInt(digit, 10);
  return number === 9 ? -1 : number - 1;
}

function readRibbonVisible(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(RIBBON_VISIBLE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeRibbonVisible(visible: boolean) {
  try {
    window.localStorage.setItem(RIBBON_VISIBLE_KEY, visible ? "true" : "false");
  } catch {
    // Ignore storage failures; the in-memory visibility state still applies.
  }
}

function readQuickConnectVisible(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(QUICK_CONNECT_VISIBLE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeQuickConnectVisible(visible: boolean) {
  try {
    window.localStorage.setItem(QUICK_CONNECT_VISIBLE_KEY, visible ? "true" : "false");
  } catch {
    // Ignore storage failures; the in-memory visibility state still applies.
  }
}

function localShellSelectionFromSession(session: SessionConfig): LocalShellSelection | undefined {
  const options = parseSessionOptions(session.options_json);
  const path = typeof options.localShellPath === "string" ? options.localShellPath.trim() : "";
  if (!path) return undefined;
  const args = Array.isArray(options.localShellArgs)
    ? options.localShellArgs.filter((value): value is string => typeof value === "string")
    : undefined;
  return {
    id: path,
    name: session.name || path,
    ...(args && args.length > 0 ? { args } : {}),
  };
}

function resolveSessionAuth(session: SessionConfig): { method: string; data: string | null } {
  const method = typeof session.auth_method === "string"
    ? session.auth_method
    : "PrivateKey";
  const data = typeof session.auth_method === "object" && "PrivateKey" in session.auth_method
    ? session.auth_method.PrivateKey.key_path
    : null;
  return { method, data };
}

function passwordRefFromOptions(session: SessionConfig): string | null {
  const opts = parseSessionOptions(session.options_json);
  const ref = typeof opts.passwordRef === "string" ? opts.passwordRef : "";
  return ref && ref.startsWith("vault:") ? ref : null;
}

/**
 * Build a {@link DbConnectInfo} from a saved DB session. Engine-specific
 * options (ClickHouse HTTP port / protocol, Presto catalog, Redis DB index,
 * SSL, timeout, default database) live in `options_json` under the `db*` keys the session
 * editor writes. `password` is the resolved credential (plaintext or a
 * `vault:` reference) the connect path already worked out.
 */
function sessionToDbConnectInfo(session: SessionConfig, password?: string): DbConnectInfo {
  const opts = parseSessionOptions(session.options_json);
  const str = (key: string, fallback = ""): string =>
    typeof opts[key] === "string" ? (opts[key] as string) : fallback;
  const num = (key: string): number | null => {
    const raw = opts[key];
    const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
    return Number.isFinite(n) ? n : null;
  };
  const engine = session.session_type as DbConnectInfo["engine"];
  return {
    sessionId: session.id,
    workspaceSessionId: session.id,
    engine,
    host: session.host,
    port: session.port,
    username: session.username,
    password,
    catalog: engine === "Presto" ? str("dbCatalog") || null : null,
    database: str("dbDatabase") || null,
    ssl: opts.dbSsl === true,
    timeoutSecs: num("dbTimeout"),
    httpPort: engine === "ClickHouse" ? (num("dbHttpPort") ?? 8123) : null,
    protocol: engine === "ClickHouse" ? str("dbChProtocol", "HTTP").toLowerCase() : null,
    dbIndex: engine === "Redis" ? (num("dbRedisIndex") ?? 0) : null,
  };
}

export function MainLayout() {
  const t = useT();
  const {
    tabs,
    activeTabId,
    sidebarCollapsed,
    compactMode,
    xServerEnabled,
    refreshXServer,
    addTab,
    removeTab,
    setActiveTab,
    toggleSidebar,
    setSidebarCollapsed,
    toggleCompactMode,
    toggleXServer,
    setStatusMessage,
    multiExecActive,
    multiExecSelectedTabIds,
    terminalSplitActive,
    terminalSplitLayout,
    terminalSplitInputLockedTabIds,
    toggleMultiExec,
    selectAllTerminalTabs,
    clearMultiExecSelection,
    toggleTerminalSplit,
    setTerminalSplitLayout,
    toggleTerminalSplitInputLock,
    clearTerminalSplitInputLocks,
    setTabHasNewOutput,
    tabMaximizedId,
    toggleTabMaximized,
  } = useAppStore();
  const { loadSessions, markConnected, sessions, updateSession } = useSessionStore();
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const terminalProfilesBySessionId = useMemo(() => {
    const profiles = new Map<string, TerminalProfile | undefined>();
    for (const session of sessions) {
      profiles.set(session.id, getSessionTerminalProfile(session.options_json));
    }
    return profiles;
  }, [sessions]);
  const tabsRef = useRef(tabs);
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null);
  const lastSidebarSizeRef = useRef(22);
  const [showSessionEditor, setShowSessionEditor] = useState(false);
  const [editingSession, setEditingSession] = useState<SessionConfig | undefined>();
  const [newSessionGroupPath, setNewSessionGroupPath] = useState<string | null>(null);
  const [newSessionInitialProto, setNewSessionInitialProto] = useState<string | undefined>();
  const [pendingAuth, setPendingAuth] = useState<PendingAuth | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const [attachedSidebars, setAttachedSidebars] = useState<Record<string, boolean>>({});
  const [compactSidebarOpen, setCompactSidebarOpen] = useState(false);
  const [ribbonVisible, setRibbonVisible] = useState(readRibbonVisible);
  const [quickConnectVisible, setQuickConnectVisible] = useState(readQuickConnectVisible);
  const exitRequestInFlightRef = useRef(false);
  const { confirm: confirmAppExit, render: appExitConfirmDialog } = useConfirmDialog();
  const [terminalCwds, setTerminalCwds] = useState<Record<string, string>>({});
  const [terminalCwdVersions, setTerminalCwdVersions] = useState<Record<string, number>>({});
  const [terminalCwdRequestTokens, setTerminalCwdRequestTokens] = useState<Record<string, number>>({});
  const [splitPaneWeights, setSplitPaneWeights] = useState<Record<string, number>>({});
  const [splitGridColumnWeights, setSplitGridColumnWeights] = useState<number[]>([]);
  const [splitGridRowWeights, setSplitGridRowWeights] = useState<number[]>([]);
  const [vaultUnlockReason, setVaultUnlockReason] = useState<string | null>(null);
  const pendingVaultActionRef = useRef<(() => void) | null>(null);
  const connectQueueRef = useRef<SessionConfig[]>([]);
  const connectQueueRunningRef = useRef(false);
  const awaitingManualAuthRef = useRef(false);
  const awaitingVaultUnlockRef = useRef(false);
  const continueConnectQueueRef = useRef<() => void>(() => undefined);
  const splitPanesRef = useRef<HTMLDivElement>(null);
  const refreshVault = useVaultStore((s) => s.refresh);
  const unlockVault = useVaultStore((s) => s.unlock);
  const aiFullyDisabled = useAiStore((s) => s.config?.fully_disabled === true);
  const toggleGlobalChat = useChatStore((s) => s.toggleGlobalChat);
  const toggleTabChat = useChatStore((s) => s.toggleTabChat);
  const syncTabChatWithActiveTab = useChatStore((s) => s.syncTabChatWithActiveTab);
  const chatDrawerOpen = useChatStore((s) => s.drawerOpen);
  const chatDrawerScope = useChatStore((s) => s.drawerScope);
  const chatDrawerTabId = useChatStore((s) => s.drawerTabId);

  // Pull initial vault status so dialogs that consult it (SessionEditor,
  // TunnelEditor, AuthPrompt) render against fresh state.
  useEffect(() => {
    void refreshVault().catch(() => undefined);
  }, [refreshVault]);

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

  const toggleAttachedSidebar = useCallback((tabId: string) => {
    setAttachedSidebars((prev) => ({ ...prev, [tabId]: !prev[tabId] }));
  }, []);

  const handleTerminalCwd = useCallback((tabId: string, cwd: string) => {
    setTerminalCwds((prev) => (prev[tabId] === cwd ? prev : { ...prev, [tabId]: cwd }));
    setTerminalCwdVersions((prev) => ({ ...prev, [tabId]: (prev[tabId] ?? 0) + 1 }));
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
  }, []);

  const requestTerminalCwd = useCallback((tabId: string): boolean => {
    if (!terminalSessionIds.current[tabId]) {
      setStatusMessage(tr("status.terminalNotReady"));
      return false;
    }
    setTerminalCwdRequestTokens((prev) => ({ ...prev, [tabId]: (prev[tabId] ?? 0) + 1 }));
    return true;
  }, [setStatusMessage]);

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

  const openDetachedSftp = useCallback((params: SftpTabInfo, title: string) => {
    // Use a DIFFERENT session id for the detached window so its backend
    // SFTP channel is independent from the sidebar's. Without this, the
    // popup and the sidebar share one `Arc<Mutex<SftpSession>>` and any
    // long transfer in one window stalls clicks/listings in the other.
    // The suffix is stable per parent so re-clicking "Detach" focuses the
    // existing popup instead of opening a second one.
    const detachedSessionId = `${params.sessionId}__detached`;
    writeDetachedHandoff({
      ...params,
      sessionId: detachedSessionId,
      parentSessionId: params.sessionId,
      title,
    });
    if (isTauriRuntime()) {
      // Native: open a real OS window via the Rust command. The handoff
      // payload was just written to localStorage above so the new window
      // can read it on mount. If launching the OS window fails we must
      // wipe the handoff immediately — otherwise the credentials sit on
      // disk for the rest of the run with no one waiting to consume them.
      void openSftpWindow(detachedSessionId, title).catch((err) => {
        clearDetachedHandoff(detachedSessionId);
        setStatusMessage(tr("status.sftpWindowError", {
          error: err instanceof Error ? err.message : String(err),
        }));
      });
      return;
    }
    const url = detachedWindowUrl(detachedSessionId);
    const features = "width=1200,height=760,resizable=yes,scrollbars=yes";
    const handle = window.open(url, `taomni_sftp_${detachedSessionId}`, features);
    if (!handle) {
      // Pop-up blocked — clean up the credential blob right away so it
      // doesn't linger in localStorage waiting for a window that never
      // arrives.
      clearDetachedHandoff(detachedSessionId);
      setStatusMessage(tr("status.sftpPopupBlocked"));
    }
  }, [setStatusMessage]);

  /**
   * Hand off the credentials of a non-SFTP tab to a new OS window and
   * remove the source tab from this window. The new window opens its own
   * backend session of the same kind. Reattach reverses the move via the
   * `BroadcastChannel('taomni.detach.sync')` subscriber wired below.
   */
  const openDetachedGenericWindow = useCallback(
    <T,>(
      kind: DetachedKind,
      sourceTabId: string,
      detachedId: string,
      payload: T,
      title: string,
    ) => {
      writeGenericHandoff(kind, detachedId, payload);
      if (isTauriRuntime()) {
        void openDetachedWindow({
          kind,
          sessionId: detachedId,
          title,
        })
          .then(() => {
            // Once the OS window is up the source tab is no longer the
            // owner of this connection. Drop it; the detached window owns
            // a fresh connection of its own.
            removeTab(sourceTabId);
          })
          .catch((err) => {
            clearGenericHandoff(kind, detachedId);
            if (kind === "terminal") clearTerminalDetachPending(sourceTabId);
            setStatusMessage(
              tr("status.detachWindowError", {
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          });
        return;
      }
      const url = detachedGenericUrl(kind, detachedId);
      const features = "width=1280,height=800,resizable=yes,scrollbars=yes";
      const handle = window.open(url, `taomni_${kind}_${detachedId}`, features);
      if (!handle) {
        clearGenericHandoff(kind, detachedId);
        if (kind === "terminal") clearTerminalDetachPending(sourceTabId);
        setStatusMessage(tr("status.detachPopupBlocked"));
        return;
      }
      removeTab(sourceTabId);
    },
    [removeTab, setStatusMessage],
  );

  const openDetachedRdp = useCallback(
    (tabId: string, info: NonNullable<Tab["rdp"]>, title: string) => {
      const detachedId = `${tabId}__detached`;
      const payload: DetachedRdpParams = {
        sessionId: info.sessionId,
        host: info.host,
        port: info.port,
        username: info.username ?? null,
        password: info.password,
        options: info.options,
        networkSettingsJson: info.networkSettingsJson ?? null,
        title,
      };
      openDetachedGenericWindow("rdp", tabId, detachedId, payload, title);
    },
    [openDetachedGenericWindow],
  );

  const openDetachedVnc = useCallback(
    (tabId: string, info: NonNullable<Tab["vnc"]>, title: string) => {
      const detachedId = `${tabId}__detached`;
      const payload: DetachedVncParams = {
        sessionId: info.sessionId,
        host: info.host,
        port: info.port,
        username: info.username ?? null,
        password: info.password,
        title,
      };
      openDetachedGenericWindow("vnc", tabId, detachedId, payload, title);
    },
    [openDetachedGenericWindow],
  );

  const openDetachedTerminal = useCallback(
    (
      tabId: string,
      tab: Tab,
      title: string,
    ) => {
      // Capture the live backend session id + scrollback snapshot so the
      // detached window can adopt the existing PTY/SSH session instead of
      // spawning a fresh one. The TerminalPanel cleanup on the source tab
      // honours the detach-pending flag and skips its `closeTerminal`
      // call so the backend session survives the React unmount.
      const detachedId = `${tabId}__detached`;
      const liveSessionId = terminalSessionIds.current[tabId];
      const liveEntry = getTerminal(tabId);
      const snapshotText = liveEntry ? liveEntry.getBufferText() : undefined;
      const reattach = liveSessionId
        ? { terminalSessionId: liveSessionId, snapshotText }
        : undefined;
      const payload: DetachedTerminalParams = {
        title,
        ssh: tab.ssh ?? null,
        localShell: tab.localShell ?? null,
        terminalProfile: tab.terminalProfile ?? null,
        reattach,
      };
      if (liveSessionId) {
        markTerminalDetachPending(tabId);
      }
      try {
        openDetachedGenericWindow("terminal", tabId, detachedId, payload, title);
      } catch (err) {
        clearTerminalDetachPending(tabId);
        throw err;
      }
    },
    [openDetachedGenericWindow],
  );

  const openDetachedDatabase = useCallback(
    (tabId: string, info: NonNullable<Tab["db"]>, title: string) => {
      const detachedId = `${tabId}__detached`;
      const payload: DetachedDbParams = {
        title,
        // Give the detached window its own connection handle so the source
        // tab's unmount disconnect cannot race and close the detached query
        // workspace connection.
        info: {
          ...info,
          sessionId: detachedId,
          workspaceSessionId: info.workspaceSessionId ?? info.sessionId,
        },
      };
      openDetachedGenericWindow("database", tabId, detachedId, payload, title);
    },
    [openDetachedGenericWindow],
  );

  /**
   * Subscribe to reattach messages broadcast by detached windows. Each
   * time a detached window asks to come back, recreate the equivalent
   * tab in this window using the credential payload from the reattach
   * envelope. localStorage envelopes left behind by abrupt closes are
   * also drained on subscribe.
   */
  useEffect(() => {
    // Collapse a single close "burst" into one tab. Closing a detached
    // window can fan a reattach out across several transports/listeners
    // (BroadcastChannel + localStorage backstop, leaked onCloseRequested
    // listeners, beforeunload+pagehide double-fire). They all carry the
    // same (kind,id) within a few hundred ms, so a short per-(kind,id)
    // window dedupes them without blocking a legitimate later re-detach.
    const recentReattach = new Map<string, number>();
    const BURST_WINDOW_MS = 1500;
    const handle = (msg: ReattachMessage) => {
      const burstKey = `${msg.kind}.${msg.id}`;
      const now = Date.now();
      const last = recentReattach.get(burstKey);
      if (last !== undefined && now - last < BURST_WINDOW_MS) {
        clearReattachHandoff(msg.kind, msg.id);
        return;
      }
      recentReattach.set(burstKey, now);
      // Idempotent tab identity: derive the tab id from the detachedId so
      // the same window can never materialize two tabs. If a tab already
      // exists for this detachedId, just focus it.
      const reattachTabId = `${msg.kind}-reattach-${msg.id}`;
      if (tabsRef.current.some((t) => t.id === reattachTabId)) {
        setActiveTab(reattachTabId);
        clearReattachHandoff(msg.kind, msg.id);
        return;
      }
      switch (msg.kind) {
        case "rdp": {
          const p = msg.payload as DetachedRdpParams | undefined;
          if (!p?.host) return;
          addTab({
            id: reattachTabId,
            type: "rdp",
            title: p.title || `${p.host}:${p.port}`,
            sessionId: p.sessionId,
            closable: true,
            rdp: {
              sessionId: p.sessionId,
              host: p.host,
              port: p.port,
              username: p.username ?? undefined,
              password: p.password,
              options: p.options,
              networkSettingsJson: p.networkSettingsJson ?? null,
            },
          });
          setStatusMessage(tr("status.reattached"));
          break;
        }
        case "vnc": {
          const p = msg.payload as DetachedVncParams | undefined;
          if (!p?.host) return;
          addTab({
            id: reattachTabId,
            type: "vnc",
            title: p.title || `${p.host}:${p.port}`,
            sessionId: p.sessionId,
            closable: true,
            vnc: {
              sessionId: p.sessionId,
              host: p.host,
              port: p.port,
              username: p.username ?? undefined,
              password: p.password,
            },
          });
          setStatusMessage(tr("status.reattached"));
          break;
        }
        case "terminal": {
          const p = msg.payload as DetachedTerminalParams | undefined;
          if (!p) return;
          const adopted = p.reattach?.terminalSessionId
            ? {
                sessionId: p.reattach.terminalSessionId,
                snapshotText: p.reattach.snapshotText,
              }
            : undefined;
          addTab({
            id: reattachTabId,
            type: "terminal",
            title: p.title || tr("tabs.localTerminal"),
            closable: true,
            ssh: p.ssh ?? undefined,
            localShell: p.localShell ?? undefined,
            terminalProfile: p.terminalProfile ?? undefined,
            adoptedTerminal: adopted,
          });
          setStatusMessage(tr("status.reattached"));
          break;
        }
        case "database": {
          const p = msg.payload as DetachedDbParams | undefined;
          if (!p?.info) return;
          addTab({
            id: reattachTabId,
            type: "database",
            title: p.title || `${p.info.engine} ${p.info.host}`,
            sessionId: reattachTabId,
            closable: true,
            db: {
              ...p.info,
              sessionId: reattachTabId,
              workspaceSessionId: p.info.workspaceSessionId ?? p.info.sessionId,
            },
          });
          setStatusMessage(tr("status.reattached"));
          break;
        }
        default:
          /* SFTP reattach not wired — SFTP detach is co-existing, not exclusive. */
          break;
      }
      clearReattachHandoff(msg.kind, msg.id);
    };
    const unsub = subscribeReattach(handle);
    // Drain any envelopes left by detached windows that closed abruptly
    // before we subscribed.
    drainPendingReattach().forEach(handle);
    return unsub;
  }, [addTab, setActiveTab, setStatusMessage]);

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
    const chatBoundTabId =
      activeTab?.type === "terminal" || activeTab?.type === "rdp" || activeTab?.type === "database"
        ? activeTabId
        : null;
    void syncTabChatWithActiveTab(chatBoundTabId);
  }, [activeTabId, activeTab?.type, syncTabChatWithActiveTab]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    const panel = sidebarPanelRef.current;
    if (!panel) return;

    const frame = requestAnimationFrame(() => {
      if (compactMode || sidebarCollapsed || tabMaximizedId) {
        panel.collapse();
      } else {
        panel.resize(lastSidebarSizeRef.current);
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [compactMode, sidebarCollapsed, tabMaximizedId]);

  useEffect(() => {
    if (!compactMode) {
      setCompactSidebarOpen(false);
    }
  }, [compactMode]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        useServersStore.getState().openDialog();
        return;
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "m") {
        event.preventDefault();
        toggleCompactMode();
      }
      const primary = event.ctrlKey || event.metaKey;
      if (!primary || event.altKey || event.key.toLowerCase() !== "l") return;

      // Ctrl/Cmd+L: global AI Chat Drawer (no-op when fully_disabled).
      if (!event.shiftKey) {
        event.preventDefault();
        const aiOff = useAiStore.getState().config?.fully_disabled === true;
        if (!aiOff) void toggleGlobalChat();
        return;
      }

      // Ctrl/Cmd+Shift+L: current terminal tab's bound chat.
      if (event.shiftKey) {
        event.preventDefault();
        const aiOff = useAiStore.getState().config?.fully_disabled === true;
        const current = useAppStore.getState().tabs.find((tab) => tab.id === useAppStore.getState().activeTabId);
        if (!aiOff && current?.type === "terminal") void toggleTabChat(current.id);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleCompactMode, toggleGlobalChat, toggleTabChat]);

  // Hydrate server configs + statuses once on mount so the servers dialog
  // opens with persisted settings and live run state.
  useEffect(() => {
    void useServersStore.getState().loadAll();
  }, []);

  const confirmExitWithOpenTabs = useCallback(async () => {
    const currentTabs = tabsRef.current;
    const terminalCount = currentTabs.filter((tab) => tab.type === "terminal" && tab.closable).length;
    const tabCount = currentTabs.filter((tab) => tab.closable).length;
    if (tabCount === 0) return true;

    const isOne = tabCount === 1;
    let message: string;
    if (terminalCount > 0) {
      message = tr(isOne ? "exit.promptOneTerminal" : "exit.promptManyTerminals", {
        count: tabCount,
        terminals: terminalCount,
      });
    } else {
      message = tr(isOne ? "exit.promptOne" : "exit.promptMany", { count: tabCount });
    }
    return confirmAppExit({
      title: tr("ribbon.exit"),
      message,
      confirmLabel: tr("ribbon.exit"),
      danger: true,
    });
  }, [confirmAppExit]);

  const requestAppExit = useCallback(() => {
    if (exitRequestInFlightRef.current) return;
    exitRequestInFlightRef.current = true;
    void (async () => {
      try {
        if (await confirmExitWithOpenTabs()) {
          await exitApp();
        }
      } catch {
        // Keep exit failure non-fatal; the user stays in the app.
      } finally {
        exitRequestInFlightRef.current = false;
      }
    })();
  }, [confirmExitWithOpenTabs]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    void appWindow.onCloseRequested((event) => {
      event.preventDefault();
      requestAppExit();
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [requestAppExit]);

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
  ) => {
    const id = `local-${Date.now()}`;
    addTab({
      id,
      type: "terminal",
      title: title || tr("tabs.localTerminal"),
      sessionId,
      localShell,
      terminalProfile,
      closable: true,
    });
    if (sessionId) void markConnected(sessionId);
  }, [addTab, markConnected]);

  const handleEditSession = useCallback((session: SessionConfig) => {
    setEditingSession(session);
    setNewSessionGroupPath(null);
    setShowSessionEditor(true);
  }, []);

  const openSftpTab = useCallback((session: SessionConfig, authMethod: string, authData: string | null) => {
    const tabId = `sftp-${session.id}-${Date.now()}`;
    const ns = toNetworkSettingsPayload(getSessionNetworkSettings(session.options_json));
    addTab({
      id: tabId,
      type: "sftp",
      title: `${session.name || `${session.username ?? "user"}@${session.host}`} (SFTP)`,
      sessionId: session.id,
      closable: true,
      sftp: {
        sessionId: tabId,
        host: session.host,
        port: session.port,
        username: session.username ?? "root",
        authMethod,
        authData,
        networkSettingsJson: JSON.stringify(ns),
        attachedToTerminal: false,
      },
    });
    void markConnected(session.id);
  }, [addTab, markConnected]);

  const openVncTab = useCallback((session: SessionConfig, password?: string) => {
    const id = `vnc-${session.id}-${Date.now()}`;
    addTab({
      id,
      type: "vnc",
      title: session.name || `${session.host}:${session.port}`,
      sessionId: session.id,
      closable: true,
      vnc: {
        sessionId: session.id,
        host: session.host,
        port: session.port,
        username: session.username,
        password,
      },
    });
  }, [addTab]);

  const openRdpTab = useCallback((session: SessionConfig, password?: string) => {
    const id = `rdp-${session.id}-${Date.now()}`;
    const opts = parseRdpOptions(session.options_json);
    const ns = toNetworkSettingsPayload(getSessionNetworkSettings(session.options_json));
    addTab({
      id,
      type: "rdp",
      title: session.name || `${session.host}:${session.port}`,
      sessionId: session.id,
      closable: true,
      rdp: {
        sessionId: session.id,
        host: session.host,
        port: session.port,
        username: session.username,
        password,
        options: opts,
        networkSettingsJson: JSON.stringify(ns),
      },
    });
    void markConnected(session.id);
  }, [addTab, markConnected]);

  const openFileBrowserTab = useCallback((title: string, initialPath: string, sessionId?: string) => {
    const id = `file-${sessionId ?? "ad-hoc"}-${Date.now()}`;
    addTab({
      id,
      type: "file-browser",
      title,
      sessionId,
      closable: true,
      fileBrowser: { initialPath },
    });
  }, [addTab]);

  const openDbTab = useCallback((session: SessionConfig, password?: string) => {
    const engine = session.session_type as DbConnectInfo["engine"];
    const isRedis = engine === "Redis";
    const id = `${isRedis ? "redis" : "database"}-${session.id}-${Date.now()}`;
    const info = sessionToDbConnectInfo(session, password);
    const prestoPath = info.engine === "Presto"
      ? [info.catalog, info.database].filter(Boolean).join(".")
      : info.database;
    const title = `${engine} ${session.host}:${session.port}${prestoPath ? `/${prestoPath}` : ""}`;
    addTab({
      id,
      type: isRedis ? "redis" : "database",
      title,
      sessionId: session.id,
      closable: true,
      db: info,
    });
    void markConnected(session.id);
  }, [addTab, markConnected]);

  // Open a local path or URL: URLs and files always go to the system handler;
  // folders open in an embedded Taomni tab when `embedFolder` is true, otherwise
  // they fall through to the OS file manager via sftpOpenPath.
  const handleOpenLocalPath = useCallback(async (
    target: string,
    opts: { embedFolder?: boolean; title?: string; sessionId?: string } = {},
  ) => {
    const trimmed = target.trim();
    if (!trimmed) return;
    const isUrl = /^(https?|file|ftp):\/\//i.test(trimmed);
    if (isUrl) {
      try {
        await sftpOpenPath(trimmed);
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

  const openSshTab = useCallback((session: SessionConfig, authMethod: string, authData: string | null) => {
    const id = `ssh-${session.id}-${Date.now()}`;
    addTab({
      id,
      type: "terminal",
      title: session.name || `${session.username}@${session.host}`,
      sessionId: session.id,
      closable: true,
      ssh: {
        sessionId: session.id,
        host: session.host,
        port: session.port,
        username: session.username ?? "root",
        authMethod,
        authData,
        optionsJson: session.options_json,
      },
      terminalProfile: getSessionTerminalProfile(session.options_json),
    });
    void markConnected(session.id);
  }, [addTab, markConnected]);

  const openUnsupportedTab = useCallback((session: SessionConfig) => {
    const id = `${session.session_type.toLowerCase()}-${session.id}-${Date.now()}`;
    const kind = ["SFTP", "VNC"].includes(session.session_type)
      ? session.session_type.toLowerCase()
      : "placeholder";
    addTab({
      id,
      type: kind as "sftp" | "vnc" | "placeholder",
      title: session.name || session.host || session.session_type,
      sessionId: session.id,
      closable: true,
      message: `${session.session_type} connection UI is present, but its backend is outside Phase 1-2. Session data is saved and can be edited from the sidebar.`,
    });
  }, [addTab]);

  const queueVaultUnlock = useCallback((session: SessionConfig): ConnectQueueOutcome => {
    connectQueueRef.current.unshift(session);
    awaitingVaultUnlockRef.current = true;
    pendingVaultActionRef.current = () => {
      awaitingVaultUnlockRef.current = false;
      continueConnectQueueRef.current();
    };
    setVaultUnlockReason((current) => current ?? tr(SAVED_PASSWORD_VAULT_REASON_KEY));
    return "awaiting-vault";
  }, []);

  const openQueuedSession = useCallback((session: SessionConfig): ConnectQueueOutcome => {
    if (session.session_type === "SSH") {
      const { method, data } = resolveSessionAuth(session);
      if (method === "Password") {
        const ref = passwordRefFromOptions(session);
        if (ref) {
          const vaultState = useVaultStore.getState().state;
          if (vaultState !== "unlocked" && vaultState !== "empty") return queueVaultUnlock(session);
          openSshTab(session, "Password", ref);
        } else {
          awaitingManualAuthRef.current = true;
          setPendingAuth({ session });
          return "awaiting-auth";
        }
      } else {
        openSshTab(session, method, data);
      }
    } else if (session.session_type === "SFTP") {
      const { method, data } = resolveSessionAuth(session);
      if (method === "Password") {
        const ref = passwordRefFromOptions(session);
        if (ref) {
          const vaultState = useVaultStore.getState().state;
          if (vaultState !== "unlocked" && vaultState !== "empty") return queueVaultUnlock(session);
          openSftpTab(session, "Password", ref);
        } else {
          awaitingManualAuthRef.current = true;
          setPendingAuth({ session });
          return "awaiting-auth";
        }
      } else {
        openSftpTab(session, method, data);
      }
    } else if (session.session_type === "LocalShell") {
      openLocalTab(
        session.name || tr("tabs.localTerminal"),
        session.id,
        getSessionTerminalProfile(session.options_json),
        localShellSelectionFromSession(session),
      );
    } else if (session.session_type === "VNC") {
      const { method, data } = resolveSessionAuth(session);
      if (method === "Password") {
        const ref = passwordRefFromOptions(session);
        if (ref) {
          const vaultState = useVaultStore.getState().state;
          if (vaultState !== "unlocked" && vaultState !== "empty") return queueVaultUnlock(session);
          openVncTab(session, ref);
        } else {
          awaitingManualAuthRef.current = true;
          setPendingAuth({ session });
          return "awaiting-auth";
        }
      } else {
        openVncTab(session, data ?? undefined);
      }
    } else if (session.session_type === "RDP") {
      const { method, data } = resolveSessionAuth(session);
      if (method === "Password") {
        const ref = passwordRefFromOptions(session);
        if (ref) {
          const vaultState = useVaultStore.getState().state;
          if (vaultState !== "unlocked" && vaultState !== "empty") return queueVaultUnlock(session);
          openRdpTab(session, ref);
        } else {
          awaitingManualAuthRef.current = true;
          setPendingAuth({ session });
          return "awaiting-auth";
        }
      } else {
        openRdpTab(session, data ?? undefined);
      }
    } else if (session.session_type === "File") {
      openFileSession(session);
    } else if (
      session.session_type === "MySQL" ||
      session.session_type === "PostgreSQL" ||
      session.session_type === "ClickHouse" ||
      session.session_type === "Presto" ||
      session.session_type === "Redis"
    ) {
      // DB sessions store the password as a vault: ref in options_json. Many
      // databases (notably Redis / trust-auth Postgres) connect without one,
      // so a missing ref just means "no password" — we don't force a prompt.
      const ref = passwordRefFromOptions(session);
      if (ref) {
        const vaultState = useVaultStore.getState().state;
        if (vaultState !== "unlocked" && vaultState !== "empty") return queueVaultUnlock(session);
        openDbTab(session, ref);
      } else {
        openDbTab(session, undefined);
      }
    } else {
      openUnsupportedTab(session);
      void markConnected(session.id);
    }
    return "opened";
  }, [
    markConnected,
    openFileSession,
    openLocalTab,
    openSftpTab,
    openSshTab,
    openUnsupportedTab,
    openVncTab,
    openRdpTab,
    openDbTab,
    queueVaultUnlock,
  ]);

  const continueConnectQueue = useCallback(() => {
    if (connectQueueRunningRef.current || awaitingManualAuthRef.current || awaitingVaultUnlockRef.current) return;
    connectQueueRunningRef.current = true;
    try {
      while (connectQueueRef.current.length > 0) {
        const session = connectQueueRef.current.shift();
        if (!session) continue;
        const outcome = openQueuedSession(session);
        if (outcome !== "opened") return;
      }
    } finally {
      connectQueueRunningRef.current = false;
    }
  }, [openQueuedSession]);

  useEffect(() => {
    continueConnectQueueRef.current = continueConnectQueue;
  }, [continueConnectQueue]);

  const handleConnectSession = useCallback((session: SessionConfig) => {
    connectQueueRef.current.push(session);
    continueConnectQueue();
  }, [continueConnectQueue]);

  const handleAuthSubmit = useCallback(async (password: string, saveToVault: boolean) => {
    if (!pendingAuth) return;
    const session = pendingAuth.session;
    let credential: string = password;

    if (saveToVault) {
      try {
        const kind =
          session.session_type === "VNC"
            ? "vnc-password"
            : session.session_type === "RDP"
              ? "rdp-password"
              : "ssh-password";
        const label = `${session.username || "user"}@${session.host || "?"}:${session.port}`;
        const result = await vaultPut(kind, label, password);
        credential = result.reference;

        // Persist the vault reference back into options_json so future
        // connects find it without re-prompting.
        const opts = parseSessionOptions(session.options_json);
        const updated = JSON.stringify({ ...opts, passwordRef: result.reference });
        await updateSession({ ...session, options_json: updated });
      } catch (err) {
        if (isVaultLockedError(err)) {
          awaitingVaultUnlockRef.current = true;
          pendingVaultActionRef.current = () => {
            awaitingVaultUnlockRef.current = false;
            continueConnectQueueRef.current();
          };
          setVaultUnlockReason("Unlock the vault to save this password.");
        }
        // On any vault error, fall back to one-shot connect with the typed
        // plaintext — don't block the user.
        credential = password;
      }
    }

    if (session.session_type === "SFTP") {
      openSftpTab(session, "Password", credential);
    } else if (session.session_type === "VNC") {
      openVncTab(session, credential);
    } else if (session.session_type === "RDP") {
      openRdpTab(session, credential);
    } else {
      openSshTab(session, "Password", credential);
    }
    setPendingAuth(null);
    awaitingManualAuthRef.current = false;
    continueConnectQueueRef.current();
  }, [pendingAuth, openSftpTab, openSshTab, openVncTab, openRdpTab, updateSession]);

  const handleQuickConnect = useCallback((value: string) => {
    try {
      const parsed = parseQuickConnectInput(value);
      const session = parsed.config;
      if (session.session_type === "LocalShell") {
        openLocalTab(session.name);
      } else if (
        session.session_type === "SSH"
        || session.session_type === "SFTP"
        || session.session_type === "RDP"
      ) {
        if (session.auth_method === "Password") {
          awaitingManualAuthRef.current = true;
          setPendingAuth({ session });
        } else {
          const authMethod = typeof session.auth_method === "string" ? session.auth_method : "PrivateKey";
          if (session.session_type === "SFTP") {
            openSftpTab(session, authMethod, parsed.authData);
          } else if (session.session_type === "RDP") {
            openRdpTab(session, parsed.authData ?? undefined);
          } else {
            openSshTab(session, authMethod, parsed.authData);
          }
        }
      } else {
        openUnsupportedTab(session);
      }
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : String(err));
    }
  }, [openLocalTab, openRdpTab, openSftpTab, openSshTab, openUnsupportedTab, setStatusMessage]);

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

  const toggleQuickConnectVisible = useCallback(() => {
    const next = !quickConnectVisible;
    setQuickConnectVisible(next);
    writeQuickConnectVisible(next);
    setStatusMessage(tr(next ? "status.quickConnectShown" : "status.quickConnectHidden"));
  }, [quickConnectVisible, setStatusMessage]);

  const toggleRibbonVisible = useCallback(() => {
    const next = !ribbonVisible;
    setRibbonVisible(next);
    writeRibbonVisible(next);
    setStatusMessage(tr(next ? "status.ribbonShown" : "status.ribbonHidden"));
  }, [ribbonVisible, setStatusMessage]);

  const handleCommand = useCallback((command: RibbonCommand | "close-active" | "reload-sessions" | "toggle-quick-connect" | "toggle-ribbon") => {
    switch (command) {
      case "new-session":
        handleNewSession();
        break;
      case "new-sftp":
        handleNewSftpSession();
        break;
      case "new-terminal":
        openLocalTab();
        break;
      case "close-active":
        if (activeTab?.closable) removeTab(activeTab.id);
        break;
      case "reload-sessions":
        void loadSessions();
        setStatusMessage(tr("status.sessionsReloaded"));
        break;
      case "toggle-xserver":
        toggleXServer();
        break;
      case "view":
        if (compactMode) {
          setCompactSidebarOpen((open) => !open);
        } else {
          toggleSidebar();
        }
        break;
      case "toggle-compact":
        toggleCompactMode();
        break;
      case "toggle-quick-connect":
        toggleQuickConnectVisible();
        break;
      case "toggle-ribbon":
        toggleRibbonVisible();
        break;
      case "servers":
        useServersStore.getState().openDialog();
        break;
      case "sessions":
        if (compactMode) {
          setCompactSidebarOpen(true);
        } else {
          setSidebarCollapsed(false);
        }
        break;
      case "split":
        toggleTerminalSplit();
        break;
      case "multiexec":
        toggleMultiExec();
        break;
      case "exit":
        requestAppExit();
        break;
      case "tunneling": {
        const existing = tabsRef.current.find((tab) => tab.type === "nettools");
        if (existing) {
          setActiveTab(existing.id);
        } else {
          addTab({
            id: "nettools-tunnels",
            type: "nettools",
            title: t("tunnels.title"),
            closable: true,
          });
        }
        break;
      }
      case "tools":
        openPlaceholderTab(t("tabs.networkTools"), t("status.commandUnavailable"));
        break;
      case "packages":
        openPlaceholderTab(t("tabs.packages"), t("status.commandUnavailable"));
        break;
      case "settings":
        openSettingsTab();
        break;
      case "macros":
        openPlaceholderTab(t("tabs.macros"), t("status.commandUnavailable"));
        break;
      case "help":
        setShowAbout(true);
        break;
      default:
        setStatusMessage(tr("status.commandUnavailable"));
    }
  }, [
    activeTab,
    compactMode,
    handleNewSession,
    handleNewSftpSession,
    loadSessions,
    openLocalTab,
    openPlaceholderTab,
    openSettingsTab,
    removeTab,
    requestAppExit,
    setActiveTab,
    setStatusMessage,
    setSidebarCollapsed,
    toggleQuickConnectVisible,
    toggleRibbonVisible,
    toggleCompactMode,
    toggleTerminalSplit,
    toggleSidebar,
    toggleXServer,
  ]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const tabIndex = macCommandDigitIndex(event);
      if (tabIndex !== null) {
        event.preventDefault();
        event.stopPropagation();

        const state = useAppStore.getState();
        const target = tabIndex === -1 ? state.tabs.at(-1) : state.tabs[tabIndex];
        if (target && target.id !== state.activeTabId) {
          setActiveTab(target.id);
        }
        return;
      }

      const primary = event.ctrlKey || event.metaKey;
      if (!primary || !event.shiftKey || event.altKey) return;

      const key = event.key.toLowerCase();
      if (key !== "t" && key !== "n") return;

      if (key === "t") {
        event.preventDefault();
        event.stopPropagation();
        handleCommand("new-terminal");
        return;
      }

      const state = useAppStore.getState();
      const current = state.tabs.find((tab) => tab.id === state.activeTabId);
      if (current?.type === "welcome") {
        event.preventDefault();
        event.stopPropagation();
        handleCommand("new-session");
      }
    };

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [handleCommand, setActiveTab]);

  const terminalTabs = tabs.filter((t) => t.type === "terminal");
  const sftpTabs = tabs.filter((t) => t.type === "sftp" && t.sftp);
  const vncTabs = tabs.filter((t) => t.type === "vnc" && t.vnc);
  const rdpTabs = tabs.filter((t) => t.type === "rdp" && t.rdp);
  const fileBrowserTabs = tabs.filter((t) => t.type === "file-browser" && t.fileBrowser);
  const dbTabs = tabs.filter((t) => t.type === "database" && t.db);
  const redisTabs = tabs.filter((t) => t.type === "redis" && t.db);
  const terminalSplitVisible =
    terminalSplitActive && terminalTabs.length > 0 && activeTab?.type === "terminal";
  const effectiveMultiExecSelectedCount = terminalSplitActive
    ? [...multiExecSelectedTabIds].filter((id) => !terminalSplitInputLockedTabIds.has(id)).length
    : multiExecSelectedTabIds.size;
  const splitGridColumns = Math.max(1, Math.ceil(Math.sqrt(terminalTabs.length)));
  const splitGridRows = Math.max(1, Math.ceil(terminalTabs.length / splitGridColumns));
  const splitPaneWeightsForTabs = useMemo(
    () => terminalTabs.map((tab) => positiveWeight(splitPaneWeights[tab.id])),
    [splitPaneWeights, terminalTabs],
  );
  const splitGridColumnWeightsForLayout = useMemo(
    () => axisWeights(splitGridColumnWeights, splitGridColumns),
    [splitGridColumnWeights, splitGridColumns],
  );
  const splitGridRowWeightsForLayout = useMemo(
    () => axisWeights(splitGridRowWeights, splitGridRows),
    [splitGridRowWeights, splitGridRows],
  );
  const splitGridColumnTemplate = weightsToGridTemplate(splitGridColumnWeightsForLayout);
  const splitGridRowTemplate = weightsToGridTemplate(splitGridRowWeightsForLayout);
  const terminalPanesClass = terminalSplitVisible
    ? terminalSplitLayout === "horizontal"
      ? "flex-1 min-h-0 flex flex-row relative"
      : terminalSplitLayout === "vertical"
        ? "flex-1 min-h-0 flex flex-col relative"
        : "flex-1 min-h-0 grid relative"
    : "contents";

  const startLinearSplitResize = useCallback((
    index: number,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (!terminalSplitVisible || terminalSplitLayout === "grid") return;
    const container = splitPanesRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const horizontal = terminalSplitLayout === "horizontal";
    const dimension = horizontal ? rect.width : rect.height;
    if (dimension <= 0) return;

    event.preventDefault();
    event.stopPropagation();

    const ids = terminalTabs.map((tab) => tab.id);
    const initialWeights = ids.map((id) => positiveWeight(splitPaneWeights[id]));
    const totalWeight = sumWeights(initialWeights);
    const startCoord = horizontal ? event.clientX : event.clientY;

    const handleMove = (moveEvent: PointerEvent) => {
      const currentCoord = horizontal ? moveEvent.clientX : moveEvent.clientY;
      const deltaWeight = ((currentCoord - startCoord) / dimension) * totalWeight;
      const nextWeights = resizeAdjacentWeights(initialWeights, index, deltaWeight);
      setSplitPaneWeights((prev) => {
        const next = { ...prev };
        ids.forEach((id, weightIndex) => {
          next[id] = nextWeights[weightIndex];
        });
        return next;
      });
    };

    const stop = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }, [splitPaneWeights, terminalSplitLayout, terminalSplitVisible, terminalTabs]);

  const startGridSplitResize = useCallback((
    axis: "column" | "row",
    index: number,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (!terminalSplitVisible || terminalSplitLayout !== "grid") return;
    const container = splitPanesRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const dimension = axis === "column" ? rect.width : rect.height;
    if (dimension <= 0) return;

    event.preventDefault();
    event.stopPropagation();

    const initialWeights = axis === "column"
      ? splitGridColumnWeightsForLayout
      : splitGridRowWeightsForLayout;
    const totalWeight = sumWeights(initialWeights);
    const startCoord = axis === "column" ? event.clientX : event.clientY;

    const handleMove = (moveEvent: PointerEvent) => {
      const currentCoord = axis === "column" ? moveEvent.clientX : moveEvent.clientY;
      const deltaWeight = ((currentCoord - startCoord) / dimension) * totalWeight;
      const nextWeights = resizeAdjacentWeights(initialWeights, index, deltaWeight);
      if (axis === "column") {
        setSplitGridColumnWeights(nextWeights);
      } else {
        setSplitGridRowWeights(nextWeights);
      }
    };

    const stop = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }, [
    splitGridColumnWeightsForLayout,
    splitGridRowWeightsForLayout,
    terminalSplitLayout,
    terminalSplitVisible,
  ]);

  const isTabMaximized =
    !!tabMaximizedId &&
    tabMaximizedId === activeTabId &&
    tabs.some((t) => t.id === tabMaximizedId);
  const chromeHidden = isTabMaximized;

  return (
    <div
      data-compact-mode={compactMode}
      data-tab-maximized={isTabMaximized ? "true" : undefined}
      className={`relative w-full h-full flex flex-col${compactMode ? " taomni-compact-root" : ""}`}
      style={{ background: "var(--taomni-chrome-bg)" }}
    >
      <WindowResizeHandles />
      {!compactMode && !chromeHidden && <AppTitleBar onClose={requestAppExit} />}
      {!compactMode && !chromeHidden && (
        <>
          <MenuBar
            activeTabClosable={!!activeTab?.closable}
            ribbonVisible={ribbonVisible}
            quickConnectVisible={quickConnectVisible}
            onCommand={handleCommand}
          />
          {ribbonVisible && (
            <Ribbon
              xServerEnabled={xServerEnabled}
              splitActive={terminalSplitActive}
              onCommand={handleCommand}
            />
          )}
          {quickConnectVisible && (
            <QuickConnect
              onConnectInput={handleQuickConnect}
              onConnectSession={handleConnectSession}
              onHome={() => setActiveTab("welcome")}
            />
          )}
        </>
      )}
      {compactMode && !chromeHidden && (
        <CompactTitleBar
          activeTabClosable={!!activeTab?.closable}
          onCommand={handleCommand}
          onToggleSidebarDrawer={() => setCompactSidebarOpen((open) => !open)}
          onStartLocalTerminal={(localShell) =>
            openLocalTab(localShell?.name ?? tr("tabs.localTerminal"), undefined, undefined, localShell)
          }
          onConnectSession={handleConnectSession}
          onOpenSessionEditor={() => handleNewSession()}
          onCloseWindow={requestAppExit}
        />
      )}

      <div className="flex-1 flex min-h-0">
        {!compactMode && !chromeHidden && sidebarCollapsed && (
          <div data-testid="collapsed-sidebar-rail" className="h-full w-[26px] shrink-0 overflow-hidden">
            <Sidebar
              compact
              onNewSession={handleNewSession}
              onNewSftpSession={handleNewSftpSession}
              onEditSession={handleEditSession}
              onConnectSession={handleConnectSession}
            />
          </div>
        )}

        <PanelGroup direction="horizontal" autoSaveId="main-layout" className="flex-1 min-w-0">
          <Panel
            ref={sidebarPanelRef}
            defaultSize={22}
            minSize={15}
            maxSize={40}
            collapsible
            collapsedSize={0}
            onCollapse={() => {
              if (!compactMode) setSidebarCollapsed(true);
            }}
            onExpand={() => {
              if (!compactMode && !chromeHidden) setSidebarCollapsed(false);
            }}
            onResize={(size) => {
              if (size > 2) {
                lastSidebarSizeRef.current = size;
              }
            }}
          >
            <div className="h-full overflow-hidden" style={compactMode || sidebarCollapsed || chromeHidden ? { display: "none" } : undefined}>
              <Sidebar
                compact={compactMode}
                onNewSession={handleNewSession}
                onNewSftpSession={handleNewSftpSession}
                onEditSession={handleEditSession}
                onConnectSession={handleConnectSession}
              />
            </div>
          </Panel>

          <PanelResizeHandle
            data-testid="main-sidebar-resize-handle"
            className={compactMode || sidebarCollapsed || chromeHidden ? "hidden" : "w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize"}
          />

          <Panel>
            <div className="h-full flex flex-col min-w-0">
              {!compactMode && !chromeHidden && (
                <TabBar
                  onStartLocalTerminal={(localShell) =>
                    openLocalTab(localShell?.name ?? tr("tabs.localTerminal"), undefined, undefined, localShell)
                  }
                  onConnectSession={handleConnectSession}
                  onOpenSessionEditor={() => handleNewSession()}
                />
              )}              {multiExecActive && (
                <MultiExecBar
                  selectedCount={effectiveMultiExecSelectedCount}
                  totalTerminalCount={tabs.filter((t) => t.type === "terminal").length}
                  onSend={broadcastToSelectedTerminals}
                  onSelectAll={selectAllTerminalTabs}
                  onClearSelection={clearMultiExecSelection}
                  onClose={toggleMultiExec}
                />
              )}
              <div className="flex-1 min-h-0 overflow-hidden relative">
                {/* Welcome panel */}
                {(activeTab?.type === "welcome" || !activeTab) && (
                  <WelcomePanel
                    onStartLocalTerminal={(localShell) => openLocalTab(localShell?.name ?? tr("tabs.localTerminal"), undefined, undefined, localShell)}
                    onNewSession={handleNewSession}
                    onOpenLocalPath={(path, opts) => void handleOpenLocalPath(path, opts)}
                  />
                )}

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
                      const liveTerminalProfile = tab.sessionId
                        ? terminalProfilesBySessionId.get(tab.sessionId) ?? tab.terminalProfile
                        : tab.terminalProfile;
                      const terminalNode = (
                        <div className="h-full w-full relative">
                          <TerminalPanel
                            tabId={tab.id}
                            tabTitle={tab.title}
                            ssh={tab.ssh}
                            localShell={tab.localShell}
                            terminalProfile={liveTerminalProfile}
                            adoptedTerminal={tab.adoptedTerminal}
                            visible={terminalSplitVisible || isActive}
                            activeForShortcuts={isActive}
                            inputLocked={inputLocked}
                            onCwdChange={tab.ssh ? (cwd) => handleTerminalCwd(tab.id, cwd) : undefined}
                            cwdRequestToken={terminalCwdRequestTokens[tab.id] ?? 0}
                            onSessionReady={(sid) => { terminalSessionIds.current[tab.id] = sid; }}
                            onOutput={() => handleTerminalOutput(tab.id)}
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
                            sftpToggle={!terminalSplitVisible && tab.ssh ? { open: sidebarOpen, onToggle: () => toggleAttachedSidebar(tab.id) } : undefined}
                            chatToggle={!terminalSplitVisible ? {
                              open: chatDrawerOpen && chatDrawerScope === "tab" && chatDrawerTabId === tab.id,
                              onToggle: () => void toggleTabChat(tab.id),
                            } : undefined}
                            detachToggle={!terminalSplitVisible ? {
                              onDetach: () => openDetachedTerminal(tab.id, tab, tab.title),
                            } : undefined}
                            maximizeToggle={!terminalSplitVisible ? {
                              maximized: tabMaximizedId === tab.id,
                              onToggle: () => toggleTabMaximized(tab.id),
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
                          onOpenTerminalHere={(p) => {
                            const sid = terminalSessionIds.current[tab.id];
                            if (!sid) return;
                            const escaped = p.replace(/'/g, "'\\''");
                            void writeTerminal(sid, encodeBase64(`cd '${escaped}'\n`));
                          }}
                          onDetach={() =>
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
                            )
                          }
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
                              direction="horizontal"
                              autoSaveId={`terminal-sftp-${tab.id}`}
                            >
                              <Panel defaultSize={62} minSize={25} className="min-w-0">
                                <div className="h-full">{terminalNode}</div>
                              </Panel>
                              {sftpSidebarNode && (
                                <>
                                  <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize" />
                                  <Panel
                                    defaultSize={38}
                                    minSize={20}
                                    maxSize={70}
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
                        detachable
                        onDetach={() => openDetachedSftp(tab.sftp!, tab.title)}
                      />
                    </div>
                  );
                })}

                {activeTab?.type === "settings" && <SettingsPanel />}

                {/* VNC tabs — always mounted so connection survives tab switches */}
                {vncTabs.map((tab) => {
                  if (!tab.vnc) return null;
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
                          host={tab.vnc.host}
                          port={tab.vnc.port}
                          username={tab.vnc.username}
                          password={tab.vnc.password}
                          visible={isActive}
                          onDetach={() => openDetachedVnc(tab.id, tab.vnc!, tab.title)}
                          onToggleMaximize={() => toggleTabMaximized(tab.id)}
                          maximized={tabMaximizedId === tab.id}
                        />
                      </Suspense>
                    </div>
                  );
                })}

                {/* RDP tabs — always mounted so the WS relay stays alive across tab switches */}
                {rdpTabs.map((tab) => {
                  if (!tab.rdp) return null;
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
                          host={tab.rdp.host}
                          port={tab.rdp.port}
                          username={tab.rdp.username}
                          password={tab.rdp.password}
                          options={tab.rdp.options}
                          networkSettingsJson={tab.rdp.networkSettingsJson}
                          visible={isActive}
                          onDetach={() => openDetachedRdp(tab.id, tab.rdp!, tab.title)}
                          onToggleMaximize={() => toggleTabMaximized(tab.id)}
                          maximized={tabMaximizedId === tab.id}
                          chatToggle={!aiFullyDisabled ? {
                            open: chatDrawerOpen && chatDrawerScope === "tab" && chatDrawerTabId === tab.id,
                            onToggle: () => void toggleTabChat(tab.id),
                          } : undefined}
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
                          onDetach={() => openDetachedDatabase(tab.id, tab.db!, tab.title)}
                          onToggleMaximize={() => toggleTabMaximized(tab.id)}
                          maximized={tabMaximizedId === tab.id}
                          chatToggle={!aiFullyDisabled ? {
                            open: chatDrawerOpen && chatDrawerScope === "tab" && chatDrawerTabId === tab.id,
                            onToggle: () => void toggleTabChat(tab.id),
                          } : undefined}
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
                        <RedisClientTab tabId={tab.id} info={tab.db} visible={isActive} />
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
                  activeTab.type !== "file-browser" &&
                  activeTab.type !== "database" &&
                  activeTab.type !== "redis" &&
                  activeTab.type !== "settings" &&
                  activeTab.type !== "nettools" && (
                  <UnavailablePanel title={activeTab.title} message={activeTab.message} />
                )}

                {/* Maximized tabs no longer need a standalone restore button.
                    Terminal, VNC and RDP panels each expose a maximize/restore
                    toggle in their own floating toolbar (which can also be
                    dragged to any screen edge when hidden), so the redundant
                    top-right affordance has been removed for parity. */}
              </div>
            </div>
          </Panel>
        </PanelGroup>
        {chatDrawerOpen && !aiFullyDisabled && <ChatDrawer />}
      </div>

      {!compactMode && !chromeHidden && <StatusBar />}

      {compactMode && compactSidebarOpen && (
        <CompactSidebarDrawer
          onClose={() => setCompactSidebarOpen(false)}
          onNewSession={handleNewSession}
          onNewSftpSession={handleNewSftpSession}
          onEditSession={handleEditSession}
          onConnectSession={(session) => {
            setCompactSidebarOpen(false);
            handleConnectSession(session);
          }}
        />
      )}

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
          host={pendingAuth.session.host}
          username={pendingAuth.session.username ?? "root"}
          onSubmit={handleAuthSubmit}
          onCancel={() => {
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

      <ServersDialog />
      {appExitConfirmDialog}
    </div>
  );
}

function positiveWeight(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 1;
}

function axisWeights(weights: number[], count: number): number[] {
  return Array.from({ length: count }, (_, index) => positiveWeight(weights[index]));
}

function sumWeights(weights: number[]): number {
  return weights.reduce((sum, weight) => sum + positiveWeight(weight), 0) || 1;
}

function resizeAdjacentWeights(weights: number[], index: number, deltaWeight: number): number[] {
  const next = weights.map(positiveWeight);
  if (index < 0 || index >= next.length - 1) return next;

  const left = next[index];
  const right = next[index + 1];
  const minDelta = MIN_SPLIT_WEIGHT - left;
  const maxDelta = right - MIN_SPLIT_WEIGHT;
  const clampedDelta = Math.max(minDelta, Math.min(maxDelta, deltaWeight));
  next[index] = left + clampedDelta;
  next[index + 1] = right - clampedDelta;
  return next;
}

function weightsToGridTemplate(weights: number[]): string {
  return weights.map((weight) => `minmax(0, ${positiveWeight(weight)}fr)`).join(" ");
}

function cumulativeWeightPercent(weights: number[], index: number): number {
  const total = sumWeights(weights);
  const before = weights
    .slice(0, index + 1)
    .reduce((sum, weight) => sum + positiveWeight(weight), 0);
  return total > 0 ? (before / total) * 100 : 0;
}

function TerminalSplitToolbar({
  layout,
  lockedCount,
  onLayoutChange,
  onClearLocks,
  onClose,
}: {
  layout: TerminalSplitLayout;
  lockedCount: number;
  onLayoutChange: (layout: TerminalSplitLayout) => void;
  onClearLocks: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const options: Array<{ id: TerminalSplitLayout; label: string; icon: ReactNode }> = [
    { id: "horizontal", label: t("terminalSplit.horizontal"), icon: <Columns2 className="w-3.5 h-3.5" /> },
    { id: "vertical", label: t("terminalSplit.vertical"), icon: <Rows3 className="w-3.5 h-3.5" /> },
    { id: "grid", label: t("terminalSplit.grid"), icon: <Grid2X2 className="w-3.5 h-3.5" /> },
  ];

  return (
    <div
      data-testid="terminal-split-toolbar"
      className="h-8 shrink-0 flex items-center gap-1 px-2"
      style={{
        background: "var(--taomni-chrome-bg)",
        borderBottom: "1px solid var(--taomni-divider)",
      }}
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          data-testid={`terminal-split-layout-${option.id}`}
          aria-label={option.label}
          title={option.label}
          data-active={layout === option.id || undefined}
          className="h-6 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
          style={layout === option.id ? { background: "var(--taomni-selected)", color: "var(--taomni-accent)" } : undefined}
          onClick={() => onLayoutChange(option.id)}
        >
          {option.icon}
        </button>
      ))}
      <span className="taomni-pill ml-1" style={{ fontSize: 11 }}>
        {t("terminalSplit.locked", { count: lockedCount })}
      </span>
      <button
        type="button"
        className="text-[11px] px-1.5 py-0.5 rounded hover:bg-[var(--taomni-hover)] disabled:opacity-40"
        style={{ color: "var(--taomni-text-muted)" }}
        disabled={lockedCount === 0}
        onClick={onClearLocks}
      >
        {t("terminalSplit.clearLocks")}
      </button>
      <div className="flex-1" />
      <button
        type="button"
        aria-label={t("terminalSplit.closeView")}
        title={t("terminalSplit.closeView")}
        className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
        onClick={onClose}
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function CompactSidebarDrawer({
  onClose,
  onNewSession,
  onNewSftpSession,
  onEditSession,
  onConnectSession,
}: {
  onClose: () => void;
  onNewSession: (groupPath?: string | null) => void;
  onNewSftpSession: () => void;
  onEditSession: (session: SessionConfig) => void;
  onConnectSession: (session: SessionConfig) => void;
}) {
  const t = useT();
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div data-testid="compact-sidebar-drawer" className="absolute inset-x-0 top-8 bottom-0 z-[1200] pointer-events-none">
      <button
        type="button"
        aria-label={t("sidebar.closeDrawer")}
        className="absolute inset-0 bg-black/10 pointer-events-auto"
        onClick={onClose}
      />
      <div
        className="absolute left-0 top-0 bottom-0 w-[min(380px,calc(100vw-44px))] pointer-events-auto shadow-xl"
        style={{
          background: "var(--taomni-sidebar-bg)",
          borderRight: "1px solid var(--taomni-sidebar-border)",
        }}
      >
        <div
          className="h-7 flex items-center px-2 border-b text-[12px] font-semibold"
          style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
        >
          {t("sidebar.headerTitle")}
          <button
            type="button"
            title={t("sidebar.closeDrawer")}
            aria-label={t("sidebar.closeDrawer")}
            className="ml-auto h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
            onClick={onClose}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="absolute left-0 right-0 top-7 bottom-0">
          <Sidebar
            compact={false}
            onNewSession={onNewSession}
            onNewSftpSession={onNewSftpSession}
            onEditSession={onEditSession}
            onConnectSession={onConnectSession}
          />
        </div>
      </div>
    </div>
  );
}

function VncLoadingPanel() {
  const t = useT();
  return (
    <div
      className="w-full h-full flex items-center justify-center text-sm"
      style={{ background: "var(--taomni-term-bg)", color: "var(--taomni-term-text)" }}
    >
      {t("vnc.loading")}
    </div>
  );
}

function RdpLoadingPanel() {
  const t = useT();
  return (
    <div
      className="w-full h-full flex items-center justify-center text-sm"
      style={{ background: "var(--taomni-term-bg)", color: "var(--taomni-term-text)" }}
    >
      {t("rdp.loading")}
    </div>
  );
}

function DbLoadingPanel() {
  return (
    <div
      className="w-full h-full flex items-center justify-center text-sm"
      style={{ background: "var(--taomni-bg)", color: "var(--taomni-text-muted)" }}
    >
      Loading database client…
    </div>
  );
}

function UnavailablePanel({ title, message }: { title: string; message?: string }) {
  const t = useT();
  return (
    <div
      className="w-full h-full flex items-center justify-center text-sm p-6"
      style={{ background: "var(--taomni-term-bg)", color: "var(--taomni-term-text)" }}
    >
      <div className="max-w-md text-center">
        <div className="text-lg font-semibold mb-2">{title}</div>
        <div className="text-[12px] text-slate-300">
          {message ?? t("status.commandUnavailable")}
        </div>
      </div>
    </div>
  );
}
