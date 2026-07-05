import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
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
  GitPanel: ({ repoRoot, changesView }: { repoRoot: string; changesView?: ReactNode }) => (
    <div data-testid="git-panel" data-repo-root={repoRoot}>
      {changesView}
    </div>
  ),
}));

function snapshot(repoRoot: string, changes: GitSnapshot["changes"] = []): GitSnapshot {
  return {
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

  it("keeps file-level changes out of the workspace sidebar and shows the selected repo in the Git panel", async () => {
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
    const sidebar = screen.getByTestId("workspace-git-sidebar");
    expect(within(sidebar).getByText("Repositories")).toBeInTheDocument();
    expect(within(sidebar).getByText("2/2")).toBeInTheDocument();
    expect(screen.getByTestId("git-panel")).toHaveAttribute("data-repo-root", "/repo/service");
    expect(within(sidebar).getByRole("checkbox", { name: "Select app" })).toBeInTheDocument();
    expect(within(sidebar).queryByText("src/ignored.ts")).not.toBeInTheDocument();
    expect(within(sidebar).queryByPlaceholderText("Commit message")).not.toBeInTheDocument();
    expect(screen.getByText("src/App.tsx")).toBeInTheDocument();
    expect(screen.getByText("src/ignored.ts")).toBeInTheDocument();

    fireEvent.click(within(sidebar).getByText("app"));
    expect(screen.getByTestId("git-panel")).toHaveAttribute("data-repo-root", "/repo/app");

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
});
