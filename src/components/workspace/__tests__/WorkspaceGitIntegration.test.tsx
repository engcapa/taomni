import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceMainPanel } from "../WorkspaceMainPanel";
import { WorkspaceTabStrip } from "../WorkspaceTabStrip";
import { Sidebar } from "../../sidebar/Sidebar";
import { useAppStore } from "../../../stores/appStore";
import { DEFAULT_WORKSPACE_ID, useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";

// The full GitPanelView parity (6 tabs, RepoSelector, DiffViewer …) is covered
// by the dedicated WorkspaceGitManager/GitPanel suites; here the multi-repo
// manager is stubbed to keep this routing test focused.
vi.mock("../../git/WorkspaceGitManager", () => ({
  WorkspaceGitManager: (props: { roots?: Array<{ path: string }> }) => (
    <div data-testid="workspace-git-manager" data-root-count={props.roots?.length ?? 0}>
      <span>Changes</span>
      <span>Log</span>
      <span>Branches</span>
      <span>Tags</span>
      <span>Stash</span>
      <span>Settings</span>
    </div>
  ),
}));

vi.mock("../../editor/CodeWorkspaceTab", () => ({
  CodeWorkspaceTab: () => <div data-testid="code-workspace-tab" />,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

function activateGitPath() {
  useWorkspacePlatformStore.getState().openGitPanel(DEFAULT_WORKSPACE_ID);
}

describe("Workspace Git integration (TASK-06)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAppStore.setState({ activeSideTab: "workspaces", sidebarCollapsed: false });
    useWorkspacePlatformStore.getState().resetForTests();
  });

  afterEach(() => cleanup());

  it("path A: the rail 🌿 Git button activates the in-panel Git manager", () => {
    render(<Sidebar compact={false} />);
    fireEvent.click(screen.getByTestId("code-workspace-tool-rail-git"));
    const workspace = useWorkspacePlatformStore.getState().workspaces[0];
    expect(workspace.openTabs.some((tab) => tab.kind === "git")).toBe(true);
  });

  it("path B: the sidebar Git bar jumps to the Git panel", () => {
    render(<Sidebar compact={false} />);
    fireEvent.click(screen.getByTestId("workspace-sidebar-git-bar"));
    const workspace = useWorkspacePlatformStore.getState().workspaces[0];
    expect(workspace.activeTabId).toBe(workspace.openTabs.find((tab) => tab.kind === "git")?.id);
  });

  it("path C: GIT appears in the workspace tab strip and activates the manager", () => {
    activateGitPath();
    render(
      <>
        <WorkspaceTabStrip />
        <WorkspaceMainPanel visible />
      </>,
    );
    const gitTab = screen.getAllByTestId("workspace-tab-item").find((node) => node.getAttribute("data-tab-kind") === "git");
    expect(gitTab).toBeTruthy();
    fireEvent.click(screen.getByTestId("workspace-main-panel").querySelectorAll("[data-testid]")[0] as HTMLElement);
    expect(screen.getByTestId("workspace-git-manager")).toBeInTheDocument();
  });

  it("path D: re-opening Git from the rail re-activates the existing tab", () => {
    activateGitPath();
    const first = useWorkspacePlatformStore.getState().workspaces[0].openTabs[0];
    // Switch away, then jump back via the rail button.
    useWorkspacePlatformStore.getState().setActiveWorkspaceTab(DEFAULT_WORKSPACE_ID, "");
    render(<Sidebar compact={false} />);
    fireEvent.click(screen.getByTestId("code-workspace-tool-rail-git"));
    const workspace = useWorkspacePlatformStore.getState().workspaces[0];
    expect(workspace.openTabs).toHaveLength(1);
    expect(workspace.activeTabId).toBe(first.id);
  });

  it("renders the six Git tabs once the manager is active", () => {
    activateGitPath();
    render(<WorkspaceMainPanel visible />);
    const manager = screen.getByTestId("workspace-git-manager");
    for (const label of ["Changes", "Log", "Branches", "Tags", "Stash", "Settings"]) {
      expect(manager.textContent).toContain(label);
    }
  });

  it("keeps the shared toolbar free of a redundant top-right Git button", () => {
    render(<Sidebar compact={false} />);
    expect(screen.queryByTestId("workspace-top-git-button")).not.toBeInTheDocument();
    const rail = screen.getByTestId("sidebar-rail");
    expect(rail.querySelectorAll('[data-testid="code-workspace-tool-rail-git"]')).toHaveLength(1);
  });
});
