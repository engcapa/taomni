import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsPlatformView } from "../AgentsPlatformView";
import { AgentsSidebar } from "../../sidebar/AgentsSidebar";
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
  it("UT-WS-09-01 dispatches a new worktree task from the modal", async () => {
    render(<AgentsPlatformView />);
    expect(screen.getByTestId("agents-empty-state")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("agents-dispatch-open"));
    const modal = screen.getByTestId("agents-dispatch-modal");
    expect(within(modal).getByTestId("agents-dispatch-workspace")).toBeInTheDocument();
    fireEvent.change(within(modal).getByTestId("agents-dispatch-task-input"), {
      target: { value: "Fix the SFTP resume bug" },
    });
    fireEvent.click(within(modal).getByTestId("agents-dispatch-submit"));

    await waitFor(() => expect(useAgentsStore.getState().tasks).toHaveLength(1));
    const task = useAgentsStore.getState().tasks[0];
    expect(task.task).toBe("Fix the SFTP resume bug");
    expect(task.worktree).toContain(".worktrees/");
    expect(task.branch.startsWith("worktree/")).toBe(true);
    expect(useAppStore.getState().activeSideTab).toBe("agents");

    expect(screen.getByTestId("agents-task-detail")).toBeInTheDocument();
    expect(screen.getByTestId("agents-task-detail").textContent).toContain("SFTP resume");
    expect(screen.getByTestId("agents-trace")).toBeInTheDocument();
    expect(screen.getByTestId("agents-task-detail").textContent).toContain("Workspace read/write allowed");
  });

  it("UT-WS-09-02 reviews the worktree diff in the workspace Git panel", async () => {
    const task = useAgentsStore.getState().dispatchTask({
      task: "Update docs",
      model: "OpenAI Codex CLI",
      workspaceId: DEFAULT_WORKSPACE_ID,
      workspaceName: "Default Workspace",
      workspaceRoot: "/preview",
    });
    render(<AgentsPlatformView />);
    expect(useAppStore.getState().activeSideTab).toBe("agents");
    fireEvent.click(screen.getByTestId("agents-review-in-git"));

    expect(useAppStore.getState().activeSideTab).toBe("workspaces");
    const workspace = useWorkspacePlatformStore.getState().workspaces.find((entry) => entry.id === DEFAULT_WORKSPACE_ID)!;
    const gitTab = workspace.openTabs.find((tab) => tab.kind === "git");
    expect(gitTab).toBeTruthy();
    expect(gitTab?.focusPath).toBe(task.worktree);
    expect(workspace.activeTabId).toBe(gitTab?.id);
  });

  it("UT-WS-09-03 lists agent tasks in the sidebar and opens dispatch through the shared store", () => {
    const onDispatchTask = vi.fn(() => useWorkspaceUiStore.getState().openAgentDispatch());
    const task = useAgentsStore.getState().dispatchTask({
      task: "Refactor parser",
      model: "Claude Code",
      workspaceId: DEFAULT_WORKSPACE_ID,
      workspaceName: "Default Workspace",
      workspaceRoot: "/preview",
    });
    render(<AgentsSidebar onDispatchTask={onDispatchTask} />);
    const rows = screen.getAllByTestId("agents-task-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].dataset.taskId).toBe(task.id);
    fireEvent.click(rows[0]);
    expect(useAgentsStore.getState().selectedTaskId).toBe(task.id);
    fireEvent.click(screen.getByTestId("agents-dispatch-task"));
    expect(onDispatchTask).toHaveBeenCalledTimes(1);
    expect(useWorkspaceUiStore.getState().agentDispatchOpen).toBe(true);
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
