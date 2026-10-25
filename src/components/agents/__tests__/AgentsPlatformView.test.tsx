import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsPlatformView } from "../AgentsPlatformView";
import { PrimaryNavigationRail } from "../../sidebar/PrimaryNavigationRail";
import { AppDialogProvider } from "../../../lib/appDialogs";
import { GlobalCommandModal } from "../../search/GlobalCommandModal";
import { useAgentsStore } from "../../../stores/agentsStore";
import { useAppStore } from "../../../stores/appStore";
import { useSessionStore } from "../../../stores/sessionStore";
import {
  DEFAULT_WORKSPACE_ID,
  useWorkspacePlatformStore,
} from "../../../stores/workspacePlatformStore";
import { useWorkspaceUiStore } from "../../../stores/workspaceUiStore";
import type { SessionConfig } from "../../../lib/ipc";

const session: SessionConfig = {
  id: "sess-ssh",
  name: "prod-api-01",
  session_type: "SSH",
  group_path: "Prod",
  host: "10.0.0.10",
  port: 22,
  username: "root",
  auth_method: "Password",
  options_json: "{}",
  created_at: 1,
  updated_at: 1,
  last_connected_at: null,
  sort_order: 0,
};

beforeEach(() => {
  window.localStorage.clear();
  useAgentsStore.setState({ tasks: [], selectedTaskId: null });
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useWorkspacePlatformStore.getState().addRootFolder(DEFAULT_WORKSPACE_ID, { path: "/preview", name: "preview" });
  useWorkspaceUiStore.setState({ fsModal: null, sessionPickerOpen: false, sessionPickerWorkspaceId: null, globalSearchOpen: false, agentDispatchOpen: false });
  useAppStore.setState({ activeSideTab: "agents", sidebarCollapsed: false, tabs: [], activeTabId: null, statusMessage: "Ready" });
  useSessionStore.setState({ sessions: [session], groups: [], loading: false, selectedSessionId: null, searchQuery: "" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Agents platform mode (TASK-09)", () => {
  it("keeps Crew as a coming-soon entry without starting tasks or changing the current mode", async () => {
    useAppStore.setState({ activeSideTab: "sessions" });
    render(<AppDialogProvider><PrimaryNavigationRail /></AppDialogProvider>);
    fireEvent.click(screen.getByTestId("nav-mode-agents"));
    expect(await screen.findByTestId("alert-dialog-message")).toHaveTextContent("under development");
    expect(useAgentsStore.getState().tasks).toHaveLength(0);
    expect(useAppStore.getState().activeSideTab).toBe("sessions");
    fireEvent.click(screen.getByTestId("alert-dialog-ok"));
    expect(screen.queryByTestId("alert-dialog")).not.toBeInTheDocument();
  });

  it("shows only the placeholder when a legacy Agents mode is restored", () => {
    render(<AgentsPlatformView />);
    expect(screen.getByTestId("agents-coming-soon")).toHaveTextContent("under development");
    expect(screen.queryByTestId("agents-dispatch-modal")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agents-task-detail")).not.toBeInTheDocument();
  });

  it("UT-WS-09-04 filters workspaces, sessions and actions in the Ctrl+K palette", async () => {
    useWorkspaceUiStore.getState().openGlobalSearch();
    render(<GlobalCommandModal />);
    expect(screen.getByTestId("global-search-modal")).toBeInTheDocument();
    const input = screen.getByTestId("global-search-input");
    fireEvent.change(input, { target: { value: "prod-api" } });
    const sessionResults = screen.getAllByTestId("global-search-result");
    expect(sessionResults.some((result) => result.dataset.kind === "session")).toBe(true);

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(useWorkspaceUiStore.getState().globalSearchOpen).toBe(false));
    const workspace = useWorkspacePlatformStore.getState().workspaces.find((entry) => entry.id === DEFAULT_WORKSPACE_ID)!;
    expect(workspace.openTabs.some((tab) => tab.sessionId === "sess-ssh")).toBe(true);
    expect(useAppStore.getState().activeSideTab).toBe("workspaces");
    expect(useAppStore.getState().tabs).toHaveLength(0);
  });

  it("UT-WS-09-05 searches workspaces and tool actions and opens one with Enter", async () => {
    useWorkspaceUiStore.getState().openGlobalSearch();
    render(<GlobalCommandModal />);
    const input = screen.getByTestId("global-search-input");
    fireEvent.change(input, { target: { value: "mfa" } });
    const results = screen.getAllByTestId("global-search-result");
    expect(results.some((result) => result.dataset.resultId === "floating-mfa")).toBe(true);
    fireEvent.click(results.find((result) => result.dataset.resultId === "floating-mfa")!);
    await waitFor(() => expect(useAppStore.getState().floatingMfa.open).toBe(true));

    act(() => useWorkspaceUiStore.getState().openGlobalSearch());
    fireEvent.change(screen.getByTestId("global-search-input"), { target: { value: "Default Workspace" } });
    const workspaceResult = screen.getByTestId("global-search-result");
    expect(workspaceResult.dataset.kind).toBe("workspace");
    fireEvent.keyDown(screen.getByTestId("global-search-input"), { key: "Enter" });
    expect(useAppStore.getState().activeSideTab).toBe("workspaces");
  });

  it("UT-WS-09-06 closes the palette with Escape even when focus left the dialog", () => {
    act(() => useWorkspaceUiStore.getState().openGlobalSearch());
    render(<GlobalCommandModal />);
    expect(screen.getByTestId("global-search-modal")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useWorkspaceUiStore.getState().globalSearchOpen).toBe(false);
    expect(screen.queryByTestId("global-search-modal")).not.toBeInTheDocument();
  });
});
