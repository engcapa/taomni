import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../stores/appStore";
import type { GitSnapshot } from "../../lib/git";
import { WorkspaceGitManager } from "./WorkspaceGitManager";

const gitMocks = vi.hoisted(() => ({
  gitCommit: vi.fn(),
  gitChangeLabel: vi.fn((change: { conflict?: boolean; status: string }) => (
    change.conflict ? "Conflicted" : change.status[0]?.toUpperCase() + change.status.slice(1)
  )),
  gitFetch: vi.fn(),
  gitPull: vi.fn(),
  gitPush: vi.fn(),
  gitRepoName: vi.fn((repoRoot: string) => repoRoot.split("/").pop() ?? repoRoot),
  gitSnapshot: vi.fn(),
  selectedRemote: vi.fn(() => null),
}));

const dialogMocks = vi.hoisted(() => ({
  alertAppDialog: vi.fn(),
}));

vi.mock("../../lib/git", () => gitMocks);

vi.mock("../../lib/appDialogs", () => dialogMocks);

vi.mock("./GitPanel", () => ({
  GitPanel: ({ repoRoot }: { repoRoot: string }) => (
    <div data-testid="git-panel" data-repo-root={repoRoot} />
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

describe("WorkspaceGitManager", () => {
  beforeEach(() => {
    useAppStore.setState({ statusMessage: "Ready" });
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
  });

  afterEach(() => {
    cleanup();
  });

  it("commits changed files across checked repositories and keeps the selected repo in the Git panel", async () => {
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
    expect(screen.getByTestId("git-panel")).toHaveAttribute("data-repo-root", "/repo/service");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select src/ignored.ts" }));
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
});
