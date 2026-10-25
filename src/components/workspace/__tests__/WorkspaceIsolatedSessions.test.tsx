import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTabStrip } from "../WorkspaceTabStrip";
import { WorkspaceSessionPickerModal } from "../WorkspaceSessionPickerModal";
import { WorkspaceSessionsPanel } from "../WorkspaceSessionsPanel";
import { WorkspaceSessionPane } from "../WorkspaceSessionPane";
import { useAppStore } from "../../../stores/appStore";
import {
  DEFAULT_WORKSPACE_ID,
  useWorkspacePlatformStore,
} from "../../../stores/workspacePlatformStore";
import { useWorkspaceUiStore } from "../../../stores/workspaceUiStore";
import { useSessionStore } from "../../../stores/sessionStore";
import type { SessionConfig } from "../../../lib/ipc";

vi.mock("../../terminal/TerminalPanel", () => ({
  TerminalPanel: ({ tabId, tabTitle }: { tabId: string; tabTitle?: string }) => (
    <div data-testid="terminal-panel-mock" data-tab-id={tabId}>{tabTitle}</div>
  ),
}));

function session(overrides: Partial<SessionConfig>): SessionConfig {
  return {
    id: "sess-1",
    name: "prod-api-01",
    session_type: "SSH",
    group_path: "Prod",
    host: "10.0.0.10",
    port: 22,
    username: "root",
    auth_method: { PrivateKey: { key_path: "/qa/key" } },
    options_json: "{}",
    created_at: 1,
    updated_at: 1,
    last_connected_at: null,
    sort_order: 0,
    ...overrides,
  };
}

const sessions = [
  session({ id: "sess-ssh", name: "prod-api-01", session_type: "SSH", host: "10.0.0.10" }),
  session({ id: "sess-db", name: "orders-pg", session_type: "PostgreSQL", host: "pg.internal", port: 5432 }),
  session({ id: "sess-rdp", name: "win-bastion", session_type: "RDP", host: "10.0.0.20", port: 3389 }),
];

function workspace() {
  return useWorkspacePlatformStore.getState().workspaces.find((entry) => entry.id === DEFAULT_WORKSPACE_ID)!;
}

