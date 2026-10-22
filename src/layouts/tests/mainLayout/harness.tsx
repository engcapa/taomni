import { forwardRef, useEffect, useImperativeHandle } from "react";
import { vi } from "vitest";
import { type SessionConfig } from "../../../lib/ipc";
import { type TerminalProfile } from "../../../lib/terminalProfile";

const terminalLifecycle = vi.hoisted(() => ({
  mounted: vi.fn(),
  unmounted: vi.fn(),
}));

const terminalPanelMock = vi.hoisted(() => ({
  props: [] as Array<{
    tabId?: string;
    terminalProfile?: TerminalProfile;
    onTerminalProfileChange?: (profile: TerminalProfile) => void;
    onUploadLocalPaths?: (request: { paths: string[]; cwd: string | null; }) => Promise<void>;
    onCwdChange?: (cwd: string) => void;
    sftpToggle?: unknown;
    chatToggle?: unknown;
  }>,
}));

const sidebarMock = vi.hoisted(() => ({
  props: [] as Array<{
    onConnectSession?: (session: SessionConfig) => void;
    onOpenSettings?: () => void;
  }>,
}));

const quickConnectMock = vi.hoisted(() => ({
  props: [] as Array<{
    onConnectInput?: (value: string) => void;
    onConnectSession?: (session: SessionConfig) => void;
  }>,
}));

const controlBarMock = vi.hoisted(() => ({
  props: [] as Array<{
    onDuplicateTab?: (id: string) => void;
    onDetachActiveTab?: () => void;
  }>,
}));

const dbClientMock = vi.hoisted(() => ({
  props: [] as Array<{ tabId?: string; info?: Record<string, unknown>; visible?: boolean; }>,
}));

const hbaseShellMock = vi.hoisted(() => ({
  props: [] as Array<{ tabId?: string; info?: Record<string, unknown>; visible?: boolean; }>,
}));

const sftpSidebarMock = vi.hoisted(() => ({
  props: [] as any[],
}));

