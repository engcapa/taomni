import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WelcomePanel } from "../../WelcomePanel";
import { HomeSidebar } from "../../sidebar/HomeSidebar";
import { Sidebar } from "../../sidebar/Sidebar";
import { ipcMocks } from "../../tests/welcomePanel/harness";
import { useAppStore } from "../../../stores/appStore";
import { useSessionStore } from "../../../stores/sessionStore";
import type { SessionConfig } from "../../../lib/ipc";

function session(id: string, name: string, type: string, host: string): SessionConfig {
  return {
    id,
    name,
    session_type: type,
    group_path: null,
    host,
    port: 22,
    username: "root",
    auth_method: "None",
    options_json: "{}",
    created_at: 0,
    updated_at: 0,
    last_connected_at: Date.now(),
    sort_order: 0,
  };
}

const sessions = [session("s1", "prod-gateway-01", "SSH", "10.0.0.10"), session("s2", "orders-pg", "PostgreSQL", "pg.internal")];

beforeEach(() => {
  window.localStorage.clear();
  ipcMocks.listLocalShells.mockResolvedValue([]);
  ipcMocks.listCommonLocalDirectories.mockResolvedValue([]);
  ipcMocks.listWslDistros.mockResolvedValue([]);
  ipcMocks.listSessionGroups.mockResolvedValue([]);
  ipcMocks.listSessions.mockResolvedValue([]);
  ipcMocks.listenWelcomeDirectoriesChanged.mockResolvedValue(() => undefined);
  useSessionStore.setState({ sessions, groups: [], loading: false, selectedSessionId: null, searchQuery: "" });
  useAppStore.setState({ activeSideTab: "home", sidebarCollapsed: false, statusMessage: "Ready" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Home mode welcome panel (TASK-08)", () => {
  it("UT-WS-08-01 keeps every WelcomePanel anchor available in Home mode", async () => {
    const onStartLocalTerminal = vi.fn();
    const onNewSession = vi.fn();
    render(
      <WelcomePanel
        restore={undefined}
        onStartLocalTerminal={onStartLocalTerminal}
        onNewSession={onNewSession}
        recentSessions={sessions}
        recentWorkspaces={[]}
        active
      />,
    );
    expect(screen.getByTestId("welcome-panel")).toBeInTheDocument();
    expect(screen.getByTestId("welcome-panel").textContent).toContain("Welcome to Taomni");
    expect(screen.getByTestId("welcome-panel").textContent).toContain("Start local terminal");
    expect(screen.getByTestId("welcome-panel").textContent).toContain("New session");
    expect(screen.getByTestId("welcome-open-local-terminal")).toBeInTheDocument();
    expect(screen.getByTestId("welcome-version")).toBeInTheDocument();
    expect(screen.getByTestId("welcome-version-footer")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("welcome-open-local-terminal"));
    await waitFor(() => expect(onStartLocalTerminal).toHaveBeenCalled());
  });

  it("UT-WS-08-02 renders the Home sidebar actions and recent sessions", () => {
    const onStartLocalTerminal = vi.fn();
    const onNewSession = vi.fn();
    const onConnectSession = vi.fn();
    render(
      <HomeSidebar
        onStartLocalTerminal={onStartLocalTerminal}
        onNewSession={onNewSession}
        onConnectSession={onConnectSession}
      />,
    );
    expect(screen.getByTestId("home-sidebar-panel")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("home-start-local-terminal"));
    expect(onStartLocalTerminal).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("home-new-session"));
    expect(onNewSession).toHaveBeenCalledTimes(1);

    const recent = screen.getAllByTestId("home-recent-session");
    expect(recent).toHaveLength(2);
    fireEvent.click(recent[0]);
    expect(onConnectSession).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("home-nav-sessions"));
    expect(useAppStore.getState().activeSideTab).toBe("sessions");
  });

  it("UT-WS-08-03 switches the rail Home button to the Home sidebar without losing Sessions", () => {
    useAppStore.setState({ activeSideTab: "sessions" });
    render(<Sidebar onStartLocalTerminal={vi.fn()} />);
    expect(screen.getByTestId("sessions-sidebar-panel")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("nav-mode-home"));
    expect(useAppStore.getState().activeSideTab).toBe("home");
    expect(screen.getByTestId("home-sidebar-panel")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("side-tab-sessions"));
    expect(screen.getByTestId("sessions-sidebar-panel")).toBeInTheDocument();
  });

  it("UT-WS-08-04 keeps the Sessions toolbar, search and tree intact", async () => {
    useAppStore.setState({ activeSideTab: "sessions" });
    render(<Sidebar />);
    const panel = screen.getByTestId("sessions-sidebar-panel");
    for (const testId of ["session-new", "session-edit", "session-duplicate", "session-delete", "session-search"]) {
      expect(within(panel).getByTestId(testId)).toBeInTheDocument();
    }
    expect(within(panel).getByTestId("session-tree")).toBeInTheDocument();
    fireEvent.change(within(panel).getByTestId("session-search"), { target: { value: "prod" } });
    expect(useSessionStore.getState().searchQuery).toBe("prod");
    await waitFor(() => expect(within(panel).getAllByText("prod-gateway-01").length).toBeGreaterThan(0));
    // Right-click keeps the session context menu available.
    fireEvent.contextMenu(within(panel).getAllByText("prod-gateway-01")[0]);
    expect(screen.getByTestId("context-menu")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu").textContent).toContain("Connect");
  });
});
