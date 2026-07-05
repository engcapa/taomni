import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../stores/appStore";
import type { GitSnapshot } from "../../lib/git";
import { WorkspaceGitManager } from "./WorkspaceGitManager";

const gitMocks = vi.hoisted(() => ({
  GIT_REF_WORKTREE: ":WORKTREE",
  gitBlobPair: vi.fn(),
  gitCleanUntracked: vi.fn(),
  gitCommit: vi.fn(),
  gitChangeLabel: vi.fn((change: { conflict?: boolean; status: string }) => (
    change.conflict ? "Conflicted" : change.status[0]?.toUpperCase() + change.status.slice(1)
  )),
  gitDiscard: vi.fn(),
  gitFetch: vi.fn(),
  gitPull: vi.fn(),
  gitPush: vi.fn(),
  gitRepoName: vi.fn((repoRoot: string) => repoRoot.split("/").pop() ?? repoRoot),
  gitSnapshot: vi.fn(),
  gitStage: vi.fn(),
  gitUnstage: vi.fn(),
  selectedRemote: vi.fn(() => null),
}));

const dialogMocks = vi.hoisted(() => ({
  alertAppDialog: vi.fn(),
  confirmAppDialog: vi.fn(),
}));

vi.mock("../../lib/git", () => gitMocks);

vi.mock("../../lib/appDialogs", () => dialogMocks);

vi.mock("./GitPanel", () => ({
  GitPanel: ({ repoRoot, changesView, workspaceHeader }: any) => (
    <div data-testid="git-panel" data-repo-root={repoRoot}>
      <div data-testid="mock-git-header">
        {workspaceHeader?.repoSelector}
        {workspaceHeader?.actionControls}
      </div>
      {changesView}
    </div>
  ),
}));

function snapshot(
  repoRoot: string,
  changes: GitSnapshot["changes"] = [],
  overrides: Partial<GitSnapshot> = {},
): GitSnapshot {
  const base: GitSnapshot = {
    repoRoot,
    currentBranch: "main",
    headOid: "abc123",
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    changes,
    remotes: [],
    branches: [],
    stashes: [],
    tags: [],
    settings: {
      userName: null,
      userEmail: null,
      httpProxy: null,
      httpsProxy: null,
      pullRebase: null,
      pushDefault: null,
      coreAutocrlf: null,
      coreFilemode: null,
      commitGpgsign: null,
    },
  };
  return {
    ...base,
    ...overrides,
    settings: {
      ...base.settings,
      ...(overrides.settings ?? {}),
    },
  };
}

function change(path: string): GitSnapshot["changes"][number] {
  return {
    path,
    oldPath: null,
    status: "modified",
    staged: false,
    unstaged: true,
    conflict: false,
  };
}

function originSnapshot(repoRoot: string, changes: GitSnapshot["changes"] = []): GitSnapshot {
  return snapshot(repoRoot, changes, {
    remotes: [{
      name: "origin",
      fetchUrl: `git@example.com:${repoRoot.split("/").pop()}.git`,
      pushUrl: null,
      username: null,
      tokenRef: null,
    }],
  });
}

