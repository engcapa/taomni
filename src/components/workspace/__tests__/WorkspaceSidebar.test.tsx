import { invoke } from "@tauri-apps/api/core";
import { open as chooseFolder } from "@tauri-apps/plugin-dialog";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSidebar } from "../WorkspaceSidebar";
import { WorkspaceMainPanel } from "../WorkspaceMainPanel";
import { useAppStore } from "../../../stores/appStore";
import {
  DEFAULT_WORKSPACE_ID,
  useWorkspacePlatformStore,
} from "../../../stores/workspacePlatformStore";
import { useWorkspaceUiStore } from "../../../stores/workspaceUiStore";
import { useWorkspaceEditorStore } from "../../../stores/workspaceEditorStore";
import { AppDialogProvider } from "../../../lib/appDialogs";
import { useCodeWorkspaceStore } from "../../../stores/codeWorkspaceStore";
import { workspaceBoundary } from "./workspaceBoundary";
import { useSessionStore } from "../../../stores/sessionStore";

vi.mock("../workspaceFs", async () => {
  const actual = await vi.importActual<typeof import("../workspaceFs")>("../workspaceFs");
  return {
    ...actual,
    listWorkspaceDirectory: vi.fn(async () => [
      { name: "src", path: "src", fileType: "dir", size: 0, mtime: 0, isHidden: false },
      { name: "README.md", path: "README.md", fileType: "file", size: 12, mtime: 0, isHidden: false },
    ]),
    createWorkspaceFileNode: vi.fn(async (_root: string, path: string) => ({
      path, text: "", size: 0, mtime: 0, hash: "new-hash",
    })),
    createWorkspaceFolderNode: vi.fn(async (_root: string, path: string) => ({
      name: path, path, fileType: "dir", size: 0, mtime: 0, isHidden: false,
    })),
    readWorkspaceText: vi.fn(async (_root: string, path: string) => ({
      path, text: "export const value = 1;\n", encoding: "utf-8", bom: false, size: 24, mtime: 0, hash: "hash",
    })),
    writeWorkspaceText: vi.fn(async (_root: string, path: string, text: string) => ({
      path, text, size: text.length, mtime: 0, hash: "written",
    })),
    deleteWorkspaceEntry: vi.fn(async () => undefined),
    renameWorkspaceEntry: vi.fn(async () => ({ name: "x", path: "x", fileType: "file", size: 0, mtime: 0, isHidden: false })),
  };
});

vi.mock("../../../lib/git", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/git")>(),
  gitProbePath: vi.fn(async () => ({ path: "/preview", gitAvailable: true, isRepo: true, repoRoot: "/preview", error: null })),
  gitSnapshot: vi.fn(async () => ({
    repoRoot: "/preview",
    currentBranch: "main",
    headOid: "abc",
    detached: false,
    upstream: "origin/main",
    ahead: 1,
    behind: 0,
    changes: [{ path: "README.md", status: "M" }],
    remotes: [{ name: "origin", url: "git@example.test:repo.git" }],
    tags: [],
    branches: [],
    stash: [],
  })),
}));

vi.mock("../WorkspaceFileEditor", () => ({
  WorkspaceFileEditor: ({ tab }: { tab: { filePath?: string } }) => (
    <div data-testid="workspace-file-editor" data-path={tab.filePath}>editor</div>
  ),
}));

vi.mock("../WorkspaceGitPanel", () => ({
  WorkspaceGitPanel: () => <div data-testid="workspace-git-panel-mock">git</div>,
}));

vi.mock("../WorkspaceSessionPane", () => ({
  WorkspaceSessionPane: () => <div data-testid="workspace-session-pane-mock">session</div>,
}));

vi.mock("@tauri-apps/api/core", async () => {
  const { workspaceBoundary } = await import("./workspaceBoundary");
  return { invoke: vi.fn(workspaceBoundary.invoke) };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => "/repo/extra") }));

