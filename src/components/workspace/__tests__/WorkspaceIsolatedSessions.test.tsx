import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSessionPickerModal } from "../WorkspaceSessionPickerModal";
import { WorkspaceTabStrip } from "../WorkspaceTabStrip";
import { useAppStore } from "../../../stores/appStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { DEFAULT_WORKSPACE_ID, useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";
import type { SessionConfig } from "../../../lib/ipc";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

function makeSession(overrides: Partial<SessionConfig>): SessionConfig {
  return {
    id: "global-local-01",
    name: "ws-local-term",
    session_type: "LocalShell",
    group_path: null,
    host: "",
    port: 0,
    username: null,
    auth_method: "None",
    options_json: "{}",
    created_at: 0,
    updated_at: 0,
    last_connected_at: null,
    sort_order: 0,
    ...overrides,
  };
}

describe("Workspace isolated sessions (TASK-07)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAppStore.setState({ activeSideTab: "workspaces", sidebarCollapsed: false, tabs: [], activeTabId: null });
    useWorkspacePlatformStore.getState().resetForTests();
    useSessionStore.setState({
      sessions: [
        makeSession({ id: "global-local-01", name: "ws-local-term" }),
        makeSession({ id: "global-mysql-01", name: "prod-mysql", session_type: "MySQL", host: "10.0.0.9", port: 3306 }),
        makeSession({ id: "global-ssh-01", name: "prod-gateway", session_type: "SSH", host: "10.0.0.8", port: 22, username: "root" }),
      ],
      selectedSessionIds: [],
      loading: false,
      groups: [],
      selectedSessionId: null,
      searchQuery: "",
    });
  });

  afterEach(() => cleanup());

  it("opens an unpinned global session through the picker (Ctrl+Alt+O surface)", () => {
    const onOpenSession = vi.fn();
    render(<WorkspaceSessionPickerModal open onClose={vi.fn()} onOpenSession={onOpenSession} />);
    // Every global session is listed, not only pinned ones.
    const mysqlRow = screen.getAllByTestId("workspace-session-picker-row").find((row) => row.getAttribute("data-session-id") === "global-mysql-01");
    const sshRow = screen.getAllByTestId("workspace-session-picker-row").find((row) => row.getAttribute("data-session-id") === "global-ssh-01");
    expect(mysqlRow).toBeTruthy();
    expect(sshRow).toBeTruthy();

    // Search filters by name.
    fireEvent.change(screen.getByTestId("workspace-session-picker-search"), { target: { value: "prod-mysql" } });
    expect(screen.getAllByTestId("workspace-session-picker-row").some((row) => row.getAttribute("data-session-id") === "global-ssh-01")).toBe(false);

    // The pin checkbox rides along with the open call.
    fireEvent.click(screen.getByTestId("workspace-session-picker-pin"));
    fireEvent.click(screen.getAllByTestId("workspace-session-picker-row").find((row) => row.getAttribute("data-session-id") === "global-mysql-01")!);
    expect(onOpenSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "global-mysql-01" }),
      true,
    );
  });

  it("the + menu opens an isolated local terminal without touching appStore tabs", () => {
    render(<WorkspaceTabStrip />);
    fireEvent.click(screen.getByTestId("workspace-open-session-plus"));
    fireEvent.click(screen.getByTestId("workspace-plus-new-terminal"));

    const workspace = useWorkspacePlatformStore.getState().workspaces[0];
    const terminalTab = workspace.openTabs.find((tab) => tab.kind === "terminal");
    expect(terminalTab).toBeTruthy();
    expect(terminalTab?.id).not.toMatch(/^(ssh|terminal|local)-/);
    // The global tab runtime stays untouched.
    expect(useAppStore.getState().tabs.filter((tab) => tab.id !== "welcome")).toHaveLength(0);
  });

  it("closing a workspace session tab never closes the Sessions-mode instance", () => {
    const session = makeSession({ id: "global-ssh-01", name: "prod-gateway" });
    useAppStore.getState().addTab({ id: "global-ssh-tab", type: "terminal", title: "prod-gateway", sessionId: session.id, closable: true });
    const wsTab = useWorkspacePlatformStore.getState().openSessionInWorkspace(DEFAULT_WORKSPACE_ID, session);

    render(<WorkspaceTabStrip />);
    fireEvent.click(screen.getByTestId(`workspace-tab-close-${wsTab.id}`));
    expect(useWorkspacePlatformStore.getState().workspaces[0].openTabs).toHaveLength(0);
    expect(useAppStore.getState().tabs.some((tab) => tab.id === "global-ssh-tab")).toBe(true);
  });

  it("isolates two instances of the same session config", () => {
    const session = makeSession({ id: "global-ssh-01" });
    const wsTab = useWorkspacePlatformStore.getState().openSessionInWorkspace(DEFAULT_WORKSPACE_ID, session);
    useAppStore.getState().addTab({ id: `ssh-${session.id}-1`, type: "terminal", title: "gateway", sessionId: session.id, closable: true });
    expect(wsTab.id).not.toBe(`ssh-${session.id}-1`);
  });
});
