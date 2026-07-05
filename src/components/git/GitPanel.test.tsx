import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../stores/appStore";
import { GitPanel } from "./GitPanel";
import type { GitLogEntry, GitOperationState, GitSnapshot } from "../../lib/git";

const gitMocks = vi.hoisted(() => {
  const settings = {
    userName: null,
    userEmail: null,
    httpProxy: null,
    httpsProxy: null,
    pullRebase: null,
    pushDefault: null,
    coreAutocrlf: null,
    coreFilemode: null,
    commitGpgsign: null,
  };

  const snapshot: GitSnapshot = {
    repoRoot: "D:\\repo",
    currentBranch: "main",
    headOid: "abc123",
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    changes: [],
    remotes: [],
    branches: [
      {
        name: "main",
        fullName: "main",
        current: true,
        remote: false,
        upstream: null,
        oid: "abc123",
        subject: "Initial commit",
      },
    ],
    stashes: [],
    tags: [],
    settings,
  };

  return {
    gitSnapshot: vi.fn(async () => snapshot),
    gitOperationState: vi.fn(async (): Promise<GitOperationState> => ({ kind: "none", conflictedPaths: [] })),
    gitRepoName: vi.fn(() => "repo"),
    gitChangeLabel: vi.fn((change: { status: string }) => change.status),
    selectedRemote: vi.fn(() => null),
    gitBlobPair: vi.fn(),
    gitCommitFiles: vi.fn(async () => []),
    gitLog: vi.fn(async (): Promise<GitLogEntry[]> => []),
    gitCheckoutBranch: vi.fn(),
    gitCherryPick: vi.fn(),
    gitOperationContinue: vi.fn(),
    gitOperationAbort: vi.fn(),
    gitRebaseSkip: vi.fn(),
    gitResolveConflict: vi.fn(),
    gitCleanUntracked: vi.fn(),
    gitCommit: vi.fn(),
    gitCreateBranch: vi.fn(),
    gitDeleteBranch: vi.fn(),
    gitDeleteRemote: vi.fn(),
    gitDiscard: vi.fn(),
    gitFetch: vi.fn(),
    gitMergeBranch: vi.fn(),
    gitRenameBranch: vi.fn(),
    gitSetUpstream: vi.fn(),
    gitCreateTag: vi.fn(),
    gitDeleteTag: vi.fn(),
    gitPushTag: vi.fn(),
    gitCheckoutTag: vi.fn(),
    gitPull: vi.fn(),
    gitPush: vi.fn(),
    gitReset: vi.fn(),
    gitRevert: vi.fn(),
    gitSaveRemoteAuth: vi.fn(),
    gitSaveSettings: vi.fn(),
    gitSetRemote: vi.fn(),
    gitStage: vi.fn(),
    gitStashApply: vi.fn(),
    gitStashDrop: vi.fn(),
    gitStashSave: vi.fn(),
    gitStashShow: vi.fn(),
    gitUnstage: vi.fn(),
  };
});

vi.mock("../../lib/git", () => ({
  ...gitMocks,
  GIT_REF_WORKTREE: ":WORKTREE",
}));

