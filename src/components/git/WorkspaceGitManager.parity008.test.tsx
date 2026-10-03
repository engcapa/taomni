import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../stores/appStore";
import type { GitBlobPair, GitSnapshot } from "../../lib/git";
import { WorkspaceGitManager } from "./WorkspaceGitManager";

// ED-PARITY-008: switching Git diff context between two local repositories.
// Every Git command is a mock; these tests prove renderer request identity,
// not real Git bytes (native TC-IDE-PARITY-008-03 owns disk evidence).

const gitMocks = vi.hoisted(() => ({
  GIT_REF_WORKTREE: ":WORKTREE",
  gitBlobPair: vi.fn(),
  gitCleanUntracked: vi.fn(),
  gitCommit: vi.fn(),
  gitCheckoutBranch: vi.fn(),
  gitCreateBranch: vi.fn(),
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

const workspaceMocks = vi.hoisted(() => ({ workspaceWriteFile: vi.fn() }));

vi.mock("../../lib/git", () => gitMocks);
vi.mock("../../lib/appDialogs", () => ({
  alertAppDialog: vi.fn(),
  choiceAppDialog: vi.fn(),
  confirmAppDialog: vi.fn(async () => true),
  promptAppDialog: vi.fn(),
}));
vi.mock("../../lib/editor/workspace", () => workspaceMocks);
vi.mock("./GitPanel", () => ({
  GitPanel: ({ repoRoot, changesView, workspaceHeader }: {
    repoRoot: string;
    changesView?: React.ReactNode;
    workspaceHeader?: { actionControls?: React.ReactNode };
  }) => (
    <div data-testid="git-panel" data-repo-root={repoRoot}>
      <div>{workspaceHeader?.actionControls}</div>
      {changesView}
    </div>
  ),
}));

const WRITE_COMMANDS = [
  "gitCleanUntracked", "gitCommit", "gitCheckoutBranch", "gitCreateBranch", "gitDiscard",
  "gitFetch", "gitPull", "gitPush", "gitStage", "gitUnstage",
] as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function snapshot(repoRoot: string, headOid: string, changes: GitSnapshot["changes"]): GitSnapshot {
  return {
    repoRoot,
    currentBranch: "main",
    headOid,
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
      userName: null, userEmail: null, httpProxy: null, httpsProxy: null, pullRebase: null,
      pushDefault: null, coreAutocrlf: null, coreFilemode: null, commitGpgsign: null,
    },
  };
}

function modified(path: string, staged = false): GitSnapshot["changes"][number] {
  return { path, oldPath: null, status: "modified", staged, unstaged: true, conflict: false };
}

function pair(path: string, oldText: string, newText: string): GitBlobPair {
  return {
    path, oldPath: null, oldText, newText, oldExists: true, newExists: true, binary: false,
    image: false, oldImageB64: null, newImageB64: null, oversize: false,
    oldSize: oldText.length, newSize: newText.length,
  };
}

const ROOTS = [
  { id: "repo-a", name: "repo-a", path: "/fx", repoRoot: "/fx/repo-a", rootIds: ["fx"] },
  { id: "repo-b", name: "repo-b", path: "/fx", repoRoot: "/fx/repo-b", rootIds: ["fx"] },
];

const SNAP_A = snapshot("/fx/repo-a", "8748e377acc709469beca3ee792e83e24c10be45", [modified("same.txt", true)]);
const SNAP_B = snapshot("/fx/repo-b", "909b2b27c0efdc9def85adf69b07ccc6cfdc95eb", [modified("same.txt")]);
const PAIR_A = pair("same.txt", "repo-a HEAD\nshared line\n", "repo-a WORKTREE\nshared line\n");
const PAIR_B = pair("same.txt", "repo-b HEAD\nshared line\n", "repo-b WORKTREE\nshared line\n");

function rowFor(repo: string) {
  return screen.getByRole("button", { name: new RegExp(`^${repo} same\\.txt`, "i") });
}

function expectNoGitWrites() {
  for (const name of WRITE_COMMANDS) expect(gitMocks[name]).not.toHaveBeenCalled();
}

describe("WorkspaceGitManager ED-PARITY-008 repository context", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("taomni.git.workspace.changes.tree", "flat");
    useAppStore.setState({ statusMessage: "Ready" });
    for (const mock of Object.values(gitMocks)) {
      if (typeof mock === "function" && "mockReset" in mock) (mock as ReturnType<typeof vi.fn>).mockClear();
    }
    gitMocks.gitSnapshot.mockReset();
    gitMocks.gitSnapshot.mockImplementation(async (repoRoot: string) => (repoRoot === "/fx/repo-a" ? SNAP_A : SNAP_B));
    gitMocks.gitBlobPair.mockReset();
    gitMocks.gitBlobPair.mockImplementation(async (repoRoot: string) => (repoRoot === "/fx/repo-a" ? PAIR_A : PAIR_B));
    workspaceMocks.workspaceWriteFile.mockReset();
    workspaceMocks.workspaceWriteFile.mockResolvedValue({ path: "same.txt", text: "", size: 0, mtime: 0, hash: "h" });
  });

  afterEach(() => cleanup());

  it("switches title, HEAD/worktree labels, file position and diff identity from repo-a to repo-b", async () => {
    render(<WorkspaceGitManager workspaceName="parity-008" activeRepoRoot="/fx/repo-a" roots={ROOTS} />);

    await waitFor(() => expect(rowFor("repo-a")).toBeInTheDocument());
    fireEvent.click(rowFor("repo-a"));
    await waitFor(() => expect(screen.getByTestId("git-diff-viewer")).toHaveAttribute("data-repo-root", "/fx/repo-a"));
    expect(screen.getByTestId("workspace-diff-title")).toHaveTextContent("repo-a / same.txt");
    expect(screen.getByTestId("workspace-diff-file-position")).toHaveTextContent("1/2 files");
    expect(screen.getByTestId("workspace-diff-old-label")).toHaveTextContent("HEAD 8748e377");
    expect(screen.getByTestId("workspace-diff-new-label")).toHaveTextContent("Working tree");
    expect(gitMocks.gitBlobPair).toHaveBeenLastCalledWith("/fx/repo-a", "same.txt", "HEAD", ":WORKTREE", null);

    fireEvent.click(screen.getByTestId("workspace-diff-next-file"));
    await waitFor(() => expect(screen.getByTestId("git-diff-viewer")).toHaveAttribute("data-repo-root", "/fx/repo-b"));
    expect(screen.getByTestId("workspace-diff-title")).toHaveTextContent("repo-b / same.txt");
    expect(screen.getByTestId("workspace-diff-file-position")).toHaveTextContent("2/2 files");
    expect(screen.getByTestId("workspace-diff-old-label")).toHaveTextContent("HEAD 909b2b27");
    expect(screen.getByTestId("workspace-diff-next-file")).toBeDisabled();
    expect(gitMocks.gitBlobPair).toHaveBeenLastCalledWith("/fx/repo-b", "same.txt", "HEAD", ":WORKTREE", null);

    fireEvent.click(screen.getByTestId("workspace-diff-prev-file"));
    await waitFor(() => expect(screen.getByTestId("git-diff-viewer")).toHaveAttribute("data-repo-root", "/fx/repo-a"));
    expect(screen.getByTestId("workspace-diff-file-position")).toHaveTextContent("1/2 files");
    expect(screen.getByTestId("workspace-diff-prev-file")).toBeDisabled();
    expectNoGitWrites();
  });

  it("hides a pending diff instead of showing the previous repository's content under the new title", async () => {
    render(<WorkspaceGitManager workspaceName="parity-008" activeRepoRoot="/fx/repo-a" roots={ROOTS} />);
    await waitFor(() => expect(rowFor("repo-a")).toBeInTheDocument());
    fireEvent.click(rowFor("repo-a"));
    await waitFor(() => expect(screen.getByTestId("git-diff-viewer")).toHaveAttribute("data-repo-root", "/fx/repo-a"));

    const pendingB = deferred<GitBlobPair>();
    gitMocks.gitBlobPair.mockImplementation((repoRoot: string) => (
      repoRoot === "/fx/repo-b" ? pendingB.promise : Promise.resolve(PAIR_A)
    ));
    fireEvent.click(rowFor("repo-b"));
    expect(screen.getByTestId("workspace-diff-title")).toHaveTextContent("repo-b / same.txt");
    // The repo-a pair must not be rendered while repo-b is loading.
    expect(screen.queryByTestId("git-diff-viewer")).toBeNull();

    await act(async () => { pendingB.resolve(PAIR_B); });
    await waitFor(() => expect(screen.getByTestId("git-diff-viewer")).toHaveAttribute("data-repo-root", "/fx/repo-b"));
  });

  it("discards a late snapshot for a repository after a newer refresh already landed", async () => {
    const lateA = deferred<GitSnapshot>();
    let aCalls = 0;
    gitMocks.gitSnapshot.mockImplementation((repoRoot: string) => {
      if (repoRoot !== "/fx/repo-a") return Promise.resolve(SNAP_B);
      aCalls += 1;
      return aCalls === 1 ? lateA.promise : Promise.resolve(SNAP_A);
    });
    render(<WorkspaceGitManager workspaceName="parity-008" activeRepoRoot="/fx/repo-a" roots={ROOTS} />);
    await waitFor(() => expect(rowFor("repo-b")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(rowFor("repo-a")).toBeInTheDocument());

    const stale = snapshot("/fx/repo-a", "0000000000000000000000000000000000000000", [modified("stale-only.txt")]);
    await act(async () => { lateA.resolve(stale); });

    expect(screen.queryByRole("button", { name: /stale-only\.txt/i })).toBeNull();
    expect(rowFor("repo-a")).toBeInTheDocument();
    expectNoGitWrites();
  });

  it("keeps Git untouched when Discard is cancelled and when the manager closes mid-read", async () => {
    const dialogs = await import("../../lib/appDialogs");
    vi.mocked(dialogs.confirmAppDialog).mockResolvedValueOnce(false);
    const view = render(<WorkspaceGitManager workspaceName="parity-008" activeRepoRoot="/fx/repo-a" roots={ROOTS} />);
    await waitFor(() => expect(rowFor("repo-b")).toBeInTheDocument());
    fireEvent.click(rowFor("repo-b"));
    await waitFor(() => expect(screen.getByTestId("git-diff-viewer")).toHaveAttribute("data-repo-root", "/fx/repo-b"));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(dialogs.confirmAppDialog).toHaveBeenCalled());

    const pendingA = deferred<GitBlobPair>();
    gitMocks.gitBlobPair.mockImplementation(() => pendingA.promise);
    fireEvent.click(rowFor("repo-a"));
    view.unmount();
    await act(async () => { pendingA.resolve(PAIR_A); });

    expectNoGitWrites();
    expect(workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();
  });

  it("drops a late diff reload for repo-a after focus moved to repo-b", async () => {
    gitMocks.gitBlobPair.mockImplementation(async (repoRoot: string) => (
      repoRoot === "/fx/repo-a" ? pair("same.txt", "line\n", "line\r\n") : PAIR_B
    ));
    render(<WorkspaceGitManager workspaceName="parity-008" activeRepoRoot="/fx/repo-a" roots={ROOTS} />);
    await waitFor(() => expect(rowFor("repo-a")).toBeInTheDocument());
    fireEvent.click(rowFor("repo-a"));
    await waitFor(() => expect(screen.getByTestId("git-diff-normalize-eol")).toBeInTheDocument());

    const lateReload = deferred<GitBlobPair>();
    let bCalls = 0;
    // Only the first repo-b diff read answers: a redundant re-read must not be
    // what hides a stale repo-a write.
    gitMocks.gitBlobPair.mockImplementation((repoRoot: string) => {
      if (repoRoot === "/fx/repo-a") return lateReload.promise;
      bCalls += 1;
      return bCalls === 1 ? Promise.resolve(PAIR_B) : new Promise<GitBlobPair>(() => undefined);
    });
    // Hold every later repo-a snapshot so a refresh cannot mask a stale pair write.
    gitMocks.gitSnapshot.mockImplementation((repoRoot: string) => (
      repoRoot === "/fx/repo-a" ? new Promise<GitSnapshot>(() => undefined) : Promise.resolve(SNAP_B)
    ));
    fireEvent.click(screen.getByTestId("git-diff-normalize-eol"));
    await waitFor(() => expect(workspaceMocks.workspaceWriteFile).toHaveBeenCalledWith("/fx/repo-a", "same.txt", "line\n"));

    fireEvent.click(rowFor("repo-b"));
    await waitFor(() => expect(screen.getByTestId("git-diff-viewer")).toHaveAttribute("data-repo-root", "/fx/repo-b"));

    expect(screen.getByTestId("git-diff-viewer")).toHaveTextContent("repo-b WORKTREE");
    // A stale repo-a reload is EOL-only; applying it would re-show the banner under repo-b.
    await act(async () => { lateReload.resolve(pair("same.txt", "late-a\n", "late-a\r\n")); });
    expect(screen.getByTestId("git-diff-viewer")).toHaveAttribute("data-repo-root", "/fx/repo-b");
    expect(screen.getByTestId("workspace-diff-title")).toHaveTextContent("repo-b / same.txt");
    expect(screen.queryByTestId("git-diff-eol-only-banner")).toBeNull();
    expect(screen.getByTestId("git-diff-viewer")).not.toHaveTextContent("late-a");
  });
});
