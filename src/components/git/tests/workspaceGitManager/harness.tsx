import { vi } from "vitest";
import type { GitRemote, GitSnapshot } from "../../../../lib/git";

const gitMocks = vi.hoisted(() => ({
  GIT_REF_WORKTREE: ":WORKTREE",
  gitBlobPair: vi.fn(),
  gitCleanUntracked: vi.fn(),
  gitCommit: vi.fn(),
  gitCheckoutBranch: vi.fn(),
  gitCreateBranch: vi.fn(),
  gitChangeLabel: vi.fn((change: { conflict?: boolean; status: string; }) => (
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
  selectedRemote: vi.fn<(snapshot: GitSnapshot | null) => GitRemote | null>(() => null),
}));

const dialogMocks = vi.hoisted(() => ({
  alertAppDialog: vi.fn(),
  choiceAppDialog: vi.fn(),
  confirmAppDialog: vi.fn(),
}));

const workspaceMocks = vi.hoisted(() => ({
  workspaceWriteFile: vi.fn(),
}));

vi.mock("../../../../lib/git", () => gitMocks);

vi.mock("../../../../lib/appDialogs", () => dialogMocks);

vi.mock("../../../../lib/editor/workspace", () => workspaceMocks);

vi.mock("../../GitPanel", () => ({
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

export function snapshot(
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

export function change(path: string): GitSnapshot["changes"][number] {
  return {
    path,
    oldPath: null,
    status: "modified",
    staged: false,
    unstaged: true,
    conflict: false,
  };
}

export function untrackedChange(path: string): GitSnapshot["changes"][number] {
  return {
    path,
    oldPath: null,
    status: "untracked",
    staged: false,
    unstaged: true,
    conflict: false,
  };
}

export function originSnapshot(repoRoot: string, changes: GitSnapshot["changes"] = []): GitSnapshot {
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

export { dialogMocks, gitMocks, workspaceMocks };
