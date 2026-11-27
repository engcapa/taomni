import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitCloneDefaults } from "../../../lib/gitClone";

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  repository: vi.fn(),
  cancel: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("../../../lib/gitClone", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/gitClone")>();
  return {
    ...actual,
    gitCloneProbe: mocks.probe,
    gitCloneRepository: mocks.repository,
    gitCloneCancel: mocks.cancel,
    listenGitCloneProgress: mocks.listen,
  };
});

vi.mock("../../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/ipc")>();
  return { ...actual, selectFolderPath: vi.fn() };
});

import { WorkspaceGitCloneModal } from "../WorkspaceGitCloneModal";
import { resetGitCloneStoreForTests, useGitCloneStore, type GitCloneTask } from "../../../stores/gitCloneStore";

const DEFAULTS: GitCloneDefaults = {
  gitAvailable: true,
  gitVersion: "git version 2.45.0",
  userName: "Global User",
  userEmail: "global@example.invalid",
  defaultBranch: "main",
  cloneRoot: "/home/qa/taomni-workspaces",
  appProxyEnabled: true,
  appProxyUrl: "http://192.168.0.110:31028",
  appProxyError: null,
  vaultState: "unlocked",
  savedTokenAvailable: true,
};

function seedOpen(defaults: GitCloneDefaults = DEFAULTS): void {
  useGitCloneStore.setState({
    open: true,
    defaults,
    defaultsStatus: "ready",
    defaultsError: null,
    task: null,
  });
}

function task(overrides: Partial<GitCloneTask> = {}): GitCloneTask {
  return {
    taskId: "task-ui",
    request: {
      taskId: "task-ui",
      url: "https://github.com/example/repo.git",
      destination: "/home/qa/taomni-workspaces/repo",
      workspaceName: "repo",
      branch: "main",
      proxyMode: "app",
      useSavedToken: false,
      rememberToken: false,
    },
    phase: "receiving",
    percent: 45,
    indeterminate: false,
    message: "Receiving objects: 45% (450/1000)",
    objectsDone: 450,
    objectsTotal: 1000,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    result: null,
    cancelRequested: false,
    ...overrides,
  };
}

beforeEach(() => {
  resetGitCloneStoreForTests();
  mocks.probe.mockReset().mockResolvedValue({
    defaultBranch: "trunk",
    headOid: "0123456789abcdef0123456789abcdef01234567",
    branches: ["trunk", "release"],
  });
  mocks.repository.mockReset();
  mocks.cancel.mockReset().mockResolvedValue(undefined);
  mocks.listen.mockReset().mockResolvedValue(() => undefined);
});

afterEach(cleanup);

