import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitBlobPair } from "../../../../lib/git";
import { createDefaultCodeWorkspaceUi } from "../../../../stores/codeWorkspaceStore";
import { DEFAULT_WORKSPACE_INTELLIGENCE_PREFERENCES } from "../intelligencePreferences";
import type { WorkspaceGitSnapshotState } from "../codeWorkspaceModel";
import type { OpenFileViewModel } from "../editorGroupTypes";
import { useWorkspaceGitDecorations, type UseWorkspaceGitDecorationsContext } from "./useWorkspaceGitDecorations";

vi.mock("../../../../lib/git", () => ({ gitBlobPair: vi.fn(), gitBlameLines: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function snapshot(headOid = "head-a"): WorkspaceGitSnapshotState {
  return { changes: [], headOid, currentBranch: "main", ahead: 0, behind: 0, loading: false, error: null };
}

function context(): UseWorkspaceGitDecorationsContext {
  const file: OpenFileViewModel = {
    key: "root:project:repo-a/same.txt", ref: { kind: "root", rootId: "project", path: "repo-a/same.txt" },
    path: "repo-a/same.txt", languagePath: "same.txt", title: "same.txt", subtitle: "repo-a",
    text: "WORKTREE\n", savedText: "WORKTREE\n", hash: "saved", eol: "LF", mtime: 1, size: 9,
    loading: false, saving: false, dirty: false, documentRevision: 0, error: null,
  };
  const ui = createDefaultCodeWorkspaceUi();
  ui.editorGroups.primary.activeKey = file.key;
  ui.editorGroups.primary.openOrder = [file.key];
  ui.activeKey = file.key;
  const openFiles = { [file.key]: file };
  return {
    roots: [{ id: "project", name: "project", path: "/project", kind: "folder" }],
    gitRoots: ["repo-a", "repo-b"].map((name) => ({
      id: name, name, path: `/project/${name}`, repoRoot: `/project/${name}`, rootIds: ["project"],
    })),
    gitSnapshots: { "/project/repo-a": snapshot() }, workspaceUi: ui, editorGroups: ui.editorGroups,
    openFiles, openFilesRef: { current: openFiles }, cursorPositions: {}, workspaceInstanceId: "git-test",
    intelligencePreferences: { ...DEFAULT_WORKSPACE_INTELLIGENCE_PREFERENCES, inlineBlameEnabled: false },
  };
}

function pair(oldText: string) {
  return { oldText, newText: "WORKTREE\n", binary: false, oversize: false } as Awaited<ReturnType<typeof gitBlobPair>>;
}

describe("workspace Git HEAD ownership", () => {
  beforeEach(() => vi.mocked(gitBlobPair).mockReset());

  it("publishes a shared pending HEAD after another repository snapshot arrives", async () => {
    const pending = deferred<Awaited<ReturnType<typeof gitBlobPair>>>();
    vi.mocked(gitBlobPair).mockReturnValue(pending.promise);
    const initial = context();
    const { result, rerender } = renderHook(useWorkspaceGitDecorations, { initialProps: initial });
    expect(gitBlobPair).toHaveBeenCalledExactlyOnceWith("/project/repo-a", "same.txt", "HEAD", "");
    rerender({ ...initial, gitSnapshots: { ...initial.gitSnapshots, "/project/repo-b": snapshot("head-b") } });
    await act(async () => pending.resolve(pair("HEAD\n")));
    await waitFor(() => expect(result.current.gitHeadTextByFile[initial.workspaceUi.activeKey!]?.text).toBe("HEAD\n"));
    expect(gitBlobPair).toHaveBeenCalledOnce();
    await waitFor(() => expect(result.current.gitLineChangesByFile[initial.workspaceUi.activeKey!]?.[0]?.kind).toBe("modified"), { timeout: 2000 });
  });

  it("rejects a late previous HEAD when the repository advances", async () => {
    const old = deferred<Awaited<ReturnType<typeof gitBlobPair>>>();
    const next = deferred<Awaited<ReturnType<typeof gitBlobPair>>>();
    vi.mocked(gitBlobPair).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const initial = context();
    const { result, rerender } = renderHook(useWorkspaceGitDecorations, { initialProps: initial });
    rerender({ ...initial, gitSnapshots: { "/project/repo-a": snapshot("head-next") } });
    await act(async () => next.resolve(pair("NEW HEAD\n")));
    await act(async () => old.resolve(pair("STALE HEAD\n")));
    expect(result.current.gitHeadTextByFile[initial.workspaceUi.activeKey!]).toEqual({
      sourceKey: "/project/repo-a:head-next:same.txt", text: "NEW HEAD\n",
    });
  });

  it("settles a shared failure and can load a later HEAD", async () => {
    const pending = deferred<Awaited<ReturnType<typeof gitBlobPair>>>();
    vi.mocked(gitBlobPair).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(pair("RECOVERED\n"));
    const initial = context();
    const { result, rerender } = renderHook(useWorkspaceGitDecorations, { initialProps: initial });
    rerender({ ...initial, gitSnapshots: { ...initial.gitSnapshots } });
    await act(async () => pending.reject(new Error("read failed")));
    expect(result.current.gitHeadTextByFile[initial.workspaceUi.activeKey!]?.text).toBeNull();
    rerender({ ...initial, gitSnapshots: { "/project/repo-a": snapshot("head-next") } });
    await waitFor(() => expect(result.current.gitHeadTextByFile[initial.workspaceUi.activeKey!]?.text).toBe("RECOVERED\n"));
  });
});
