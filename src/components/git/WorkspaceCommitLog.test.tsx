import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitBlobPair, GitChange, GitLogEntry } from "../../lib/git";
import { WorkspaceCommitLog } from "./WorkspaceCommitLog";

const gitMocks = vi.hoisted(() => ({
  gitBlobPair: vi.fn(),
  gitCommitFiles: vi.fn(),
  gitLog: vi.fn(),
}));

vi.mock("../../lib/git", () => gitMocks);

vi.mock("./DiffViewer", () => ({
  DiffViewer: ({ emptyLabel, loading }: { emptyLabel?: string; loading?: boolean }) => (
    <div data-testid="diff-viewer">{loading ? "Loading diff" : emptyLabel}</div>
  ),
}));

function commit(repoSubject: string, oid: string, date: string): GitLogEntry {
  return {
    oid,
    shortOid: oid.slice(0, 7),
    parents: [],
    authorName: "Ada",
    authorEmail: "ada@example.com",
    date,
    subject: repoSubject,
    body: "",
    refs: [],
  };
}

function change(path: string): GitChange {
  return {
    path,
    oldPath: null,
    status: "modified",
    staged: false,
    unstaged: false,
    conflict: false,
  };
}

function pair(path: string): GitBlobPair {
  return {
    path,
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
  };
}

describe("WorkspaceCommitLog", () => {
  beforeEach(() => {
    gitMocks.gitLog.mockReset();
    gitMocks.gitCommitFiles.mockReset();
    gitMocks.gitBlobPair.mockReset();
    gitMocks.gitLog.mockImplementation(async (repoRoot: string) => (
      repoRoot === "/repo/service"
        ? [commit("Service commit", "service123", "2026-02-02T10:00:00Z")]
        : [commit("App commit", "app1234", "2026-01-01T10:00:00Z")]
    ));
    gitMocks.gitCommitFiles.mockImplementation(async (repoRoot: string) => (
      repoRoot === "/repo/service" ? [change("src/service.ts")] : [change("src/App.tsx")]
    ));
    gitMocks.gitBlobPair.mockImplementation(async (_repoRoot: string, path: string) => pair(path));
  });

  afterEach(() => {
    cleanup();
  });

  it("aggregates commits across repositories and loads details from the selected commit repo", async () => {
    render(
      <WorkspaceCommitLog
        busy={false}
        roots={[
          { id: "app", name: "app", path: "/repo", repoRoot: "/repo/app", rootIds: ["root"] },
          { id: "service", name: "service", path: "/repo", repoRoot: "/repo/service", rootIds: ["root"] },
        ]}
        snapshots={{
          "/repo/app": { snapshot: null },
          "/repo/service": { snapshot: null },
        }}
      />,
    );

    expect((await screen.findAllByText("Service commit")).length).toBeGreaterThan(0);
    expect(screen.getByText("App commit")).toBeInTheDocument();
    expect(screen.getAllByText("service").length).toBeGreaterThan(0);
    expect(screen.getAllByText("app").length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(gitMocks.gitCommitFiles).toHaveBeenCalledWith("/repo/service", "service123");
    });
    expect(await screen.findByText("src/service.ts")).toBeInTheDocument();

    fireEvent.click(screen.getByText("App commit"));

    await waitFor(() => {
      expect(gitMocks.gitCommitFiles).toHaveBeenCalledWith("/repo/app", "app1234");
      expect(gitMocks.gitBlobPair).toHaveBeenCalledWith(
        "/repo/app",
        "src/App.tsx",
        "app1234^",
        "app1234",
        null,
      );
    });
    expect(await screen.findByText("src/App.tsx")).toBeInTheDocument();
  });
});