describe("WorkspaceGitCloneModal", () => {
  it("prefills the location, branch, identity and Taomni application proxy", async () => {
    seedOpen();
    render(<WorkspaceGitCloneModal />);
    expect(await screen.findByDisplayValue(DEFAULTS.cloneRoot)).toBeVisible();
    expect(screen.getByTestId("workspace-git-clone-branch")).toHaveValue("main");
    expect(screen.getByTestId("workspace-git-clone-user-name")).toHaveValue("Global User");
    expect(screen.getByTestId("workspace-git-clone-user-email")).toHaveValue("global@example.invalid");
    expect(screen.getByTestId("workspace-git-clone-http-proxy")).toHaveValue(DEFAULTS.appProxyUrl);
    expect(screen.getByTestId("workspace-git-clone-https-proxy")).toHaveValue(DEFAULTS.appProxyUrl);
    expect(screen.getByTestId("workspace-git-clone-proxy-app")).toBeChecked();
    expect(screen.getByTestId("workspace-git-clone-use-saved-token")).toBeChecked();
    fireEvent.change(screen.getByTestId("workspace-git-clone-url"), {
      target: { value: "https://github.com/example/repo.git" },
    });
    await waitFor(() => expect(screen.getByTestId("workspace-git-clone-name")).toHaveValue("repo"));
    expect(screen.getByTestId("workspace-git-clone-destination")).toHaveTextContent(
      "/home/qa/taomni-workspaces/repo",
    );
  });

  it("derives the workspace name, switches proxy modes and blocks invalid submits", async () => {
    seedOpen();
    render(<WorkspaceGitCloneModal />);
    const url = screen.getByTestId("workspace-git-clone-url");
    fireEvent.change(url, { target: { value: "https://github.com/example/my-repo.git" } });
    await waitFor(() => expect(screen.getByTestId("workspace-git-clone-name")).toHaveValue("my-repo"));

    fireEvent.click(screen.getByTestId("workspace-git-clone-proxy-custom"));
    const http = screen.getByTestId("workspace-git-clone-http-proxy") as HTMLInputElement;
    expect(http).not.toBeDisabled();
    fireEvent.change(http, { target: { value: "http://custom.example.test:8080" } });
    expect(http).toHaveValue("http://custom.example.test:8080");

    fireEvent.click(screen.getByTestId("workspace-git-clone-proxy-none"));
    expect(screen.getByTestId("workspace-git-clone-http-proxy")).toBeDisabled();
    expect(screen.getByTestId("workspace-git-clone-http-proxy")).toHaveValue("");
    fireEvent.click(screen.getByTestId("workspace-git-clone-proxy-app"));
    expect(screen.getByTestId("workspace-git-clone-http-proxy")).toHaveValue(DEFAULTS.appProxyUrl);

    fireEvent.change(url, { target: { value: "" } });
    fireEvent.click(screen.getByTestId("workspace-git-clone-start"));
    expect(await screen.findByTestId("workspace-git-clone-url-error")).toHaveTextContent(
      "Enter a repository URL.",
    );
    expect(mocks.repository).not.toHaveBeenCalled();
  });

  it("detects the remote default branch through the probe and keeps user edits", async () => {
    seedOpen();
    render(<WorkspaceGitCloneModal />);
    fireEvent.change(screen.getByTestId("workspace-git-clone-url"), {
      target: { value: "https://github.com/example/repo.git" },
    });
    expect(screen.getByTestId("workspace-git-clone-branch")).toHaveValue("main");
    fireEvent.click(screen.getByTestId("workspace-git-clone-branch-detect"));
    await waitFor(() => expect(screen.getByTestId("workspace-git-clone-branch")).toHaveValue("trunk"));
    expect(mocks.probe).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://github.com/example/repo.git",
      proxyMode: "app",
    }));

    fireEvent.change(screen.getByTestId("workspace-git-clone-branch"), { target: { value: "feature/x" } });
    fireEvent.click(screen.getByTestId("workspace-git-clone-branch-detect"));
    await waitFor(() => expect(mocks.probe).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("workspace-git-clone-branch")).toHaveValue("feature/x");
  });

  it("renders progress while cloning and closing keeps the task alive", async () => {
    seedOpen();
    useGitCloneStore.setState({ task: task() });
    render(<WorkspaceGitCloneModal />);
    expect(screen.getByTestId("workspace-git-clone-progress")).toHaveAttribute("data-phase", "receiving");
    expect(screen.getByTestId("workspace-git-clone-percent")).toHaveTextContent("45%");
    expect(screen.getByTestId("workspace-git-clone-objects")).toHaveTextContent("450 / 1000 objects");
    expect(screen.getByTestId("workspace-git-clone-background-hint")).toBeVisible();
    fireEvent.click(screen.getByTestId("workspace-git-clone-close"));
    expect(useGitCloneStore.getState().open).toBe(false);
    expect(useGitCloneStore.getState().task?.phase).toBe("receiving");
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("shows the completed workspace and failure details", async () => {
    seedOpen();
    useGitCloneStore.setState({
      task: task({
        phase: "completed",
        percent: 100,
        indeterminate: false,
        result: {
          taskId: "task-ui",
          destination: "/home/qa/taomni-workspaces/repo",
          repoRoot: "/home/qa/taomni-workspaces/repo",
          branch: "main",
          defaultBranch: "main",
          headOid: "0123456789abcdef0123456789abcdef01234567",
          remoteUrl: "https://github.com/example/repo.git",
          durationMs: 1200,
          tokenRemembered: true,
        },
      }),
    });
    const completed = render(<WorkspaceGitCloneModal />);
    expect(screen.getByTestId("workspace-git-clone-success")).toHaveTextContent(
      "/home/qa/taomni-workspaces/repo",
    );
    expect(screen.getByTestId("workspace-git-clone-token-saved")).toBeVisible();
    completed.unmount();

    useGitCloneStore.setState({
      open: true,
      task: task({
        phase: "failed",
        indeterminate: true,
        percent: null,
        error: "fatal: repository not found",
      }),
    });
    render(<WorkspaceGitCloneModal />);
    expect(screen.getByTestId("workspace-git-clone-error")).toHaveTextContent(
      "fatal: repository not found",
    );
    expect(screen.getByTestId("workspace-git-clone-retry")).toBeEnabled();
  });

  it("opens as a top-layer dialog, guards IME Escape, dismisses on Escape, and restores focus", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    seedOpen();

    render(<WorkspaceGitCloneModal />);
    const dialog = screen.getByTestId("workspace-git-clone-modal");
    expect(dialog.tagName).toBe("DIALOG");
    const url = screen.getByTestId("workspace-git-clone-url");
    expect(url).toHaveFocus();

    fireEvent.keyDown(url, { key: "Escape", isComposing: true });
    expect(useGitCloneStore.getState().open).toBe(true);

    fireEvent.keyDown(url, { key: "Escape" });
    expect(useGitCloneStore.getState().open).toBe(false);
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
