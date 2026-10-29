import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CodeWorkspaceFileRef } from "../../../types";
import { type WorkspaceGitRoot } from "../../../lib/editor/workspace";
import { useWorkspaceGitRootDiscovery } from "./useWorkspaceGitRootDiscovery";

const mocks = vi.hoisted(() => ({ workspaceDetectGitRoots: vi.fn() }));
vi.mock("../../../lib/editor/workspace", () => mocks);
const roots = [{ id: "home", name: "Home", path: "/home/test", kind: "folder" as const }];
const file = (path: string): CodeWorkspaceFileRef => ({ kind: "root", rootId: "home", path });
const repo = (name: string): WorkspaceGitRoot => ({
  id: name, name, path: "/home/test", repoRoot: `/home/test/${name}`, rootIds: ["home"],
});
const frames = new Map<number, FrameRequestCallback>();

beforeEach(() => {
  frames.clear();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => { frames.set(++id, frame); return id; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  mocks.workspaceDetectGitRoots.mockReset().mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function flushFrames() {
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((frame) => frame(performance.now()));
  });
}

it("looks up the active file after paint without repeating ordinary root scans", async () => {
  mocks.workspaceDetectGitRoots.mockResolvedValueOnce([repo("ordinary")]);
  const { result, rerender } = renderHook(({ path }) => useWorkspaceGitRootDiscovery({
    roots, activeFile: file(path), visible: true, onError: vi.fn(),
  }), { initialProps: { path: "project/a.txt" } });
  await waitFor(() => expect(result.current.gitRoots).toEqual([repo("ordinary")]));
  expect(mocks.workspaceDetectGitRoots).toHaveBeenCalledTimes(1);
  await flushFrames();
  expect(mocks.workspaceDetectGitRoots).toHaveBeenLastCalledWith([{
    id: "home", name: "Home", path: "/home/test", activeFilePath: "project/a.txt", ancestorsOnly: true,
  }]);
  rerender({ path: "project/b.txt" });
  await flushFrames();
  expect(mocks.workspaceDetectGitRoots).toHaveBeenCalledTimes(3);
  expect(mocks.workspaceDetectGitRoots.mock.calls.filter(([candidates]) => !candidates[0].ancestorsOnly)).toHaveLength(1);
  expect(result.current.gitRoots).toEqual([repo("ordinary")]);
});

it("suppresses late file lookups after another file, root removal or hide", async () => {
  let resolve!: (roots: WorkspaceGitRoot[]) => void;
  const { result, rerender } = renderHook(({ path, visible, currentRoots }) => useWorkspaceGitRootDiscovery({
    roots: currentRoots, activeFile: file(path), visible, onError: vi.fn(),
  }), { initialProps: { path: "first/a.txt", visible: true, currentRoots: roots } });
  await waitFor(() => expect(result.current.gitRootsLoading).toBe(false));
  mocks.workspaceDetectGitRoots.mockReturnValueOnce(new Promise((reply) => { resolve = reply; }));
  await flushFrames();
  rerender({ path: "second/b.txt", visible: true, currentRoots: roots });
  mocks.workspaceDetectGitRoots.mockResolvedValueOnce([repo("second")]);
  await flushFrames();
  await act(async () => { resolve([repo("first")]); });
  expect(result.current.gitRoots).toEqual([repo("second")]);
  rerender({ path: "second/b.txt", visible: false, currentRoots: [] });
  expect(result.current.gitRoots).toEqual([]);
  expect(frames.size).toBe(0);
});

it("reports ancestor failures and retries them when the workspace becomes visible again", async () => {
  const onError = vi.fn();
  const { result, rerender } = renderHook(({ visible }) => useWorkspaceGitRootDiscovery({
    roots, activeFile: file("project/a.txt"), visible, onError,
  }), { initialProps: { visible: true } });
  await waitFor(() => expect(result.current.gitRootsLoading).toBe(false));
  mocks.workspaceDetectGitRoots.mockRejectedValueOnce(new Error("public git lookup error"));
  await flushFrames();
  expect(onError).toHaveBeenCalledWith("public git lookup error");
  rerender({ visible: false });
  rerender({ visible: true });
  await waitFor(() => expect(result.current.gitRootsLoading).toBe(false));
  mocks.workspaceDetectGitRoots.mockResolvedValueOnce([repo("project")]);
  await flushFrames();
  expect(result.current.gitRoots).toEqual([repo("project")]);
});