beforeEach(() => {
  window.localStorage.clear();
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useWorkspaceUiStore.setState({ fsModal: null, sessionPickerOpen: false, sessionPickerWorkspaceId: null, globalSearchOpen: false, agentDispatchOpen: false });
  useAppStore.setState({ activeSideTab: "workspaces", sidebarCollapsed: false, tabs: [], activeTabId: null, statusMessage: "Ready" });
  useSessionStore.setState({ sessions, groups: [], loading: false, selectedSessionId: null, searchQuery: "", markConnected: vi.fn(async () => {}) });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Workspace isolated sessions (TASK-07)", () => {
  it("UT-WS-07-01 opens any global session from the workspace + menu", async () => {
    render(<WorkspaceTabStrip />);
    fireEvent.click(screen.getByTestId("workspace-open-session-plus"));
    const menu = screen.getByTestId("workspace-open-session-menu");
    expect(within(menu).getByTestId("workspace-plus-open-session")).toBeInTheDocument();
    fireEvent.click(within(menu).getByTestId("workspace-plus-open-session"));
    expect(useWorkspaceUiStore.getState().sessionPickerOpen).toBe(true);
    expect(useWorkspaceUiStore.getState().sessionPickerWorkspaceId).toBe(DEFAULT_WORKSPACE_ID);

    fireEvent.click(screen.getByTestId("workspace-open-session-plus"));
    fireEvent.click(within(screen.getByTestId("workspace-open-session-menu")).getByTestId("workspace-plus-local-terminal"));
    await waitFor(() => expect(workspace().openTabs.some((tab) => tab.protocol === "Local")).toBe(true));
  });

  it("UT-WS-07-02 picker opens a not-yet-linked session and optionally pins it", () => {
    const onClose = vi.fn();
    render(<WorkspaceSessionPickerModal open workspaceId={DEFAULT_WORKSPACE_ID} onClose={onClose} />);
    const dialog = screen.getByTestId("workspace-session-picker-modal");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getAllByTestId("workspace-session-picker-row")).toHaveLength(3);

    fireEvent.click(within(dialog).getByTestId("workspace-session-picker-filter-db"));
    expect(within(dialog).getAllByTestId("workspace-session-picker-row")).toHaveLength(1);
    expect(within(dialog).getByTestId("workspace-session-picker-row").dataset.sessionId).toBe("sess-db");

    fireEvent.click(within(dialog).getByTestId("workspace-session-picker-filter-all"));
    fireEvent.change(within(dialog).getByTestId("workspace-session-picker-search"), { target: { value: "bastion" } });
    expect(within(dialog).getAllByTestId("workspace-session-picker-row")).toHaveLength(1);

    fireEvent.click(within(dialog).getByTestId("workspace-session-picker-pin"));
    fireEvent.click(within(dialog).getByTestId("workspace-session-picker-row"));

    const state = workspace();
    expect(state.openTabs.some((tab) => tab.sessionId === "sess-rdp")).toBe(true);
    expect(state.pinnedSessionIds).toContain("sess-rdp");
    expect(onClose).toHaveBeenCalled();
  });

  it("UT-WS-07-03 opens a session from the rail sessions tool window", () => {
    const onOpenSession = vi.fn((sessionConfig: SessionConfig) => {
      useWorkspacePlatformStore.getState().openSessionInWorkspace(DEFAULT_WORKSPACE_ID, sessionConfig);
    });
    render(
      <WorkspaceSessionsPanel
        workspace={workspace()}
        onOpenSessionPicker={vi.fn()}
        onOpenSession={onOpenSession}
      />,
    );
    const rows = screen.getAllByTestId("workspace-session-row");
    expect(rows.map((row) => row.dataset.sessionId).sort()).toEqual(["sess-db", "sess-rdp", "sess-ssh"]);
    fireEvent.click(rows.find((row) => row.dataset.sessionId === "sess-ssh")!);
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: "sess-ssh" }));
    expect(workspace().openTabs.some((tab) => tab.sessionId === "sess-ssh")).toBe(true);
  });

  it("UT-WS-07-04 keeps Workspaces and Sessions runtime instances independent", () => {
    useAppStore.getState().addTab({
      id: "app-ssh-sess-ssh",
      type: "terminal",
      title: "prod-api-01",
      closable: true,
      sessionId: "sess-ssh",
    });
    const appTabId = useAppStore.getState().tabs[0].id;
    const wsTab = useWorkspacePlatformStore.getState().openSessionInWorkspace(DEFAULT_WORKSPACE_ID, sessions[0]);
    expect(wsTab.id).not.toBe(appTabId);
    expect(wsTab.id.startsWith(`ws:${DEFAULT_WORKSPACE_ID}:sess:sess-ssh`)).toBe(true);

    useWorkspacePlatformStore.getState().closeWorkspaceTab(DEFAULT_WORKSPACE_ID, wsTab.id);
    expect(useAppStore.getState().tabs.map((tab) => tab.id)).toEqual([appTabId]);

    const again = useWorkspacePlatformStore.getState().openSessionInWorkspace(DEFAULT_WORKSPACE_ID, sessions[0]);
    useAppStore.getState().removeTab(appTabId);
    expect(useAppStore.getState().tabs).toHaveLength(0);
    expect(workspace().openTabs.some((tab) => tab.id === again.id)).toBe(true);
  });

  it("UT-WS-07-05 renders a real protocol surface per workspace session tab", () => {
    const localTab = useWorkspacePlatformStore.getState().openLocalTerminalInWorkspace(DEFAULT_WORKSPACE_ID);
    const { rerender } = render(<WorkspaceSessionPane workspace={workspace()} tab={localTab} visible />);
    expect(screen.getByTestId("workspace-session-pane").dataset.kind).toBe("terminal");
    expect(screen.getByTestId("terminal-panel-mock").dataset.tabId).toBe(localTab.id);

    const sshTab = useWorkspacePlatformStore.getState().openSessionInWorkspace(DEFAULT_WORKSPACE_ID, sessions[0]);
    rerender(<WorkspaceSessionPane workspace={workspace()} tab={sshTab} visible />);
    expect(screen.getByTestId("workspace-session-pane").dataset.kind).toBe("terminal");
    expect(screen.getByTestId("terminal-panel-mock").dataset.tabId).toBe(sshTab.id);
    expect(screen.getByTestId("workspace-session-pane").dataset.sessionId).toBe("sess-ssh");
  });
});
