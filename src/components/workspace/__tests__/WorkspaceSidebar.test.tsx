import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSidebar } from "../WorkspaceSidebar";
import { Sidebar } from "../../sidebar/Sidebar";
import { useAppStore } from "../../../stores/appStore";
import { DEFAULT_WORKSPACE_ID, useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "workspace_create_file" || command === "workspace_create_dir") return { path: "created" };
    return undefined;
  }),
}));

describe("WorkspaceSidebar (TASK-05)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAppStore.setState({ activeSideTab: "workspaces", sidebarCollapsed: false });
    useWorkspacePlatformStore.getState().resetForTests();
  });

  afterEach(() => cleanup());

  it("places the workspace switcher at the top and lists the Default Workspace", () => {
    render(<WorkspaceSidebar />);
    const sidebar = screen.getByTestId("workspace-sidebar");
    const switcher = within(sidebar).getByTestId("workspace-switcher");
    expect(switcher.textContent).toContain("Default Workspace");
    // The switcher sits above the quick-create toolbar in DOM order.
    const toolbar = within(sidebar).getByTestId("workspace-new-file");
    expect(switcher.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByTestId("workspace-switcher"));
    expect(screen.getByTestId("workspace-switcher-menu")).toBeInTheDocument();
    const defaultItem = screen.getByTestId(`workspace-switcher-item-${DEFAULT_WORKSPACE_ID}`);
    expect(defaultItem.textContent).toContain("Default Workspace");
    expect(screen.getByTestId("workspace-switcher-default-badge")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-switcher-new")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-switcher-add-folder")).toBeInTheDocument();
  });

  it("UT guard: the legacy [文件管理 | Git 面板] switch row is gone", () => {
    render(<WorkspaceSidebar />);
    expect(screen.queryByTestId("workspace-view-switch")).not.toBeInTheDocument();
    const text = screen.getByTestId("workspace-sidebar").textContent ?? "";
    expect(text).not.toContain("Git 面板");
  });

  it("creates a file through the toolbar and opens it as a workspace tab", async () => {
    useWorkspacePlatformStore.getState().addRootFolder(DEFAULT_WORKSPACE_ID, { path: "/repo/demo" });
    render(<WorkspaceSidebar />);
    fireEvent.click(screen.getByTestId("workspace-new-file"));
    const input = await screen.findByTestId("text-input-dialog-input");
    fireEvent.change(input, { target: { value: "src/index.ts" } });
    fireEvent.click(screen.getByTestId("text-input-dialog-confirm"));

    await waitFor(() => {
      const workspace = useWorkspacePlatformStore.getState().workspaces[0];
      expect(workspace.openTabs.some((tab) => tab.kind === "file")).toBe(true);
    });
    const workspace = useWorkspacePlatformStore.getState().workspaces[0];
    const fileTab = workspace.openTabs.find((tab) => tab.kind === "file");
    expect(fileTab?.filePath).toContain("src/index.ts");
    expect(workspace.activeTabId).toBe(fileTab?.id);
  });

  it("creates a folder through the toolbar", async () => {
    useWorkspacePlatformStore.getState().addRootFolder(DEFAULT_WORKSPACE_ID, { path: "/repo/demo" });
    render(<WorkspaceSidebar />);
    fireEvent.click(screen.getByTestId("workspace-new-folder"));
    const input = await screen.findByTestId("text-input-dialog-input");
    fireEvent.change(input, { target: { value: "src/utils" } });
    fireEvent.click(screen.getByTestId("text-input-dialog-confirm"));
    // No tab is opened for a folder, and no error state appears.
    expect(useWorkspacePlatformStore.getState().workspaces[0].openTabs).toHaveLength(0);
  });

  it("adds and removes multi-root folders", async () => {
    render(<WorkspaceSidebar />);
    fireEvent.click(screen.getByTestId("workspace-add-folder"));
    const input = screen.getByTestId("text-input-dialog-input");
    fireEvent.change(input, { target: { value: "/repo/first" } });
    fireEvent.click(screen.getByTestId("text-input-dialog-confirm"));
    await waitFor(() => {
      expect(useWorkspacePlatformStore.getState().workspaces[0].rootFolders).toHaveLength(1);
    });

    fireEvent.click(screen.getByTestId("workspace-add-folder"));
    const input2 = screen.getByTestId("text-input-dialog-input");
    fireEvent.change(input2, { target: { value: "/repo/second" } });
    fireEvent.click(screen.getByTestId("text-input-dialog-confirm"));
    await waitFor(() => {
      expect(useWorkspacePlatformStore.getState().workspaces[0].rootFolders.map((root) => root.path)).toEqual(["/repo/first", "/repo/second"]);
    });

    const rootId = useWorkspacePlatformStore.getState().workspaces[0].rootFolders[0].id;
    fireEvent.click(screen.getByTestId(`workspace-remove-root-${rootId}`));
    expect(useWorkspacePlatformStore.getState().workspaces[0].rootFolders.map((root) => root.path)).toEqual(["/repo/second"]);
  });

  it("keeps the persistent Git bar that jumps to the Git panel", () => {
    render(<WorkspaceSidebar />);
    const gitBar = screen.getByTestId("workspace-sidebar-git-bar");
    expect(gitBar).toBeInTheDocument();
    fireEvent.click(gitBar);
    const workspace = useWorkspacePlatformStore.getState().workspaces[0];
    expect(workspace.openTabs.some((tab) => tab.kind === "git")).toBe(true);
    expect(workspace.activeTabId).toBe(workspace.openTabs.find((tab) => tab.kind === "git")?.id);
  });

  it("switches lens via the rail buttons (sessions lens lists pinned sessions)", () => {
    render(<Sidebar compact={false} />);
    // Rail buttons flip the lens through the store.
    fireEvent.click(screen.getByTestId("code-workspace-tool-rail-sessions"));
    expect(useWorkspacePlatformStore.getState().workspaces[0].activeLeftToolWindow).toBe("sessions");
    expect(screen.getByTestId("workspace-sessions-lens")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-sessions-search")).toBeInTheDocument();
  });
});