describe("GitPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAppStore.setState({
      uiFontFamily: "Inter",
      uiFontSize: 12,
      statusMessage: "Ready",
    });
    gitMocks.gitSnapshot.mockClear();
    gitMocks.gitOperationState.mockClear();
    gitMocks.gitCommitFiles.mockClear();
    gitMocks.gitCommitFiles.mockResolvedValue([]);
    gitMocks.gitLog.mockClear();
    gitMocks.gitLog.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it("uses Ctrl plus/minus/zero to adjust global UI font size while the Git panel is active", async () => {
    render(<GitPanel repoRoot="D:\\repo" />);

    await waitFor(() => expect(gitMocks.gitSnapshot).toHaveBeenCalled());

    fireEvent.keyDown(window, { key: "=", code: "Equal", ctrlKey: true });
    expect(useAppStore.getState().uiFontSize).toBe(13);
    expect(window.localStorage.getItem("taomni.uiFontSize")).toBe("13");

    fireEvent.keyDown(window, { key: "-", code: "Minus", ctrlKey: true });
    expect(useAppStore.getState().uiFontSize).toBe(12);

    fireEvent.keyDown(window, { key: "+", code: "Equal", ctrlKey: true });
    expect(useAppStore.getState().uiFontSize).toBe(13);

    fireEvent.keyDown(window, { key: "0", code: "Digit0", ctrlKey: true });
    expect(useAppStore.getState().uiFontSize).toBe(12);
    expect(window.localStorage.getItem("taomni.uiFontSize")).toBe("12");
  });

  it("uses Ctrl wheel to adjust global UI font size inside the Git panel", async () => {
    render(<GitPanel repoRoot="D:\\repo" />);

    await waitFor(() => expect(gitMocks.gitSnapshot).toHaveBeenCalled());
    const panel = screen.getByTestId("git-panel");

    fireEvent.wheel(panel, { ctrlKey: true, deltaY: -100 });
    expect(useAppStore.getState().uiFontSize).toBe(13);

    fireEvent.wheel(panel, { ctrlKey: true, deltaY: 100 });
    expect(useAppStore.getState().uiFontSize).toBe(12);
  });

  it("labels the header as workspace Git when embedded in the multi-repo manager", async () => {
    render(
      <GitPanel
        repoRoot="D:\\repo"
        workspaceHeader={{
          title: "Code Workspace",
          summary: "3 repositories · 1 changed files",
          selectedRepoName: "repo",
          selectedRepoRoot: "D:\\repo",
        }}
        changesView={<div>Workspace changes body</div>}
      />,
    );

    await waitFor(() => expect(gitMocks.gitSnapshot).toHaveBeenCalled());
    expect(screen.getByText("Workspace Git · Code Workspace")).toBeInTheDocument();
    expect(screen.getByText("Repository detail")).toBeInTheDocument();
    expect(screen.queryByText("Git · repo")).not.toBeInTheDocument();
  });

  it("keeps current repository settings as the default and can switch to aggregate settings", async () => {
    render(
      <GitPanel
        repoRoot="D:\\repo"
        workspaceSettingsAggregateView={(showCurrent) => (
          <div>
            <div>Aggregate settings body</div>
            <button type="button" onClick={showCurrent}>Back to current</button>
          </div>
        )}
      />,
    );

    await waitFor(() => expect(gitMocks.gitSnapshot).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "settings" }));

    expect(screen.getByText("Repository config")).toBeInTheDocument();
    expect(screen.queryByText("Aggregate settings body")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Aggregate" }));
    expect(screen.getByText("Aggregate settings body")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to current" }));
    expect(screen.getByText("Repository config")).toBeInTheDocument();
  });

  it("keeps the visited log view mounted across Git sub-tab switches", async () => {
    gitMocks.gitLog.mockResolvedValue([
      {
        oid: "abc123",
        shortOid: "abc123",
        parents: [],
        authorName: "Ada",
        authorEmail: "ada@example.com",
        date: "2026-06-30T10:00:00Z",
        subject: "Initial commit",
        body: "",
        refs: [],
      },
    ]);

    render(<GitPanel repoRoot="D:\\repo" />);

    await waitFor(() => expect(gitMocks.gitSnapshot).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "log" }));
    await waitFor(() => expect(gitMocks.gitLog).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "changes" }));
    fireEvent.click(screen.getByRole("button", { name: "log" }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(gitMocks.gitLog).toHaveBeenCalledTimes(1);
  });

  it("does not refresh the repository snapshot when selecting a branch", async () => {
    const snapshotWithBranches: GitSnapshot = {
      repoRoot: "D:\\repo",
      currentBranch: "main",
      headOid: "abc123",
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      changes: [],
      remotes: [],
      branches: [
        {
          name: "main",
          fullName: "main",
          current: true,
          remote: false,
          upstream: null,
          oid: "abc123",
          subject: "Initial commit",
        },
        {
          name: "feature",
          fullName: "feature",
          current: false,
          remote: false,
          upstream: null,
          oid: "def456",
          subject: "Feature work",
        },
      ],
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
    gitMocks.gitSnapshot.mockResolvedValueOnce(snapshotWithBranches);

    render(<GitPanel repoRoot="D:\\repo" />);

    await waitFor(() => expect(gitMocks.gitSnapshot).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "branches" }));
    fireEvent.click(await screen.findByText("feature"));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(gitMocks.gitSnapshot).toHaveBeenCalledTimes(1);
  });
});
