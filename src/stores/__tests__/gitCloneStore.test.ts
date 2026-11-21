import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitCloneDefaults,
  GitCloneProgress,
  GitCloneRequest,
  GitCloneResult,
} from "../../lib/gitClone";

const mocks = vi.hoisted(() => ({
  defaults: vi.fn(),
  repository: vi.fn(),
  cancel: vi.fn(),
  listen: vi.fn(),
  progressHandler: null as null | ((progress: GitCloneProgress) => void),
}));

vi.mock("../../lib/gitClone", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/gitClone")>();
  return {
    ...actual,
    gitCloneDefaults: mocks.defaults,
    gitCloneRepository: mocks.repository,
    gitCloneCancel: mocks.cancel,
    listenGitCloneProgress: mocks.listen,
  };
});

import {
  resetGitCloneStoreForTests,
  useGitCloneStore,
} from "../gitCloneStore";
import { useAppStore } from "../appStore";
import { useWorkspacePlatformStore } from "../workspacePlatformStore";

const DEFAULTS: GitCloneDefaults = {
  gitAvailable: true,
  gitVersion: "git version 2.45.0",
  userName: "Global User",
  userEmail: "global@example.invalid",
  defaultBranch: "main",
  cloneRoot: "/home/qa/taomni-workspaces",
  appProxyEnabled: true,
  appProxyUrl: "http://proxy.example.test:3128",
  appProxyError: null,
  vaultState: "unlocked",
  savedTokenAvailable: true,
};

function request(overrides: Partial<GitCloneRequest> = {}): GitCloneRequest {
  return {
    taskId: "task-1",
    url: "https://github.com/example/repo.git",
    destination: "/home/qa/taomni-workspaces/repo",
    workspaceName: "repo",
    branch: "main",
    userName: "QA User",
    userEmail: "qa@example.invalid",
    proxyMode: "app",
    httpProxy: null,
    httpsProxy: null,
    token: null,
    tokenUsername: null,
    useSavedToken: false,
    rememberToken: false,
    ...overrides,
  };
}

function result(overrides: Partial<GitCloneResult> = {}): GitCloneResult {
  return {
    taskId: "task-1",
    destination: "/home/qa/taomni-workspaces/repo",
    repoRoot: "/home/qa/taomni-workspaces/repo",
    branch: "main",
    defaultBranch: "main",
    headOid: "0123456789abcdef0123456789abcdef01234567",
    remoteUrl: "https://github.com/example/repo.git",
    durationMs: 1200,
    tokenRemembered: false,
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  window.localStorage.clear();
  resetGitCloneStoreForTests();
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useAppStore.setState({
    activeSideTab: "sessions",
    sidebarCollapsed: true,
    recentWorkspaces: [],
    statusMessage: "",
  });
  mocks.defaults.mockReset();
  mocks.repository.mockReset();
  mocks.cancel.mockReset().mockResolvedValue(undefined);
  mocks.listen.mockReset().mockImplementation(async (handler: (progress: GitCloneProgress) => void) => {
    mocks.progressHandler = handler;
    return () => undefined;
  });
  mocks.progressHandler = null;
});