function Shell() {
  return (
    <AppDialogProvider>
      <WorkspaceSidebar onOpenSessionPicker={vi.fn()} />
      <WorkspaceMainPanel />
    </AppDialogProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  workspaceBoundary.reset();
  useCodeWorkspaceStore.setState({ byInstanceId: {} });
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useWorkspaceUiStore.setState({ fsModal: null, sessionPickerOpen: false, globalSearchOpen: false, agentDispatchOpen: false });
  useWorkspaceEditorStore.setState({ documents: {}, activeTabId: null });
  useAppStore.setState({ activeSideTab: "workspaces", sidebarCollapsed: false, statusMessage: "Ready", codeWorkspaceByTab: {} });
  useSessionStore.setState({ sessions: [], groups: [], loading: false, selectedSessionId: null, searchQuery: "" });
  const workspace = useWorkspacePlatformStore.getState();
  workspace.addRootFolder(DEFAULT_WORKSPACE_ID, { path: "/preview", name: "preview" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkspaceSidebar (TASK-05)", () => {
  it("UT-WS-05-01 shows the workspace switcher at the top with the undeletable default workspace", () => {
    const custom = useWorkspacePlatformStore.getState().createWorkspace({ name: "custom-ws" });
    useWorkspacePlatformStore.getState().setActiveWorkspace(DEFAULT_WORKSPACE_ID);
    render(<Shell />);

    const switcher = screen.getByTestId("workspace-switcher");
    expect(switcher).toBeInTheDocument();
    expect(within(switcher).getByTestId("workspace-default-badge")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-switcher-button").textContent).toContain("Default Workspace");

    fireEvent.click(screen.getByTestId("workspace-switcher-button"));
    const menu = screen.getByTestId("workspace-switcher-menu");
    expect(within(menu).getByTestId(`workspace-switcher-option-${DEFAULT_WORKSPACE_ID}`)).toBeInTheDocument();
    fireEvent.click(within(menu).getByTestId(`workspace-switcher-option-${custom.id}`));
    expect(useWorkspacePlatformStore.getState().activeWorkspaceId).toBe(custom.id);
    expect(useWorkspacePlatformStore.getState().deleteWorkspace(DEFAULT_WORKSPACE_ID)).toBe(false);
  });

  it("UT-WS-05-02 never renders the removed Files | Git toggle row and keeps the Git status bar", () => {
    render(<Shell />);
    expect(screen.queryByTestId("workspace-files-tab")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace-git-toggle-row")).not.toBeInTheDocument();
    expect(screen.queryByText("文件管理")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-sidebar-git-bar")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-sidebar-panel")).toBeInTheDocument();
  });

  it("UT-WS-05-03 creates a file from the toolbar and opens it in the editor", async () => {
    render(<Shell />);
    const tree = await screen.findByTestId("code-workspace-tree");
    expect(screen.getByTestId("workspace-editor-tool-host")).toContainElement(tree);
    fireEvent.click(await screen.findByTestId("code-workspace-tree-root"));
    fireEvent.click(screen.getByTestId("code-workspace-tree-new"));
    fireEvent.click(screen.getByTestId("code-workspace-tree-new-file"));
    const modal = await screen.findByTestId("text-input-dialog");
    fireEvent.change(within(modal).getByTestId("text-input-dialog-input"), { target: { value: "notes.ts" } });
    fireEvent.click(within(modal).getByTestId("text-input-dialog-confirm"));
    await waitFor(() => expect(useWorkspacePlatformStore.getState().getWorkspace()!.openTabs.some((tab) => tab.kind === "file" && tab.filePath === "notes.ts")).toBe(true));
    expect(workspaceBoundary.files.has("notes.ts")).toBe(true);
    expect(screen.getByTestId("workspace-file-editor").dataset.path).toBe("notes.ts");
    expect(screen.queryByTestId("workspace-new-file")).not.toBeInTheDocument();
  });

  it("UT-WS-05-04 creates a directory from the shared root context menu", async () => {
    render(<Shell />);
    fireEvent.contextMenu(await screen.findByTestId("code-workspace-tree-root"));
    fireEvent.click(screen.getByText("New Directory..."));
    const modal = await screen.findByTestId("text-input-dialog");
    fireEvent.change(within(modal).getByTestId("text-input-dialog-input"), { target: { value: "docs" } });
    fireEvent.click(within(modal).getByTestId("text-input-dialog-confirm"));
    await waitFor(() => expect(workspaceBoundary.directories.has("docs")).toBe(true));
  });

  it("UT-WS-05-05 mounts an extra root through the shared folder picker", async () => {
    render(<Shell />);
    fireEvent.click(await screen.findByTestId("code-workspace-tree-new"));
    fireEvent.click(screen.getByTestId("code-workspace-tree-add-folder"));
    await waitFor(() => expect(useWorkspacePlatformStore.getState().getWorkspace()!.rootFolders.map((root) => root.path)).toContain("/repo/extra"));
    expect(screen.getAllByTestId("code-workspace-tree-root")).toHaveLength(2);
  });

  it("UT-WS-05-06 shows branch and change count in the bottom Git bar and opens the Git tab", async () => {
    render(<Shell />);
    const bar = screen.getByTestId("workspace-sidebar-git-bar");
    await waitFor(() => expect(bar.dataset.branch).toBe("main"));
    expect(bar.dataset.changes).toBe("1");
    fireEvent.click(bar);
    const workspace = useWorkspacePlatformStore.getState().workspaces.find((entry) => entry.id === DEFAULT_WORKSPACE_ID)!;
    expect(workspace.openTabs.some((tab) => tab.kind === "git")).toBe(true);
    expect(screen.getByTestId("workspace-git-panel-mock")).toBeInTheDocument();
  });
});


it("keeps an empty default workspace as a file explorer with a HOME chooser and collapsed sessions", async () => {
  const store = useWorkspacePlatformStore.getState();
  for (const root of store.getWorkspace()!.rootFolders) store.removeRootFolder(DEFAULT_WORKSPACE_ID, root.id);
  vi.mocked(invoke).mockImplementation(async (command, args) => command === "get_home_dir"
    ? "/home/qa" : workspaceBoundary.invoke(command, args as Record<string, unknown>) as never);
  render(<Shell />);
  expect(await screen.findByTestId("code-workspace-tree-empty")).toBeVisible();
  expect(screen.getByTestId("workspace-linked-sessions-toggle")).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByTestId("code-workspace-tree-open-file")).toBeVisible();
  fireEvent.click(screen.getByTestId("code-workspace-tree-add-folder"));
  await waitFor(() => expect(chooseFolder).toHaveBeenCalledWith(expect.objectContaining({ directory: true, defaultPath: "/home/qa" })));
  expect(await screen.findByTestId("code-workspace-tree-root")).toHaveAttribute("data-root-path", "/repo/extra");
  expect(store.getWorkspace()!.rootFolders.map((root) => root.path)).toEqual(["/repo/extra"]);
  fireEvent.click(screen.getByTestId("workspace-switcher-button"));
  expect(screen.getAllByTestId("workspace-switcher-add-folder")).toHaveLength(1);
  expect(screen.queryByTestId("workspace-switcher-menu-add-folder")).not.toBeInTheDocument();
});

it("opens folders, ordinary files and sort controls while code and Git discovery are unresolved", async () => {
  const pending: Array<() => void> = [];
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (["lsp_detect_servers", "workspace_list_files_recursive", "workspace_detect_git_roots", "project_structure_get"].includes(command)) {
      return new Promise((resolve) => pending.push(() => resolve([] as never)));
    }
    return workspaceBoundary.invoke(command, args as Record<string, unknown>) as never;
  });
  render(<Shell />);
  const arrow = await screen.findByTestId("code-workspace-tree-dir-arrow");
  fireEvent.click(arrow);
  // README and nested source are visible before any discovery result lands.
  const source = await waitFor(() => {
    const row = document.querySelector<HTMLElement>('[data-testid="code-workspace-tree-file"][data-path="src/index.ts"]');
    expect(row).toBeVisible();
    return row!;
  });
  fireEvent.doubleClick(source);
  await waitFor(() => expect(screen.getByTestId("workspace-file-editor").querySelector(".cm-content")).toHaveTextContent("export const value = 1;"));
  expect(pending.length).toBeGreaterThan(0);
  fireEvent.click(screen.getByTestId("code-workspace-tree-view-selector"));
  fireEvent.click(screen.getByTestId("code-workspace-tree-view-list"));
  fireEvent.click(screen.getByTestId("code-workspace-list-sort-size"));
  expect(screen.getByTestId("code-workspace-list-sort-size")).toHaveAttribute("aria-pressed", "true");
  // A late old scan must not replace the active workspace or its empty tree.
  let next = "";
  act(() => { next = useWorkspacePlatformStore.getState().createWorkspace({ name: "Empty next" }).id; });
  await act(async () => pending.splice(0).forEach((resolve) => resolve()));
  expect(useWorkspacePlatformStore.getState().activeWorkspaceId).toBe(next);
  expect(screen.getByTestId("code-workspace-tree-empty")).toBeVisible();
  expect(useWorkspacePlatformStore.getState().getWorkspace()!.rootFolders).toEqual([]);
});
