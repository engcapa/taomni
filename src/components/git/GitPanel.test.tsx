import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../stores/appStore";
import { GitPanel } from "./GitPanel";
import type { GitOperationState, GitSnapshot } from "../../lib/git";

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
});