describe("WorkspaceGitManager", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("taomni.git.workspace.changes.tree", "flat");
    useAppStore.setState({ statusMessage: "Ready" });
    gitMocks.gitBlobPair.mockReset();
    gitMocks.gitBlobPair.mockResolvedValue({
      path: "src/App.tsx",
      oldPath: null,
      oldText: "old",
      newText: "new",
      oldExists: true,
      newExists: true,
      binary: false,
      image: false,
      oldImageB64: null,
      newImageB64: null,
      oversize: false,
      oldSize: 3,
      newSize: 3,
    });
    gitMocks.gitCommit.mockReset();
    gitMocks.gitCommit.mockResolvedValue(undefined);
    gitMocks.gitFetch.mockReset();
    gitMocks.gitFetch.mockResolvedValue(undefined);
    gitMocks.gitPull.mockReset();
    gitMocks.gitPull.mockResolvedValue(undefined);
    gitMocks.gitPush.mockReset();
    gitMocks.gitPush.mockResolvedValue(undefined);
    gitMocks.gitStage.mockReset();
    gitMocks.gitStage.mockResolvedValue(undefined);
    gitMocks.gitUnstage.mockReset();
    gitMocks.gitUnstage.mockResolvedValue(undefined);
    gitMocks.gitDiscard.mockReset();
    gitMocks.gitDiscard.mockResolvedValue(undefined);
    gitMocks.gitCleanUntracked.mockReset();
    gitMocks.gitCleanUntracked.mockResolvedValue(undefined);
    gitMocks.gitSnapshot.mockReset();
    gitMocks.gitSnapshot.mockImplementation(async (repoRoot: string) => (
      repoRoot === "/repo/app"
        ? snapshot("/repo/app", [{
          path: "src/App.tsx",
          oldPath: null,
          status: "modified",
          staged: false,
          unstaged: true,
          conflict: false,
        }, {
          path: "src/ignored.ts",
          oldPath: null,
          status: "modified",
          staged: false,
          unstaged: true,
          conflict: false,
        }])
        : snapshot(repoRoot)
    ));
    dialogMocks.alertAppDialog.mockReset();
    dialogMocks.confirmAppDialog.mockReset();
    dialogMocks.confirmAppDialog.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
  });

  it("uses the full single-repository Git panel without the multi-repo sidebar", () => {
    render(
      <WorkspaceGitManager
        workspaceName="Single"
        roots={[
          { id: "app", name: "app", path: "/repo/app", repoRoot: "/repo/app", rootIds: ["app"] },
        ]}
      />,
    );

    expect(screen.getByTestId("git-panel")).toHaveAttribute("data-repo-root", "/repo/app");
    expect(screen.queryByTestId("workspace-git-manager")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace-git-sidebar")).not.toBeInTheDocument();
  });

  it("uses only the header repo selector for multi-repo scope changes", async () => {
    render(
      <WorkspaceGitManager
        workspaceName="Workspace"
        activeRepoRoot="/repo/service"
        roots={[
          { id: "app", name: "app", path: "/repo", repoRoot: "/repo/app", rootIds: ["root"] },
          { id: "service", name: "service", path: "/repo", repoRoot: "/repo/service", rootIds: ["root"] },
        ]}
      />,
    );

    await waitFor(() => expect(gitMocks.gitSnapshot).toHaveBeenCalledWith("/repo/app"));
    expect(screen.queryByTestId("workspace-git-sidebar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show Repository Panel" })).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-repo-selector")).toHaveTextContent("All Repositories (2)");
    expect(screen.getByTestId("git-panel")).toHaveAttribute("data-repo-root", "/repo/service");
    expect(screen.getByText("src/App.tsx")).toBeInTheDocument();
    expect(screen.getByText("src/ignored.ts")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("workspace-repo-selector"));
    fireEvent.click(within(screen.getByTestId("workspace-repo-selector-menu")).getByTitle("/repo/app"));
    expect(screen.getByTestId("git-panel")).toHaveAttribute("data-repo-root", "/repo/app");
    expect(screen.getByTestId("workspace-repo-selector")).toHaveTextContent("app");

    const ignoredRow = screen.getByText("src/ignored.ts").closest("[role='button']");
    expect(ignoredRow).not.toBeNull();
    fireEvent.click(within(ignoredRow as HTMLElement).getByRole("checkbox"));
    fireEvent.change(screen.getByPlaceholderText("Commit message"), {
      target: { value: "batch commit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));

    await waitFor(() => {
      expect(gitMocks.gitCommit).toHaveBeenCalledWith(
        "/repo/app",
        "batch commit",
        false,
        ["src/App.tsx"],
      );
    });
    expect(gitMocks.gitCommit).toHaveBeenCalledTimes(1);
  });

  it("keeps workspace change selections isolated when repositories contain the same file path", async () => {
    gitMocks.gitSnapshot.mockImplementation(async (repoRoot: string) => (
      repoRoot === "/repo/app"
        ? snapshot("/repo/app", [change("README.md")])
        : snapshot("/repo/service", [change("README.md")])
    ));

    render(
      <WorkspaceGitManager
        workspaceName="Workspace"
        activeRepoRoot="/repo/app"
        roots={[
          { id: "app", name: "app", path: "/repo", repoRoot: "/repo/app", rootIds: ["root"] },
          { id: "service", name: "service", path: "/repo", repoRoot: "/repo/service", rootIds: ["root"] },
        ]}
      />,
    );

    await waitFor(() => expect(screen.getAllByText("README.md")).toHaveLength(2));

    fireEvent.click(screen.getByRole("checkbox", { name: "Select changes in app" }));
    fireEvent.change(screen.getByPlaceholderText("Commit message"), {
      target: { value: "commit service only" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));

    await waitFor(() => {
      expect(gitMocks.gitCommit).toHaveBeenCalledWith(
        "/repo/service",
        "commit service only",
        false,
        ["README.md"],
      );
    });
    expect(gitMocks.gitCommit).toHaveBeenCalledTimes(1);
  });

  it("filters workspace changes to the custom repository scope from the header selector", async () => {
    gitMocks.gitSnapshot.mockImplementation(async (repoRoot: string) => {
      if (repoRoot === "/repo/app") return snapshot(repoRoot, [change("src/app.ts")]);
      if (repoRoot === "/repo/api") return snapshot(repoRoot, [change("src/api.ts")]);
      return snapshot(repoRoot, [change("src/service.ts")]);
    });

    render(
      <WorkspaceGitManager
        workspaceName="Workspace"
        activeRepoRoot="/repo/app"
        roots={[
          { id: "app", name: "app", path: "/repo", repoRoot: "/repo/app", rootIds: ["root"] },
          { id: "api", name: "api", path: "/repo", repoRoot: "/repo/api", rootIds: ["root"] },
          { id: "service", name: "service", path: "/repo", repoRoot: "/repo/service", rootIds: ["root"] },
        ]}
      />,
    );

    await waitFor(() => expect(screen.getByText("src/service.ts")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("workspace-repo-selector"));
    const menu = screen.getByTestId("workspace-repo-selector-menu");
    fireEvent.click(within(menu).getByRole("checkbox", { name: "Include service" }));
    fireEvent.click(within(menu).getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(screen.queryByText("src/service.ts")).not.toBeInTheDocument());
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    expect(screen.getByText("src/api.ts")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-repo-selector")).toHaveTextContent("api +1");
  });

  it("runs header fetch only for repositories in a custom scope", async () => {
    gitMocks.gitSnapshot.mockImplementation(async (repoRoot: string) => {
      if (repoRoot === "/repo/app") return originSnapshot(repoRoot, [change("src/app.ts")]);
      if (repoRoot === "/repo/api") return originSnapshot(repoRoot, [change("src/api.ts")]);
      return originSnapshot(repoRoot, [change("src/service.ts")]);
    });

    render(
      <WorkspaceGitManager
        workspaceName="Workspace"
        activeRepoRoot="/repo/app"
        roots={[
          { id: "app", name: "app", path: "/repo", repoRoot: "/repo/app", rootIds: ["root"] },
          { id: "api", name: "api", path: "/repo", repoRoot: "/repo/api", rootIds: ["root"] },
          { id: "service", name: "service", path: "/repo", repoRoot: "/repo/service", rootIds: ["root"] },
        ]}
      />,
    );

    await waitFor(() => expect(screen.getByText("src/service.ts")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("workspace-repo-selector"));
    const menu = screen.getByTestId("workspace-repo-selector-menu");
    fireEvent.click(within(menu).getByRole("checkbox", { name: "Include service" }));
    fireEvent.click(within(menu).getByRole("button", { name: "Apply" }));
    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));

    await waitFor(() => expect(gitMocks.gitFetch).toHaveBeenCalledTimes(2));
    expect(gitMocks.gitFetch).toHaveBeenCalledWith("/repo/app", "origin");
    expect(gitMocks.gitFetch).toHaveBeenCalledWith("/repo/api", "origin");
    expect(gitMocks.gitFetch).not.toHaveBeenCalledWith("/repo/service", "origin");
  });

  it("does not stage or commit outside the custom repository scope", async () => {
    gitMocks.gitSnapshot.mockImplementation(async (repoRoot: string) => {
      if (repoRoot === "/repo/app") return snapshot(repoRoot, [change("src/app.ts")]);
      if (repoRoot === "/repo/api") return snapshot(repoRoot, [change("src/api.ts")]);
      return snapshot(repoRoot, [change("src/service.ts")]);
    });

    render(
      <WorkspaceGitManager
        workspaceName="Workspace"
        activeRepoRoot="/repo/app"
        roots={[
          { id: "app", name: "app", path: "/repo", repoRoot: "/repo/app", rootIds: ["root"] },
          { id: "api", name: "api", path: "/repo", repoRoot: "/repo/api", rootIds: ["root"] },
          { id: "service", name: "service", path: "/repo", repoRoot: "/repo/service", rootIds: ["root"] },
        ]}
      />,
    );

    await waitFor(() => expect(screen.getByText("src/service.ts")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("workspace-repo-selector"));
    const menu = screen.getByTestId("workspace-repo-selector-menu");
    fireEvent.click(within(menu).getByRole("checkbox", { name: "Include service" }));
    fireEvent.click(within(menu).getByRole("button", { name: "Apply" }));

    fireEvent.click(screen.getByRole("button", { name: "Stage all" }));
    await waitFor(() => expect(gitMocks.gitStage).toHaveBeenCalledTimes(2));
    expect(gitMocks.gitStage).toHaveBeenCalledWith("/repo/app", ["src/app.ts"]);
    expect(gitMocks.gitStage).toHaveBeenCalledWith("/repo/api", ["src/api.ts"]);
    expect(gitMocks.gitStage).not.toHaveBeenCalledWith("/repo/service", ["src/service.ts"]);

    fireEvent.change(screen.getByPlaceholderText("Commit message"), {
      target: { value: "scoped commit" },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Commit" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));

    await waitFor(() => expect(gitMocks.gitCommit).toHaveBeenCalledTimes(2));
    expect(gitMocks.gitCommit).toHaveBeenCalledWith(
      "/repo/app",
      "scoped commit",
      false,
      ["src/app.ts"],
    );
    expect(gitMocks.gitCommit).toHaveBeenCalledWith(
      "/repo/api",
      "scoped commit",
      false,
      ["src/api.ts"],
    );
    expect(gitMocks.gitCommit).not.toHaveBeenCalledWith(
      "/repo/service",
      "scoped commit",
      false,
      ["src/service.ts"],
    );
  });
});