const vaultMock = vi.hoisted(() => {
  const mock = {
    state: "empty",
    refresh: vi.fn(async () => undefined),
    unlock: vi.fn(async () => undefined),
  };
  mock.unlock.mockImplementation(async () => {
    mock.state = "unlocked";
  });
  return mock;
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: vi.fn(async () => vi.fn()),
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/event", () => import("../../../stubs/tauri-event"));

export type MockPanelSize = { asPercentage: number; inPixels: number; };

const panelResizeMock = vi.hoisted(() => ({
  handlers: new Map<string, (size: MockPanelSize, id: string | undefined, prev: MockPanelSize | undefined) => void>(),
}));

vi.mock("react-resizable-panels", () => {
  const Group = ({ children, className }: { children: React.ReactNode; className?: string; }) => (
    <div className={className} data-testid="panel-group">{children}</div>
  );
  const Panel = forwardRef<unknown, {
    children: React.ReactNode;
    panelRef?: React.Ref<unknown>;
    id?: string;
    onResize?: (size: MockPanelSize, id: string | undefined, prev: MockPanelSize | undefined) => void;
  }>(({ children, panelRef, id, onResize }, ref) => {
    if (id && onResize) panelResizeMock.handlers.set(id, onResize);
    const handle = {
      collapse: vi.fn(),
      resize: vi.fn(),
    };
    useImperativeHandle(ref, () => handle);
    useImperativeHandle(panelRef, () => handle);
    return <div data-testid="panel">{children}</div>;
  });
  const Separator = ({ className, "data-testid": testId }: React.HTMLAttributes<HTMLDivElement> & { "data-testid"?: string; }) => (
    <div className={className} data-testid={testId ?? "panel-resize-handle"} />
  );
  return {
    Group,
    Panel,
    Separator,
    PanelGroup: Group,
    PanelResizeHandle: Separator,
  };
});

vi.mock("../../../components/tabbar/ControlBar", () => ({
  ControlBar: ({
    onCommand,
    onCloseWindow,
    onDuplicateTab,
    onDetachActiveTab,
    onToggleSidebar,
    slotRef,
  }: {
    onCommand?: (command: string) => void;
    onCloseWindow?: () => void;
    onDuplicateTab?: (id: string) => void;
    onDetachActiveTab?: () => void;
    onToggleSidebar?: () => void;
    slotRef?: (el: HTMLDivElement | null) => void;
  }) => {
    controlBarMock.props.push({ onDuplicateTab, onDetachActiveTab });
    return (
      <div data-testid="control-bar">
        <button type="button" data-testid="window-close" onClick={() => onCloseWindow?.()}>
          Close
        </button>
        <button type="button" data-testid="mock-menu-exit" onClick={() => onCommand?.("exit")}>
          Exit
        </button>
        <button type="button" data-testid="mock-sidebar-toggle" onClick={() => onToggleSidebar?.()}>
          Sidebar
        </button>
        <div ref={slotRef} data-testid="tab-action-slot" />
      </div>
    );
  },
}));

vi.mock("../../../components/quickconnect/QuickConnect", () => ({
  QuickConnect: (props: {
    onConnectInput?: (value: string) => void;
    onConnectSession?: (session: SessionConfig) => void;
  }) => {
    quickConnectMock.props.push(props);
    return <div data-testid="quick-connect" />;
  },
}));

vi.mock("../../../components/sidebar/Sidebar", () => ({
  Sidebar: (props: {
    onConnectSession?: (session: SessionConfig) => void;
    onOpenSettings?: () => void;
  }) => {
    sidebarMock.props.push(props);
    return (
      <div data-testid="sidebar">
        <button type="button" data-testid="ribbon-settings" onClick={props.onOpenSettings}>
          Settings
        </button>
      </div>
    );
  },
}));

vi.mock("../../../components/settings/SettingsPanel", () => ({
  SettingsPanel: () => <div data-testid="settings-panel" />,
}));

vi.mock("../../../components/statusbar/StatusBar", () => ({
  StatusBar: () => <div data-testid="status-bar" />,
}));

vi.mock("../../../components/terminal/TerminalPanel", () => ({
  TerminalPanel: ({
    tabId,
    commandTerminal,
    terminalProfile,
    onTerminalProfileChange,
    sftpToggle,
    chatToggle,
    visible,
    activeForShortcuts,
    inputLocked,
    onSessionReady,
    onUploadLocalPaths,
    onCwdChange,
  }: {
    tabId?: string;
    commandTerminal?: {
      kind: string;
      host: string;
      port: number;
      username?: string | null;
      optionsJson?: string | null;
    };
    terminalProfile?: TerminalProfile;
    sftpToggle?: { open: boolean; onToggle: () => void; };
    chatToggle?: { open: boolean; onToggle: () => void; };
    visible?: boolean;
    activeForShortcuts?: boolean;
    inputLocked?: boolean;
    onSessionReady?: (sessionId: string) => void;
    onTerminalProfileChange?: (profile: TerminalProfile) => void;
    onUploadLocalPaths?: (request: { paths: string[]; cwd: string | null; }) => Promise<void>;
    onCwdChange?: (cwd: string) => void;
  }) => {
    terminalPanelMock.props.push({ tabId, terminalProfile, onTerminalProfileChange, onUploadLocalPaths, onCwdChange, sftpToggle, chatToggle });
    useEffect(() => {
      terminalLifecycle.mounted();
      onSessionReady?.(`session-${tabId ?? "terminal"}`);
      return () => terminalLifecycle.unmounted();
    }, []);
    return (
      <div
        data-testid="terminal-panel"
        data-tab-id={tabId}
        data-visible={visible ? "true" : "false"}
        data-active-shortcuts={activeForShortcuts ? "true" : "false"}
        data-input-locked={inputLocked ? "true" : "false"}
        data-command-kind={commandTerminal?.kind ?? ""}
        data-command-host={commandTerminal?.host ?? ""}
        data-command-port={commandTerminal?.port ?? ""}
        data-command-username={commandTerminal?.username ?? ""}
        data-terminal-font-size={terminalProfile?.fontSize ?? ""}
        data-terminal-theme={terminalProfile?.theme ?? ""}
      >
        <button
          type="button"
          data-testid={`mock-terminal-profile-change-${tabId ?? "terminal"}`}
          onClick={() => onTerminalProfileChange?.({
            ...terminalProfile!,
            fontSize: 21,
            theme: "kanagawa-wave",
          })}
        >
          Profile
        </button>
        {sftpToggle && (
          <button
            type="button"
            data-testid="attached-sftp-toggle"
            onClick={sftpToggle.onToggle}
          >
            SFTP
          </button>
        )}
        {chatToggle && (
          <button
            type="button"
            data-testid="tab-chat-toggle"
            onClick={chatToggle.onToggle}
          >
            Chat
          </button>
        )}
      </div>
    );
  },
}));

vi.mock("../../../components/rdp/RdpPanel", () => ({
  default: ({
    host,
    port,
    username,
    password,
  }: {
    host: string;
    port: number;
    username?: string | null;
    password?: string;
  }) => (
    <div
      data-testid="rdp-panel"
      data-host={host}
      data-port={port}
      data-username={username ?? ""}
      data-password={password ?? ""}
    />
  ),
}));

vi.mock("../../../components/vnc/VncPanel", () => ({
  default: ({
    host,
    port,
    username,
    password,
  }: {
    host: string;
    port: number;
    username?: string | null;
    password?: string;
  }) => (
    <div
      data-testid="vnc-panel"
      data-host={host}
      data-port={port}
      data-username={username ?? ""}
      data-password={password ?? ""}
    />
  ),
}));

vi.mock("../../../components/filebrowser/SftpSidebar", () => ({
  SftpSidebar: (props: any) => {
    sftpSidebarMock.props.push(props);
    return (
      <div data-testid="sftp-sidebar">
        <button data-testid="sftp-mock-close" onClick={props.onClose}>Close</button>
        <button data-testid="sftp-mock-detach" onClick={props.onDetach}>Detach</button>
      </div>
    );
  },
}));

vi.mock("../../../components/database/DbClientTab", () => ({
  default: (props: { tabId?: string; info?: Record<string, unknown>; visible?: boolean; }) => {
    dbClientMock.props.push(props);
    return (
      <div
        data-testid="db-client-tab"
        data-tab-id={props.tabId ?? ""}
        data-engine={String(props.info?.engine ?? "")}
        data-host={String(props.info?.host ?? "")}
        data-catalog={String(props.info?.catalog ?? "")}
        data-database={String(props.info?.database ?? "")}
        data-visible={props.visible ? "true" : "false"}
      />
    );
  },
}));

vi.mock("../../../components/database/RedisClientTab", () => ({
  default: () => <div data-testid="redis-client-tab" />,
}));

vi.mock("../../../components/database/HBaseShellTab", () => ({
  default: (props: { tabId?: string; info?: Record<string, unknown>; visible?: boolean; }) => {
    hbaseShellMock.props.push(props);
    return (
      <div
        data-testid="hbase-shell-tab"
        data-tab-id={props.tabId ?? ""}
        data-host={String(props.info?.host ?? "")}
        data-port={String(props.info?.port ?? "")}
        data-namespace={String(props.info?.namespace ?? "")}
        data-rest-path={String(props.info?.restPath ?? "")}
        data-visible={props.visible ? "true" : "false"}
      />
    );
  },
}));

vi.mock("../../../lib/ipc", () => ({
  encodeBase64: (value: string) => btoa(value),
  exitApp: vi.fn(async () => undefined),
  getSession: vi.fn(async (id: string) => ({
    id,
    name: `session-${id}`,
    session_type: "SSH",
    group_path: null,
    host: "example.test",
    port: 22,
    username: "root",
    auth_method: "Password",
    options_json: "{}",
    created_at: 0,
    updated_at: 0,
    last_connected_at: null,
    sort_order: 0,
  })),
  getWelcomeRunSnapshot: vi.fn(async () => ({ record: null, legacyCandidate: null, issue: null })),
  commitWelcomeRunSnapshot: vi.fn(async () => ({ record: null, applied: true })),
  clearWelcomeRunSnapshot: vi.fn(async () => undefined),
  recordLocalDirectoryUse: vi.fn(async () => ({ changed: true })),
  listenWelcomeDirectoriesChanged: vi.fn(async () => vi.fn()),
  lanchatGetProfile: vi.fn(async () => ({
    peerId: "test-peer",
    displayName: "Test Peer",
    avatarBase64: null,
    signature: "",
    status: "online",
  })),
  lanchatListConversations: vi.fn(async () => []),
  lanchatListGroups: vi.fn(async () => []),
  lanchatListPeers: vi.fn(async () => []),
  lanchatGetRetention: vi.fn(async () => null),
  lanchatGetServiceState: vi.fn(async () => ({ running: false, startOnLaunch: false })),
  listenLanChatRoster: vi.fn(async () => vi.fn()),
  listenLanChatMessage: vi.fn(async () => vi.fn()),
  listenLanChatConversation: vi.fn(async () => vi.fn()),
  listenLanChatGroup: vi.fn(async () => vi.fn()),
  listenLanChatTransfer: vi.fn(async () => vi.fn()),
  listenLanChatFileOffer: vi.fn(async () => vi.fn()),
  listenLanChatSecurity: vi.fn(async () => vi.fn()),
  listenLanChatService: vi.fn(async () => vi.fn()),
  listSessionGroups: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
  listCommonLocalDirectories: vi.fn(async () => []),
  listLocalShells: vi.fn(async () => []),
  listWslDistros: vi.fn(async () => []),
  markSessionConnected: vi.fn(async () => 0),
  writeTerminal: vi.fn(async () => undefined),
  detectXServer: vi.fn(async () => ({
    available: false,
    display: "",
    endpoint: "",
    hasCookie: false,
    provider: "unknown",
    hint: "no-display",
  })),
  // Vault helpers used by MainLayout's lock-aware connect flow.
  VAULT_LOCKED_EVENT: "vault-locked",
  vaultPut: vi.fn(async () => ({ id: "stub", reference: "vault:stub" })),
  isVaultLockedError: () => false,
}));

vi.mock("../../../stores/vaultStore", () => ({
  useVaultStore: Object.assign(
    (selector: (s: { state: string; refresh: () => Promise<void>; unlock: () => Promise<void>; }) => unknown) =>
      selector({
        state: vaultMock.state,
        refresh: vaultMock.refresh,
        unlock: vaultMock.unlock,
      }),
    { getState: () => ({ state: vaultMock.state }) },
  ),
}));

export function makeSessionWithProfile(profile: TerminalProfile): SessionConfig {
  return {
    id: "session-with-profile",
    name: "profiled-session",
    session_type: "SSH",
    group_path: null,
    host: "example.test",
    port: 22,
    username: "root",
    auth_method: "Password",
    options_json: JSON.stringify({ terminalProfile: profile }),
    created_at: 10,
    updated_at: 10,
    last_connected_at: null,
    sort_order: 0,
  };
}

export function makePasswordSession(id: string, host: string, passwordRef?: string): SessionConfig {
  return {
    id,
    name: id,
    session_type: "SSH",
    group_path: null,
    host,
    port: 22,
    username: "root",
    auth_method: "Password",
    options_json: passwordRef ? JSON.stringify({ passwordRef }) : "{}",
    created_at: 10,
    updated_at: 10,
    last_connected_at: null,
    sort_order: 0,
  };
}

export function latestSidebarProps(): {
  onConnectSession?: (session: SessionConfig) => void;
  onOpenSettings?: () => void;
} {
  const props = sidebarMock.props.at(-1);
  if (!props) throw new Error("Sidebar props were not captured");
  return props;
}

export function latestQuickConnectProps(): {
  onConnectInput?: (value: string) => void;
  onConnectSession?: (session: SessionConfig) => void;
} {
  const props = quickConnectMock.props.at(-1);
  if (!props) throw new Error("QuickConnect props were not captured");
  return props;
}

export function setNavigatorPlatform(platform: string): () => void {
  const originalPlatform = window.navigator.platform;
  Object.defineProperty(window.navigator, "platform", {
    configurable: true,
    value: platform,
  });
  return () => {
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  };
}

export {
  controlBarMock,
  dbClientMock,
  hbaseShellMock,
  panelResizeMock,
  quickConnectMock,
  sftpSidebarMock,
  sidebarMock,
  terminalLifecycle,
  terminalPanelMock,
  vaultMock,
};