describe("gitCloneStore", () => {
  it("loads defaults once when the dialog opens", async () => {
    mocks.defaults.mockResolvedValue(DEFAULTS);
    useGitCloneStore.getState().openDialog();
    await vi.waitFor(() => expect(useGitCloneStore.getState().defaultsStatus).toBe("ready"));
    expect(useGitCloneStore.getState().open).toBe(true);
    expect(useGitCloneStore.getState().defaults).toEqual(DEFAULTS);
    useGitCloneStore.getState().openDialog();
    await Promise.resolve();
    expect(mocks.defaults).toHaveBeenCalledTimes(1);
  });

  it("tracks progress and publishes a workspace from the completion path", async () => {
    const clone = deferred<GitCloneResult>();
    mocks.repository.mockReturnValue(clone.promise);
    const start = useGitCloneStore.getState().startClone(request());
    await vi.waitFor(() => expect(mocks.progressHandler).toBeTypeOf("function"));
    mocks.progressHandler?.({
      taskId: "task-1",
      phase: "receiving",
      percent: 45,
      indeterminate: false,
      message: "Receiving objects: 45% (450/1000)",
      objectsDone: 450,
      objectsTotal: 1000,
    });
    expect(useGitCloneStore.getState().task).toMatchObject({
      phase: "receiving",
      percent: 45,
      objectsDone: 450,
      objectsTotal: 1000,
    });
    clone.resolve(result());
    await start;

    const task = useGitCloneStore.getState().task;
    expect(task?.phase).toBe("completed");
    expect(task?.result?.repoRoot).toBe("/home/qa/taomni-workspaces/repo");
    const platform = useWorkspacePlatformStore.getState();
    const workspace = platform.workspaces.find((candidate) => candidate.name === "repo");
    expect(workspace).toBeTruthy();
    expect(workspace?.rootFolders[0].path).toBe("/home/qa/taomni-workspaces/repo");
    expect(platform.activeWorkspaceId).toBe(workspace?.id);
    const app = useAppStore.getState();
    expect(app.activeSideTab).toBe("workspaces");
    expect(app.recentWorkspaces[0]?.roots[0].path).toBe("/home/qa/taomni-workspaces/repo");
    expect(app.recentWorkspaces[0]?.isGitRepo).toBe(true);
    expect(app.statusMessage).toContain("repo");
  });

  it("keeps failure details for retry", async () => {
    mocks.repository.mockRejectedValue(new Error("fatal: repository not found"));
    await useGitCloneStore.getState().startClone(request());
    expect(useGitCloneStore.getState().task).toMatchObject({
      phase: "failed",
      error: "fatal: repository not found",
    });
    expect(useWorkspacePlatformStore.getState().workspaces.some((workspace) => workspace.name === "repo")).toBe(false);
  });

  it("requests cancellation and records a cancelled terminal state", async () => {
    const clone = deferred<GitCloneResult>();
    mocks.repository.mockReturnValue(clone.promise);
    const start = useGitCloneStore.getState().startClone(request());
    await vi.waitFor(() => expect(useGitCloneStore.getState().task?.phase).toBe("preparing"));
    await useGitCloneStore.getState().cancelClone();
    expect(mocks.cancel).toHaveBeenCalledWith("task-1");
    expect(useGitCloneStore.getState().task).toMatchObject({
      phase: "cancelling",
      cancelRequested: true,
    });
    clone.reject(new Error("Git clone cancelled"));
    await start;
    expect(useGitCloneStore.getState().task).toMatchObject({
      phase: "cancelled",
      error: null,
    });
  });

  it("keeps a clone running after the dialog closes", async () => {
    const clone = deferred<GitCloneResult>();
    mocks.repository.mockReturnValue(clone.promise);
    const start = useGitCloneStore.getState().startClone(request());
    await vi.waitFor(() => expect(useGitCloneStore.getState().task?.phase).toBe("preparing"));
    useGitCloneStore.getState().closeDialog();
    expect(useGitCloneStore.getState().open).toBe(false);
    expect(useGitCloneStore.getState().task?.phase).toBe("preparing");
    clone.resolve(result());
    await start;
    expect(useGitCloneStore.getState().open).toBe(false);
    expect(useGitCloneStore.getState().task?.phase).toBe("completed");
    expect(useWorkspacePlatformStore.getState().workspaces.some((workspace) => workspace.name === "repo")).toBe(true);
  });

  it("rejects a second clone for the same destination", async () => {
    const clone = deferred<GitCloneResult>();
    mocks.repository.mockReturnValue(clone.promise);
    const start = useGitCloneStore.getState().startClone(request());
    await vi.waitFor(() => expect(useGitCloneStore.getState().task?.phase).toBe("preparing"));
    await expect(useGitCloneStore.getState().startClone(request({ taskId: "task-2" })))
      .rejects.toThrow(/already running/i);
    clone.resolve(result());
    await start;
  });
});
