import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useCallback, useState } from "react";
import type { WorkspaceCommandRegistration } from "../../editor/workspace/workspaceCommands";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceGitPanel } from "../WorkspaceGitPanel";
import { WorkspaceFileEditor } from "../WorkspaceFileEditor";
import { WorkspaceTabStrip } from "../WorkspaceTabStrip";
import { WorkspaceSidebar } from "../WorkspaceSidebar";
import { WorkspaceMainPanel } from "../WorkspaceMainPanel";
import { PrimaryNavigationRail } from "../../sidebar/PrimaryNavigationRail";
import { useAppStore } from "../../../stores/appStore";
import {
  DEFAULT_WORKSPACE_ID,
  useWorkspacePlatformStore,
} from "../../../stores/workspacePlatformStore";
import { useWorkspaceEditorStore } from "../../../stores/workspaceEditorStore";
import { useWorkspaceUiStore } from "../../../stores/workspaceUiStore";
import { useCodeWorkspaceStore } from "../../../stores/codeWorkspaceStore";
import { useWorkspaceRailStore } from "../../../stores/workspaceRailStore";
import { useMainRailHostStore } from "../../../stores/mainRailHostStore";
import { AppDialogProvider } from "../../../lib/appDialogs";
import { workspaceBoundary } from "./workspaceBoundary";

vi.mock("@tauri-apps/api/core", async () => {
  const { workspaceBoundary } = await import("./workspaceBoundary");
  return { invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "workspace_detect_git_roots") {
      return (args.roots as { id: string; name: string; path: string }[]).map((root) => ({
        ...root, repoRoot: root.path, rootIds: [root.id],
      }));
    }
    return workspaceBoundary.invoke(command, args);
  }) };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));

const snapshot = {
  repoRoot: "/preview",
  currentBranch: "main",
  headOid: "abc123",
  detached: false,
  upstream: "origin/main",
  ahead: 1,
  behind: 0,
  changes: [
    { path: "README.md", oldPath: null, status: "M", staged: false, unstaged: true, conflict: false },
    { path: "src/index.ts", oldPath: null, status: "A", staged: true, unstaged: false, conflict: false },
  ],
  remotes: [{ name: "origin", url: "git@example.test:repo.git" }],
  branches: [
    { name: "main", fullName: "refs/heads/main", current: true, remote: false, upstream: "origin/main", oid: "abc123", subject: "init", date: null },
    { name: "origin/main", fullName: "refs/remotes/origin/main", current: false, remote: true, upstream: null, oid: "abc123", subject: "init", date: null },
  ],
  stashes: [],
  tags: [{ name: "v1.0.0", oid: "abc123", subject: "release", annotated: false, date: null }],
  settings: {
    userName: "QA", userEmail: "qa@example.test", httpProxy: null, httpsProxy: null,
    pullRebase: null, pushDefault: null, coreAutocrlf: null, coreFilemode: null, commitGpgsign: null,
  },
};

vi.mock("../../../lib/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/git")>();
  return {
    ...actual,
    gitProbePath: vi.fn(async () => ({ path: "/preview", gitAvailable: true, isRepo: true, repoRoot: "/preview", error: null })),
    gitSnapshot: vi.fn(async () => snapshot),
    gitStage: vi.fn(async () => undefined),
    gitUnstage: vi.fn(async () => undefined),
    gitCommit: vi.fn(async () => "oid"),
    gitPush: vi.fn(async () => undefined),
    gitFetch: vi.fn(async () => undefined),
    gitPull: vi.fn(async () => undefined),
    gitDiff: vi.fn(async () => "diff --git a/README.md b/README.md\n"),
    gitBlobPair: vi.fn(async () => ({
      oldLabel: "HEAD",
      newLabel: "Worktree",
      oldText: "a\n",
      newText: "b\n",
      oldExists: true,
      newExists: true,
      binary: false,
      truncated: false,
    })),
  };
});

vi.mock("../workspaceFs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspaceFs")>();
  return {
    ...actual,
    readWorkspaceText: vi.fn(async (_root: string, path: string) => ({
      path, text: "export function greet() {\n  return 1;\n}\n", encoding: "utf-8", bom: false, size: 40, mtime: 0, hash: "h",
    })),
    writeWorkspaceText: vi.fn(async (_root: string, path: string, text: string) => ({
      path, text, size: text.length, mtime: 0, hash: "h2",
    })),
    listWorkspaceDirectory: vi.fn(async () => []),
  };
});

const onOpenFile = vi.fn();

function activeWorkspace() {
  return useWorkspacePlatformStore.getState().workspaces.find((entry) => entry.id === DEFAULT_WORKSPACE_ID)!;
}

function Shell() {
  return <AppDialogProvider>
    <PrimaryNavigationRail railHostRef={useMainRailHostStore.getState().setHost} />
    <WorkspaceSidebar onOpenSessionPicker={vi.fn()} />
    <WorkspaceMainPanel />
  </AppDialogProvider>;
}

