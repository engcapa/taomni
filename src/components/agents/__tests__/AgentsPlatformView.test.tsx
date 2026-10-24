import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsPlatformView } from "../AgentsPlatformView";
import { GlobalCommandModal } from "../../search/GlobalCommandModal";
import { useAppStore } from "../../../stores/appStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { DEFAULT_WORKSPACE_ID, useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";
import { useAgentTasksStore } from "../agentTasksStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

describe("Agents platform and global search (TASK-09)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAppStore.setState({ activeSideTab: "agents", sidebarCollapsed: false, globalSearchOpen: false });
    useWorkspacePlatformStore.getState().resetForTests();
    useAgentTasksStore.setState({ tasks: [], selectedTaskId: null });
    useSessionStore.setState({
      sessions: [],
      selectedSessionIds: [],
      loading: false,
      groups: [],
      selectedSessionId: null,
      searchQuery: "",
    });
  });

  afterEach(() => cleanup());

  it("renders the orchestrator with worktree sandbox details", () => {
    render(<AgentsPlatformView visible />);
    expect(screen.getByTestId("agents-platform-view")).toBeInTheDocument();
    act(() => {
      useAgentTasksStore.getState().dispatchTask({ title: "Fix flaky test", workspaceId: DEFAULT_WORKSPACE_ID });
    });
    expect(screen.getByTestId("agents-task-list").textContent).toContain("Fix flaky test");
    expect(screen.getByTestId("agents-task-detail").textContent).toContain("agent/task-1");
    expect(screen.getByTestId("agents-task-detail").textContent).toContain("Workspace files");
  });

  it("dispatches a new task through the dialog", () => {
    render(<AgentsPlatformView visible />);
    fireEvent.click(screen.getByTestId("agents-dispatch-task"));
    fireEvent.change(screen.getByTestId("text-input-dialog-input"), { target: { value: "Refactor rail" } });
    fireEvent.click(screen.getByTestId("text-input-dialog-confirm"));
    expect(useAgentTasksStore.getState().tasks[0]?.title).toBe("Refactor rail");
  });

  it("review-diff jumps to the Workspaces Git panel", () => {
    render(<AgentsPlatformView visible />);
    act(() => {
      useAgentTasksStore.getState().dispatchTask({ title: "Task", workspaceId: DEFAULT_WORKSPACE_ID });
    });
    fireEvent.click(screen.getByTestId("agents-task-review-diff"));
    expect(useAppStore.getState().activeSideTab).toBe("workspaces");
    const workspace = useWorkspacePlatformStore.getState().workspaces[0];
    expect(workspace.openTabs.some((tab) => tab.kind === "git")).toBe(true);
  });

  it("the header review button also jumps to the workspace Git panel", () => {
    render(<AgentsPlatformView visible />);
    fireEvent.click(screen.getByTestId("agents-review-diff"));
    expect(useAppStore.getState().activeSideTab).toBe("workspaces");
    expect(useWorkspacePlatformStore.getState().workspaces[0].openTabs.some((tab) => tab.kind === "git")).toBe(true);
  });

  it("Ctrl+K palette searches modes and sessions and runs the first match on Enter", () => {
    useSessionStore.setState({
      sessions: [{
        id: "sess-1",
        name: "prod-gateway",
        session_type: "SSH",
        group_path: null,
        host: "10.0.0.8",
        port: 22,
        username: "root",
        auth_method: "None",
        options_json: "{}",
        created_at: 0,
        updated_at: 0,
        last_connected_at: null,
        sort_order: 0,
      }],
    });
    render(
      <GlobalCommandModal
        open
        onClose={vi.fn()}
        onOpenWorkspaceSession={vi.fn()}
        onOpenGlobalSession={vi.fn()}
      />,
    );
    expect(screen.getByTestId("global-search-modal")).toBeInTheDocument();
    const input = screen.getByTestId("global-search-input");
    fireEvent.change(input, { target: { value: "agents" } });
    expect(screen.getByTestId("global-search-go-agents")).toHaveAttribute("data-first");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useAppStore.getState().activeSideTab).toBe("agents");

    fireEvent.change(input, { target: { value: "prod-gateway" } });
    expect(screen.getByTestId("global-search-session-ws-sess-1")).toBeInTheDocument();
    expect(screen.getByTestId("global-search-session-global-sess-1")).toBeInTheDocument();
  });
});
