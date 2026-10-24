import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { WorkspaceMainPanel } from "../WorkspaceMainPanel";
import { useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";
import { useWorkspaceToolBridgeStore, type WorkspaceToolBridgeController } from "../../../stores/workspaceToolBridgeStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

vi.mock("../../editor/CodeWorkspaceTab", () => ({
  CodeWorkspaceTab: (props: { tabId: string; visible: boolean }) => (
    <div data-testid="code-workspace-tab" data-tab-id={props.tabId} data-visible={String(props.visible)} />
  ),
}));

vi.mock("../../git/WorkspaceGitManager", () => ({
  WorkspaceGitManager: () => <div data-testid="workspace-git-manager" />,
}));

vi.mock("../WorkspaceSessionPanes", () => ({
  WorkspaceSessionPane: ({ tab }: { tab: { id: string; title: string } }) => (
    <div data-testid="workspace-session-pane" data-tab-id={tab.id}>{tab.title}</div>
  ),
}));

function bridge(openFile: WorkspaceToolBridgeController["openFile"]): WorkspaceToolBridgeController {
  return {
    leftToolAreaOpen: true,
    toggleProjectTree: vi.fn(),
    openBottomTool: vi.fn(),
    bottomDockOpen: false,
    moveProjectWindow: vi.fn(),
    openFile,
    refreshProjectTree: vi.fn(),
  };
}

describe("WorkspaceMainPanel file/Git routing", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWorkspacePlatformStore.getState().resetForTests();
    useWorkspaceToolBridgeStore.getState().register(null);
  });

  afterEach(() => cleanup());

  it("opens the active file tab in the mounted editor instance", () => {
    const openFile = vi.fn(async () => undefined);
    useWorkspaceToolBridgeStore.getState().register(bridge(openFile));
    const root = useWorkspacePlatformStore.getState().addRootFolder("default-workspace", { path: "/repo" })!;
    const fileTab = useWorkspacePlatformStore.getState().openWorkspaceFileTab("default-workspace", "/repo/src/a.ts");
    expect(fileTab.rootFolderId).toBe(root.id);

    render(<WorkspaceMainPanel visible />);

    expect(screen.getByTestId("code-workspace-tab").getAttribute("data-tab-id")).toBe("platform-ws-default-workspace");
    expect(openFile).toHaveBeenCalledWith("/repo/src/a.ts", root.id);
  });

  it("keeps session panes of every workspace mounted while another is active", () => {
    const other = useWorkspacePlatformStore.getState().createWorkspace("other");
    useWorkspacePlatformStore.setState({ activeWorkspaceId: "default-workspace" });
    useWorkspacePlatformStore.getState().openSessionInWorkspace(other.id, {
      id: "s-1",
      name: "prod",
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
    });

    render(<WorkspaceMainPanel visible />);

    const panes = screen.getAllByTestId("workspace-session-pane");
    expect(panes).toHaveLength(1);
    expect(panes[0].getAttribute("data-tab-id")).toContain("ws:");
  });

  it("shows the Git-panel compare action on the editor surface but not over session panes", () => {
    useWorkspacePlatformStore.getState().addRootFolder("default-workspace", { path: "/repo" });
    const { unmount } = render(<WorkspaceMainPanel visible />);
    // The editor tab (no file yet) keeps the compare action available.
    expect(screen.getByTestId("editor-open-git-diff")).toBeInTheDocument();
    unmount();

    useWorkspacePlatformStore.getState().openSessionInWorkspace("default-workspace", {
      id: "s-2",
      name: "prod",
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
    });
    render(<WorkspaceMainPanel visible />);
    expect(screen.queryByTestId("editor-open-git-diff")).toBeNull();
  });
});