function RegisteredShell() {
  const [commands, setCommands] = useState<Record<string, WorkspaceCommandRegistration>>({});
  const onCommandsChange = useCallback((tabId: string, registration: WorkspaceCommandRegistration | null) => {
    setCommands((current) => {
      if (registration) return current[tabId] === registration ? current : { ...current, [tabId]: registration };
      const next = { ...current };
      delete next[tabId];
      return next;
    });
  }, []);
  return <AppDialogProvider>
    <output data-testid="registered-workspaces">{Object.keys(commands).length}</output>
    <PrimaryNavigationRail railHostRef={useMainRailHostStore.getState().setHost} />
    <WorkspaceSidebar onOpenSessionPicker={vi.fn()} />
    <WorkspaceMainPanel onCommandsChange={onCommandsChange} />
  </AppDialogProvider>;
}

beforeEach(() => {
  window.localStorage.clear();
  workspaceBoundary.reset();
  useCodeWorkspaceStore.setState({ byInstanceId: {} });
  useWorkspaceRailStore.setState({ forceMerge: true });
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useWorkspaceUiStore.setState({ fsModal: null, sessionPickerOpen: false, globalSearchOpen: false, agentDispatchOpen: false });
  useWorkspaceEditorStore.setState({ documents: {}, activeTabId: null });
  useAppStore.setState({ activeSideTab: "workspaces", sidebarCollapsed: false, statusMessage: "Ready", codeWorkspaceByTab: {} });
  useWorkspacePlatformStore.getState().addRootFolder(DEFAULT_WORKSPACE_ID, { path: "/preview", name: "preview" });
  onOpenFile.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Workspace Git integration (TASK-06)", () => {
  it("keeps directory additions stable with the main window's command registration loop", async () => {
    for (const root of activeWorkspace().rootFolders) {
      useWorkspacePlatformStore.getState().removeRootFolder(DEFAULT_WORKSPACE_ID, root.id);
    }
    render(<RegisteredShell />);
    await screen.findByTestId("code-workspace-tree-empty");
    await waitFor(() => expect(screen.getByTestId("registered-workspaces")).toHaveTextContent("1"));
    act(() => {
      useWorkspacePlatformStore.getState().addRootFolder(DEFAULT_WORKSPACE_ID, { path: "/preview", name: "preview" });
    });
    await waitFor(() => expect(screen.queryByTestId("code-workspace-tree-empty")).not.toBeInTheDocument());
    await screen.findByTestId("code-workspace-tree-root-arrow");
    await waitFor(() => expect(screen.getByTestId("code-workspace-tree-root")).toHaveAttribute("aria-expanded", "true"));
    expect(activeWorkspace().rootFolders.map((root) => root.path)).toEqual(["/preview"]);
    act(() => {
      useWorkspacePlatformStore.getState().addRootFolder(DEFAULT_WORKSPACE_ID, { path: "/preview-two", name: "second" });
    });
    await waitFor(() => expect(screen.getAllByTestId("code-workspace-tree-root-arrow")).toHaveLength(2));
    expect(activeWorkspace().rootFolders.map((root) => root.path)).toEqual(["/preview", "/preview-two"]);
  });

  it.each([false, true])("uses the real shared rail and overflow with folders=%s", async (hasFolders) => {
    if (!hasFolders) useWorkspacePlatformStore.getState().reloadFromStorage();
    if (!hasFolders) {
      for (const root of activeWorkspace().rootFolders) {
        useWorkspacePlatformStore.getState().removeRootFolder(DEFAULT_WORKSPACE_ID, root.id);
      }
    }
    render(<Shell />);
    const project = await screen.findByTestId("code-workspace-tool-rail-project");
    const rail = screen.getByTestId("sidebar-tool-window-rail");
    expect(rail).toContainElement(project);
    for (const id of ["project", "sessions", "git"]) {
      expect(screen.getAllByTestId(`code-workspace-tool-rail-${id}`)).toHaveLength(1);
    }
    fireEvent.click(within(rail).getByTestId("code-workspace-bottom-tab-overflow"));
    const menu = await screen.findByTestId("code-workspace-bottom-tab-overflow-menu");
    for (const id of ["terminal", "problems", "run", "search", "todos", "build", "tests", "coverage", "debug", "structure"]) {
      expect(within(menu).getByTestId(`code-workspace-bottom-tab-overflow-${id}`)).toBeVisible();
    }
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(project);
    expect(screen.getByTestId("code-workspace-tree")).not.toBeVisible();
    fireEvent.click(project);
    expect(await screen.findByTestId("code-workspace-tree")).toBeVisible();
    if (!hasFolders) expect(screen.getByTestId("code-workspace-tree-empty")).toBeVisible();
  });

  it("UT-WS-06-01 has no redundant Git button in the workspace chrome", async () => {
    render(<Shell />);
    // The old top-right `🌿 Git` button (marker 3) and the removed
    // [Files | Git] row (marker 1) are gone; the rail button and the bottom bar
    // are the only workspace entries.
    expect(screen.queryByTestId("workspace-topbar-git-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace-git-toggle-row")).not.toBeInTheDocument();
    expect(await screen.findByTestId("code-workspace-tool-rail-git")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-sidebar-git-bar")).toBeInTheDocument();
  });

  it("UT-WS-06-02 opens the Git panel from the primary rail Git button", async () => {
    render(<Shell />);
    fireEvent.click(await screen.findByTestId("code-workspace-tool-rail-git"));
    const workspace = activeWorkspace();
    expect(workspace.openTabs.some((tab) => tab.kind === "git")).toBe(true);
    expect(workspace.activeTabId).toBe(`ws:${DEFAULT_WORKSPACE_ID}:git`);
    expect(await screen.findByTestId("git-panel")).toBeVisible();
    expect(screen.queryByTestId("workspace-file-editor")).not.toBeInTheDocument();
  });

  it("UT-WS-06-03 opens the Git panel from the sidebar status bar", () => {
    render(<WorkspaceSidebar onOpenSessionPicker={vi.fn()} />);
    fireEvent.click(screen.getByTestId("workspace-sidebar-git-bar"));
    expect(activeWorkspace().openTabs.some((tab) => tab.kind === "git")).toBe(true);
  });

  it("UT-WS-06-04 exposes the editor compare-in-Git action for the active file", async () => {
    const workspace = activeWorkspace();
    const tab = useWorkspacePlatformStore.getState().openFileInWorkspace(DEFAULT_WORKSPACE_ID, {
      rootId: workspace.rootFolders[0].id,
      path: "README.md",
    });
    const onOpenGitDiff = vi.fn((path: string) => {
      useWorkspacePlatformStore.getState().openGitTab(DEFAULT_WORKSPACE_ID, path);
    });
    render(
      <WorkspaceFileEditor
        workspace={activeWorkspace()}
        tab={tab}
        visible
        onOpenGitDiff={onOpenGitDiff}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("workspace-editor-title").textContent).toContain("README.md"));
    fireEvent.click(screen.getByTestId("editor-open-git-diff"));
    expect(onOpenGitDiff).toHaveBeenCalledWith("README.md");
    expect(activeWorkspace().openTabs.find((entry) => entry.kind === "git")?.focusPath).toBe("README.md");
  });

  it("UT-WS-06-05 activates the Git tab from the workspace tab strip", () => {
    const gitTab = useWorkspacePlatformStore.getState().openGitTab(DEFAULT_WORKSPACE_ID);
    useWorkspacePlatformStore.getState().openLocalTerminalInWorkspace(DEFAULT_WORKSPACE_ID);
    render(<WorkspaceTabStrip />);
    const tabs = screen.getAllByTestId("workspace-tab");
    const git = tabs.find((tab) => tab.dataset.tabKind === "git");
    expect(git).toBeTruthy();
    fireEvent.click(git!);
    expect(activeWorkspace().activeTabId).toBe(gitTab.id);
    expect(git!.getAttribute("data-active")).toBe("true");
  });

  it("UT-WS-06-06 keeps the full six-tab Git surface with tree/amend/diff controls", async () => {
    render(<WorkspaceGitPanel workspace={activeWorkspace()} visible />);
    await waitFor(() => expect(screen.getByTestId("git-panel")).toBeInTheDocument());
    const panel = screen.getByTestId("git-panel");
    for (const testId of ["git-changes-tab", "git-log-tab", "git-branches-tab", "git-tags-tab", "git-stash-tab", "git-settings-tab"]) {
      expect(within(panel).getByTestId(testId)).toBeInTheDocument();
    }
    await waitFor(() => expect(within(panel).getByTestId("git-changes-tree-toggle")).toBeInTheDocument());
    const treeToggle = within(panel).getByTestId("git-changes-tree-toggle");
    const initialMode = treeToggle.getAttribute("data-tree-mode");
    fireEvent.click(treeToggle);
    expect(within(panel).getByTestId("git-changes-tree-toggle")).toHaveAttribute(
      "data-tree-mode",
      initialMode === "tree" ? "flat" : "tree",
    );
    await waitFor(() => expect(within(panel).getByTestId("git-commit-amend")).toBeInTheDocument());
    expect(within(panel).getByTestId("git-commit-message")).toBeInTheDocument();
    expect(within(panel).getByTestId("git-commit-button")).toBeInTheDocument();
    expect(within(panel).getByTestId("git-commit-and-push")).toBeInTheDocument();
  });

  it("UT-WS-06-07 exposes the multi-repository selector for multi-root workspaces", async () => {
    useWorkspacePlatformStore.getState().addRootFolder(DEFAULT_WORKSPACE_ID, { path: "/preview-two", name: "second" });
    render(<WorkspaceGitPanel workspace={activeWorkspace()} visible />);
    await waitFor(() => expect(screen.getByTestId("workspace-git-manager")).toBeInTheDocument());
    expect(screen.getByTestId("workspace-repo-selector")).toBeInTheDocument();
    for (const testId of ["git-changes-tab", "git-log-tab", "git-branches-tab", "git-tags-tab", "git-stash-tab", "git-settings-tab"]) {
      expect(within(screen.getByTestId("git-panel")).getByTestId(testId)).toBeInTheDocument();
    }
  });
});
