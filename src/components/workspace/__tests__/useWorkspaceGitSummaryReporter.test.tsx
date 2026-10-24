import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useWorkspaceGitSummaryStore } from "../../../stores/workspaceGitSummaryStore";
import { useWorkspaceGitSummaryReporter } from "../useWorkspaceGitSummaryReporter";

const gitMocks = vi.hoisted(() => ({
  gitProbePath: vi.fn(),
  gitSnapshot: vi.fn(),
}));

vi.mock("../../../lib/git", () => gitMocks);

vi.mock("../../../lib/gitRefresh", () => ({
  subscribeGitRepoRefresh: () => () => undefined,
}));

describe("workspace Git summary reporter", () => {
  it("reports the first repository branch and changed-file count", async () => {
    gitMocks.gitProbePath.mockImplementation(async (path: string) => ({
      path,
      gitAvailable: true,
      isRepo: path === "/repo",
      repoRoot: path === "/repo" ? "/repo" : null,
      error: null,
    }));
    gitMocks.gitSnapshot.mockResolvedValue({
      repoRoot: "/repo",
      currentBranch: "main",
      headOid: "abc",
      detached: false,
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      changes: [{ path: "a.ts", oldPath: null, status: "M", staged: false, unstaged: true, conflict: false }],
      remotes: [],
      branches: [],
      stashes: [],
      tags: [],
      settings: {},
    });

    renderHook(() => useWorkspaceGitSummaryReporter([{ path: "/plain" }, { path: "/repo" }]));

    await waitFor(() => {
      expect(useWorkspaceGitSummaryStore.getState().summary.repoRoot).toBe("/repo");
    });
    expect(useWorkspaceGitSummaryStore.getState().summary.branch).toBe("main");
    expect(useWorkspaceGitSummaryStore.getState().summary.changeCount).toBe(1);
  });

  it("clears the summary when no root is a repository", async () => {
    gitMocks.gitProbePath.mockResolvedValue({
      path: "/plain",
      gitAvailable: true,
      isRepo: false,
      repoRoot: null,
      error: null,
    });
    act(() => {
      useWorkspaceGitSummaryStore.getState().setSummary({
        repoRoot: "/stale",
        branch: "old",
        changeCount: 3,
        loading: false,
      });
    });

    renderHook(() => useWorkspaceGitSummaryReporter([{ path: "/plain" }]));

    await waitFor(() => {
      expect(useWorkspaceGitSummaryStore.getState().summary.repoRoot).toBe("");
    });
    expect(useWorkspaceGitSummaryStore.getState().summary.changeCount).toBe(0);
  });
});
