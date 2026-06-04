import { act, fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forwardRef, useEffect, useImperativeHandle } from "react";
import { MainLayout } from "./MainLayout";
import { useAppStore } from "../stores/appStore";
import { useSessionStore } from "../stores/sessionStore";
import { exitApp, listSessions, writeTerminal, type SessionConfig } from "../lib/ipc";
import { DEFAULT_TERMINAL_PROFILE, type TerminalProfile } from "../lib/terminalProfile";

const terminalLifecycle = vi.hoisted(() => ({
  mounted: vi.fn(),
  unmounted: vi.fn(),
}));

const sidebarMock = vi.hoisted(() => ({
  props: [] as Array<{ onConnectSession?: (session: SessionConfig) => void }>,
}));

const quickConnectMock = vi.hoisted(() => ({
  props: [] as Array<{
    onConnectInput?: (value: string) => void;
    onConnectSession?: (session: SessionConfig) => void;
  }>,
}));

const dbClientMock = vi.hoisted(() => ({
  props: [] as Array<{ tabId?: string; info?: Record<string, unknown>; visible?: boolean }>,
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

vi.mock("react-resizable-panels", () => ({
  PanelGroup: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className} data-testid="panel-group">{children}</div>
  ),
  Panel: forwardRef<unknown, { children: React.ReactNode }>(({ children }, ref) => {
    useImperativeHandle(ref, () => ({
      collapse: vi.fn(),
      resize: vi.fn(),
    }));
    return <div data-testid="panel">{children}</div>;
  }),
  PanelResizeHandle: ({ className, "data-testid": testId }: React.HTMLAttributes<HTMLDivElement> & { "data-testid"?: string }) => (
    <div className={className} data-testid={testId ?? "panel-resize-handle"} />
  ),
}));

vi.mock("../components/menubar/MenuBar", () => ({
  MenuBar: () => <div data-testid="menu-bar" />,
}));

vi.mock("../components/menubar/Ribbon", () => ({
  Ribbon: ({ onCommand }: { onCommand?: (command: string) => void }) => (
    <div data-testid="ribbon">
      <button type="button" data-testid="mock-ribbon-exit" onClick={() => onCommand?.("exit")}>
        Exit
      </button>
    </div>
  ),
}));

vi.mock("../components/quickconnect/QuickConnect", () => ({
  QuickConnect: (props: {
    onConnectInput?: (value: string) => void;
    onConnectSession?: (session: SessionConfig) => void;
  }) => {
    quickConnectMock.props.push(props);
    return <div data-testid="quick-connect" />;
  },
}));

vi.mock("../components/sidebar/Sidebar", () => ({
  Sidebar: (props: { onConnectSession?: (session: SessionConfig) => void }) => {
    sidebarMock.props.push(props);
    return <div data-testid="sidebar" />;
  },
}));

vi.mock("../components/statusbar/StatusBar", () => ({
  StatusBar: () => <div data-testid="status-bar" />,
}));

vi.mock("../components/terminal/TerminalPanel", () => ({
  TerminalPanel: ({
    tabId,
    terminalProfile,
    sftpToggle,
    chatToggle,
    visible,
    activeForShortcuts,
    inputLocked,
    onSessionReady,
  }: {
    tabId?: string;
    terminalProfile?: TerminalProfile;
    sftpToggle?: { open: boolean; onToggle: () => void };
    chatToggle?: { open: boolean; onToggle: () => void };
    visible?: boolean;
    activeForShortcuts?: boolean;
    inputLocked?: boolean;
    onSessionReady?: (sessionId: string) => void;
  }) => {
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
        data-terminal-font-size={terminalProfile?.fontSize ?? ""}
        data-terminal-theme={terminalProfile?.theme ?? ""}
      >
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

vi.mock("../components/rdp/RdpPanel", () => ({
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

vi.mock("../components/filebrowser/SftpSidebar", () => ({
  SftpSidebar: () => <div data-testid="sftp-sidebar" />,
}));

vi.mock("../components/database/DbClientTab", () => ({
  default: (props: { tabId?: string; info?: Record<string, unknown>; visible?: boolean }) => {
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

vi.mock("../components/database/RedisClientTab", () => ({
  default: () => <div data-testid="redis-client-tab" />,
}));

vi.mock("../lib/ipc", () => ({
  encodeBase64: (value: string) => btoa(value),
  exitApp: vi.fn(async () => undefined),
  listSessionGroups: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
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

vi.mock("../stores/vaultStore", () => ({
  useVaultStore: Object.assign(
    (selector: (s: { state: string; refresh: () => Promise<void>; unlock: () => Promise<void> }) => unknown) =>
      selector({
        state: vaultMock.state,
        refresh: vaultMock.refresh,
        unlock: vaultMock.unlock,
      }),
    { getState: () => ({ state: vaultMock.state }) },
  ),
}));

describe("MainLayout attached SFTP sidebar", () => {
  beforeEach(() => {
    window.localStorage.clear();
    terminalLifecycle.mounted.mockClear();
    terminalLifecycle.unmounted.mockClear();
    sidebarMock.props = [];
    quickConnectMock.props = [];
    dbClientMock.props = [];
    vaultMock.state = "empty";
    vaultMock.refresh.mockClear();
    vaultMock.unlock.mockClear();
    vi.mocked(exitApp).mockClear();
    vi.mocked(listSessions).mockResolvedValue([]);
    useSessionStore.setState({
      sessions: [],
      groups: [],
      loading: false,
      selectedSessionId: null,
      searchQuery: "",
    });
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        {
          id: "ssh-tab",
          type: "terminal",
          title: "root@example.test",
          closable: true,
          ssh: {
            host: "example.test",
            port: 22,
            username: "root",
            authMethod: "Password",
            authData: "secret",
            optionsJson: undefined,
          },
        },
      ],
      activeTabId: "ssh-tab",
      sidebarCollapsed: false,
      compactMode: false,
      terminalSplitActive: false,
      terminalSplitLayout: "horizontal",
      terminalSplitInputLockedTabIds: new Set(),
      multiExecActive: false,
      multiExecSelectedTabIds: new Set(),
      statusMessage: "Ready",
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("opens the attached SFTP sidebar without remounting the terminal", () => {
    render(<MainLayout />);

    expect(screen.getByTestId("terminal-panel")).toBeInTheDocument();
    expect(screen.getByTestId("tab-chat-toggle")).toBeInTheDocument();
    expect(terminalLifecycle.mounted).toHaveBeenCalledTimes(1);
    expect(terminalLifecycle.unmounted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /sftp/i }));

    expect(screen.getByTestId("sftp-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-panel")).toBeInTheDocument();
    expect(terminalLifecycle.mounted).toHaveBeenCalledTimes(1);
    expect(terminalLifecycle.unmounted).not.toHaveBeenCalled();
  });

  it("hides outer chrome in compact mode without remounting the terminal", () => {
    render(<MainLayout />);

    expect(screen.getByTestId("menu-bar")).toBeInTheDocument();
    expect(screen.queryByTestId("ribbon")).not.toBeInTheDocument();
    expect(screen.queryByTestId("quick-connect")).not.toBeInTheDocument();
    expect(screen.getByTestId("status-bar")).toBeInTheDocument();
    expect(terminalLifecycle.mounted).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /enter compact mode/i }));

    expect(screen.queryByTestId("menu-bar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ribbon")).not.toBeInTheDocument();
    expect(screen.queryByTestId("quick-connect")).not.toBeInTheDocument();
    expect(screen.queryByTestId("status-bar")).not.toBeInTheDocument();
    expect(screen.getByTestId("compact-titlebar")).toBeInTheDocument();
    expect(screen.getByTestId("tab-bar")).toHaveAttribute("data-compact", "true");
    expect(screen.getByTestId("terminal-panel")).toBeInTheDocument();
    expect(terminalLifecycle.mounted).toHaveBeenCalledTimes(1);
    expect(terminalLifecycle.unmounted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /exit compact mode/i }));

    expect(screen.getByTestId("menu-bar")).toBeInTheDocument();
    expect(screen.queryByTestId("ribbon")).not.toBeInTheDocument();
    expect(screen.queryByTestId("quick-connect")).not.toBeInTheDocument();
    expect(screen.getByTestId("status-bar")).toBeInTheDocument();
    expect(terminalLifecycle.mounted).toHaveBeenCalledTimes(1);
    expect(terminalLifecycle.unmounted).not.toHaveBeenCalled();
  });

  it("routes titlebar close through the app exit command", async () => {
    render(<MainLayout />);

    fireEvent.click(screen.getByTestId("window-close"));

    expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

    await waitFor(() => {
      expect(exitApp).toHaveBeenCalledTimes(1);
    });
  });

  it("routes ribbon exit through the app exit command", async () => {
    window.localStorage.setItem("taomni.ribbonVisible", "true");
    render(<MainLayout />);

    fireEvent.click(screen.getByTestId("mock-ribbon-exit"));

    expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

    await waitFor(() => {
      expect(exitApp).toHaveBeenCalledTimes(1);
    });
  });

  it("opens a local terminal from Ctrl+Shift+T outside the welcome tab", async () => {
    render(<MainLayout />);

    expect(useAppStore.getState().activeTabId).toBe("ssh-tab");

    fireEvent.keyDown(window, { key: "T", ctrlKey: true, shiftKey: true });

    await waitFor(() => {
      expect(
        useAppStore.getState().tabs.some((tab) => tab.type === "terminal" && tab.id.startsWith("local-")),
      ).toBe(true);
    });
  });

  it("switches tabs with macOS Command+number shortcuts", async () => {
    const restorePlatform = setNavigatorPlatform("MacIntel");
    const shortcutTabs = [
      { id: "welcome", type: "welcome" as const, title: "Welcome", closable: false },
      ...Array.from({ length: 7 }, (_, index) => ({
        id: `term-${index + 1}`,
        type: "terminal" as const,
        title: `Terminal ${index + 1}`,
        closable: true,
      })),
    ];
    useAppStore.setState({
      tabs: shortcutTabs,
      activeTabId: "term-7",
      terminalSplitActive: false,
    });

    try {
      render(<MainLayout />);

      for (const [index, tab] of shortcutTabs.entries()) {
        const digit = String(index + 1);
        fireEvent.keyDown(window, { key: digit, code: `Digit${digit}`, metaKey: true });
        await waitFor(() => {
          expect(useAppStore.getState().activeTabId).toBe(tab.id);
        });
        if (tab.type === "terminal") {
          const panel = screen
            .getAllByTestId("terminal-panel")
            .find((node) => node.getAttribute("data-tab-id") === tab.id);
          expect(panel).toHaveAttribute("data-active-shortcuts", "true");
        }
      }

      fireEvent.keyDown(window, { key: "9", code: "Digit9", metaKey: true });

      await waitFor(() => {
        expect(useAppStore.getState().activeTabId).toBe("term-7");
      });
    } finally {
      restorePlatform();
    }
  });

  it("keeps Command+number no-op when the target tab is missing", () => {
    const restorePlatform = setNavigatorPlatform("MacIntel");
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        { id: "term-1", type: "terminal", title: "One", closable: true },
        { id: "term-2", type: "terminal", title: "Two", closable: true },
      ],
      activeTabId: "term-1",
      terminalSplitActive: false,
    });

    try {
      render(<MainLayout />);

      const event = new KeyboardEvent("keydown", {
        key: "5",
        code: "Digit5",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(event);

      expect(useAppStore.getState().activeTabId).toBe("term-1");
      expect(event.defaultPrevented).toBe(true);
    } finally {
      restorePlatform();
    }
  });

  it("does not treat ordinary digits or non-macOS Meta+digits as tab shortcuts", () => {
    const restorePlatform = setNavigatorPlatform("Win32");
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        { id: "term-1", type: "terminal", title: "One", closable: true },
        { id: "term-2", type: "terminal", title: "Two", closable: true },
      ],
      activeTabId: "term-1",
      terminalSplitActive: false,
    });

    try {
      render(<MainLayout />);

      const input = document.createElement("input");
      document.body.appendChild(input);
      const plainDigit = new KeyboardEvent("keydown", {
        key: "2",
        code: "Digit2",
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(plainDigit);
      input.remove();

      expect(useAppStore.getState().activeTabId).toBe("term-1");
      expect(plainDigit.defaultPrevented).toBe(false);

      const metaDigit = new KeyboardEvent("keydown", {
        key: "2",
        code: "Digit2",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(metaDigit);

      expect(useAppStore.getState().activeTabId).toBe("term-1");
      expect(metaDigit.defaultPrevented).toBe(false);
    } finally {
      restorePlatform();
    }
  });

  it("opens compact main menu and sessions drawer from the titlebar", () => {
    render(<MainLayout />);

    fireEvent.click(screen.getByRole("button", { name: /enter compact mode/i }));

    fireEvent.click(screen.getByRole("button", { name: /main menu/i }));
    expect(screen.getByTestId("context-menu-item-new-local-terminal")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-sessions")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: /show sessions drawer/i }));
    expect(screen.getByTestId("compact-sidebar-drawer")).toBeInTheDocument();
    expect(terminalLifecycle.mounted).toHaveBeenCalledTimes(1);
    expect(terminalLifecycle.unmounted).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: /close sessions drawer/i })[0]);
    expect(screen.queryByTestId("compact-sidebar-drawer")).not.toBeInTheDocument();
  });

  it("collapses the main sidebar to a fixed rail without leaving the panel gap", () => {
    useAppStore.setState({
      sidebarCollapsed: true,
      compactMode: false,
    });

    render(<MainLayout />);

    expect(screen.getByTestId("collapsed-sidebar-rail")).toBeInTheDocument();
    expect(screen.getByTestId("main-sidebar-resize-handle")).toHaveClass("hidden");
  });

  it("shows all terminal panes in split mode and switches layouts without remounting terminals", async () => {
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        { id: "term-1", type: "terminal", title: "One", closable: true },
        { id: "term-2", type: "terminal", title: "Two", closable: true },
      ],
      activeTabId: "term-1",
      terminalSplitActive: true,
      terminalSplitLayout: "horizontal",
      terminalSplitInputLockedTabIds: new Set(),
    });

    render(<MainLayout />);

    const panels = screen.getAllByTestId("terminal-panel");
    expect(panels).toHaveLength(2);
    expect(panels.map((panel) => panel.getAttribute("data-visible"))).toEqual(["true", "true"]);
    expect(panels[0]).toHaveAttribute("data-active-shortcuts", "true");
    expect(panels[1]).toHaveAttribute("data-active-shortcuts", "false");
    expect(screen.getByTestId("terminal-split-panes")).toHaveAttribute("data-layout", "horizontal");
    expect(terminalLifecycle.mounted).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByTestId("terminal-split-layout-grid"));

    await waitFor(() => {
      expect(screen.getByTestId("terminal-split-panes")).toHaveAttribute("data-layout", "grid");
    });
    expect(terminalLifecycle.mounted).toHaveBeenCalledTimes(2);
    expect(terminalLifecycle.unmounted).not.toHaveBeenCalled();
  });

  it("resizes adjacent terminal panes in horizontal split mode", async () => {
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        { id: "term-1", type: "terminal", title: "One", closable: true },
        { id: "term-2", type: "terminal", title: "Two", closable: true },
      ],
      activeTabId: "term-1",
      terminalSplitActive: true,
      terminalSplitLayout: "horizontal",
      terminalSplitInputLockedTabIds: new Set(),
    });

    render(<MainLayout />);

    const panesContainer = screen.getByTestId("terminal-split-panes");
    Object.defineProperty(panesContainer, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, right: 1000, bottom: 500, width: 1000, height: 500 }),
    });

    const handle = screen.getByTestId("terminal-split-resize-handle");
    fireEvent.pointerDown(handle, { clientX: 500, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 700, clientY: 0 });
    fireEvent.pointerUp(window);

    const panes = screen.getAllByTestId("terminal-split-pane");
    await waitFor(() => {
      expect(Number.parseFloat((panes[0] as HTMLElement).style.flexGrow)).toBeCloseTo(1.4);
      expect(Number.parseFloat((panes[1] as HTMLElement).style.flexGrow)).toBeCloseTo(0.6);
    });
    expect(terminalLifecycle.mounted).toHaveBeenCalledTimes(2);
    expect(terminalLifecycle.unmounted).not.toHaveBeenCalled();
  });

  it("resizes grid split columns and rows", async () => {
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        { id: "term-1", type: "terminal", title: "One", closable: true },
        { id: "term-2", type: "terminal", title: "Two", closable: true },
        { id: "term-3", type: "terminal", title: "Three", closable: true },
        { id: "term-4", type: "terminal", title: "Four", closable: true },
      ],
      activeTabId: "term-1",
      terminalSplitActive: true,
      terminalSplitLayout: "grid",
      terminalSplitInputLockedTabIds: new Set(),
    });

    render(<MainLayout />);

    const panesContainer = screen.getByTestId("terminal-split-panes");
    Object.defineProperty(panesContainer, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }),
    });

    fireEvent.pointerDown(screen.getByTestId("terminal-split-grid-column-resize-handle"), {
      clientX: 500,
      clientY: 0,
    });
    fireEvent.pointerMove(window, { clientX: 650, clientY: 0 });
    fireEvent.pointerUp(window);

    await waitFor(() => {
      expect((panesContainer as HTMLElement).style.gridTemplateColumns).toContain("1.3fr");
      expect((panesContainer as HTMLElement).style.gridTemplateColumns).toContain("0.7fr");
    });

    fireEvent.pointerDown(screen.getByTestId("terminal-split-grid-row-resize-handle"), {
      clientX: 0,
      clientY: 300,
    });
    fireEvent.pointerMove(window, { clientX: 0, clientY: 420 });
    fireEvent.pointerUp(window);

    await waitFor(() => {
      expect((panesContainer as HTMLElement).style.gridTemplateRows).toContain("1.4fr");
      expect((panesContainer as HTMLElement).style.gridTemplateRows).toContain("0.6fr");
    });
  });

  it("updates the active terminal from a split pane click and passes input lock state", async () => {
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        { id: "term-1", type: "terminal", title: "One", closable: true },
        { id: "term-2", type: "terminal", title: "Two", closable: true },
      ],
      activeTabId: "term-1",
      terminalSplitActive: true,
      terminalSplitLayout: "horizontal",
      terminalSplitInputLockedTabIds: new Set(),
    });

    render(<MainLayout />);

    const paneTwo = screen
      .getAllByTestId("terminal-split-pane")
      .find((pane) => pane.getAttribute("data-tab-id") === "term-2");
    expect(paneTwo).toBeTruthy();

    fireEvent.mouseDown(paneTwo!);

    await waitFor(() => {
      expect(useAppStore.getState().activeTabId).toBe("term-2");
      expect(paneTwo).toHaveAttribute("data-active", "true");
    });

    fireEvent.click(screen.getByTestId("terminal-split-lock-term-2"));

    await waitFor(() => {
      expect(paneTwo).toHaveAttribute("data-input-locked", "true");
      expect(
        screen
          .getAllByTestId("terminal-panel")
          .find((panel) => panel.getAttribute("data-tab-id") === "term-2"),
      ).toHaveAttribute("data-input-locked", "true");
    });
  });

  it("skips split-locked selected terminals when MultiExec broadcasts", async () => {
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        { id: "term-1", type: "terminal", title: "One", closable: true },
        { id: "term-2", type: "terminal", title: "Two", closable: true },
      ],
      activeTabId: "term-1",
      terminalSplitActive: true,
      terminalSplitLayout: "horizontal",
      terminalSplitInputLockedTabIds: new Set(["term-2"]),
      multiExecActive: true,
      multiExecSelectedTabIds: new Set(["term-1", "term-2"]),
    });
    vi.mocked(writeTerminal).mockClear();

    render(<MainLayout />);

    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    const input = screen.getByTestId("multiexec-input");
    fireEvent.change(input, { target: { value: "date" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(writeTerminal).toHaveBeenCalledWith("session-term-1", btoa("date\r"));
    });
    expect(writeTerminal).not.toHaveBeenCalledWith("session-term-2", btoa("date\r"));
  });

  it("passes edited session terminal profiles to already-open terminal tabs", async () => {
    const initialSession = makeSessionWithProfile({
      ...DEFAULT_TERMINAL_PROFILE,
      fontSize: 13,
      theme: "classic",
    });
    const updatedSession = makeSessionWithProfile({
      ...DEFAULT_TERMINAL_PROFILE,
      fontSize: 19,
      theme: "termius-dark",
    });
    vi.mocked(listSessions).mockResolvedValue([initialSession]);
    useSessionStore.setState({ sessions: [initialSession], groups: [] });
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        {
          id: "ssh-tab",
          type: "terminal",
          title: "root@example.test",
          sessionId: initialSession.id,
          closable: true,
          ssh: {
            sessionId: initialSession.id,
            host: "example.test",
            port: 22,
            username: "root",
            authMethod: "Password",
            authData: "secret",
            optionsJson: initialSession.options_json,
          },
          terminalProfile: {
            ...DEFAULT_TERMINAL_PROFILE,
            fontSize: 11,
            theme: "classic",
          },
        },
      ],
      activeTabId: "ssh-tab",
      sidebarCollapsed: false,
      compactMode: false,
      statusMessage: "Ready",
    });

    render(<MainLayout />);

    expect(screen.getByTestId("terminal-panel")).toHaveAttribute("data-terminal-font-size", "13");
    expect(screen.getByTestId("terminal-panel")).toHaveAttribute("data-terminal-theme", "classic");

    act(() => {
      useSessionStore.setState({ sessions: [updatedSession] });
    });

    await waitFor(() => {
      expect(screen.getByTestId("terminal-panel")).toHaveAttribute("data-terminal-font-size", "19");
      expect(screen.getByTestId("terminal-panel")).toHaveAttribute("data-terminal-theme", "termius-dark");
    });
  });

  it("unlocks the vault once before opening queued saved-password sessions", async () => {
    vaultMock.state = "locked";
    const first = makePasswordSession("saved-1", "saved-one.test", "vault:first");
    const second = makePasswordSession("saved-2", "saved-two.test", "vault:second");

    render(<MainLayout />);
    const sidebar = latestSidebarProps();

    act(() => {
      sidebar.onConnectSession?.(first);
      sidebar.onConnectSession?.(second);
    });

    expect(screen.getByTestId("vault-unlock-dialog")).toBeInTheDocument();
    expect(screen.getAllByTestId("vault-unlock-dialog")).toHaveLength(1);

    fireEvent.change(screen.getByTestId("vault-unlock-pw"), { target: { value: "master" } });
    fireEvent.click(screen.getByTestId("vault-unlock-confirm"));

    await waitFor(() => {
      expect(vaultMock.unlock).toHaveBeenCalledTimes(1);
      const openedSessionIds = useAppStore.getState().tabs
        .filter((tab) => tab.type === "terminal" && tab.sessionId?.startsWith("saved-"))
        .map((tab) => tab.sessionId);
      expect(openedSessionIds).toEqual(["saved-1", "saved-2"]);
    });
    expect(screen.queryByTestId("vault-unlock-dialog")).not.toBeInTheDocument();
  });

  it("prompts for queued unsaved passwords one session at a time", async () => {
    const first = makePasswordSession("manual-1", "manual-one.test");
    const second = makePasswordSession("manual-2", "manual-two.test");

    render(<MainLayout />);
    const sidebar = latestSidebarProps();

    act(() => {
      sidebar.onConnectSession?.(first);
      sidebar.onConnectSession?.(second);
    });

    expect(screen.getByTestId("auth-prompt")).toHaveTextContent("root@manual-one.test");
    expect(screen.getAllByTestId("auth-prompt")).toHaveLength(1);

    fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "pw-one" } });
    fireEvent.click(screen.getByTestId("auth-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("auth-prompt")).toHaveTextContent("root@manual-two.test");
    });
    expect(screen.getAllByTestId("auth-prompt")).toHaveLength(1);

    fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "pw-two" } });
    fireEvent.click(screen.getByTestId("auth-submit"));

    await waitFor(() => {
      expect(screen.queryByTestId("auth-prompt")).not.toBeInTheDocument();
      const openedSessionIds = useAppStore.getState().tabs
        .filter((tab) => tab.type === "terminal" && tab.sessionId?.startsWith("manual-"))
        .map((tab) => tab.sessionId);
      expect(openedSessionIds).toEqual(["manual-1", "manual-2"]);
    });
  });

  it("opens RDP quick-connect URLs through the password prompt into an RDP tab", async () => {
    window.localStorage.setItem("taomni.quickConnectVisible", "true");
    render(<MainLayout />);

    act(() => {
      latestQuickConnectProps().onConnectInput?.("rdp://alice@win.example.test:3390");
    });

    expect(screen.getByTestId("auth-prompt")).toHaveTextContent("alice@win.example.test");

    fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "rdp-pw" } });
    fireEvent.click(screen.getByTestId("auth-submit"));

    await waitFor(() => {
      const rdpTab = useAppStore.getState().tabs.find((tab) => tab.type === "rdp");
      expect(rdpTab?.rdp).toMatchObject({
        host: "win.example.test",
        port: 3390,
        username: "alice",
        password: "rdp-pw",
      });
    });
    expect(screen.getByTestId("rdp-panel")).toHaveAttribute("data-host", "win.example.test");
    expect(screen.getByTestId("rdp-panel")).toHaveAttribute("data-port", "3390");
    expect(screen.getByTestId("rdp-panel")).toHaveAttribute("data-username", "alice");
  });

  it("opens saved Presto sessions as database tabs with catalog context", async () => {
    const prestoSession: SessionConfig = {
      id: "presto-1",
      name: "Presto Analytics",
      session_type: "Presto",
      group_path: null,
      host: "presto.example.test",
      port: 8080,
      username: "analyst",
      auth_method: "None",
      options_json: JSON.stringify({
        dbCatalog: "hive",
        dbDatabase: "sales",
        dbSsl: true,
        dbTimeout: "30",
      }),
      created_at: 10,
      updated_at: 10,
      last_connected_at: null,
      sort_order: 0,
    };

    render(<MainLayout />);

    act(() => {
      latestSidebarProps().onConnectSession?.(prestoSession);
    });

    await waitFor(() => {
      const tab = useAppStore.getState().tabs.find((candidate) => candidate.sessionId === "presto-1");
      expect(tab).toMatchObject({
        type: "database",
        title: "Presto presto.example.test:8080/hive.sales",
        db: {
          engine: "Presto",
          host: "presto.example.test",
          port: 8080,
          username: "analyst",
          catalog: "hive",
          database: "sales",
          ssl: true,
          timeoutSecs: 30,
        },
      });
    });
    expect(screen.getByTestId("db-client-tab")).toHaveAttribute("data-engine", "Presto");
    expect(screen.getByTestId("db-client-tab")).toHaveAttribute("data-catalog", "hive");
    expect(screen.getByTestId("db-client-tab")).toHaveAttribute("data-database", "sales");
  });
});

function makeSessionWithProfile(profile: TerminalProfile): SessionConfig {
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

function makePasswordSession(id: string, host: string, passwordRef?: string): SessionConfig {
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

function latestSidebarProps(): { onConnectSession?: (session: SessionConfig) => void } {
  const props = sidebarMock.props.at(-1);
  if (!props) throw new Error("Sidebar props were not captured");
  return props;
}

function latestQuickConnectProps(): {
  onConnectInput?: (value: string) => void;
  onConnectSession?: (session: SessionConfig) => void;
} {
  const props = quickConnectMock.props.at(-1);
  if (!props) throw new Error("QuickConnect props were not captured");
  return props;
}

function setNavigatorPlatform(platform: string): () => void {
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
