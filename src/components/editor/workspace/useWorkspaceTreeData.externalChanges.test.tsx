import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWorkspaceTreeData } from "./useWorkspaceTreeData";
import type { WorkspaceEntry } from "../../../lib/editor/workspace";

const fs = vi.hoisted(() => ({ workspaceListDir: vi.fn(), workspaceCompactChain: vi.fn(), workspaceListFilesRecursive: vi.fn() }));
vi.mock("../../../lib/editor/workspace", () => fs);
const root = { id: "home", name: "home", path: "/users/qa", kind: "folder" as const };
const roots = [root];
const expandedRoots = new Set([root.id]);
const expandedDirs = new Set(["home:Documents", "home:Pictures"]);
const onError = vi.fn();
const entry = (path: string, fileType: WorkspaceEntry["fileType"] = "file"): WorkspaceEntry => ({
  path, name: path.split("/").at(-1)!, fileType, size: 1, mtime: 1, isHidden: false,
});
const ready = (entries: WorkspaceEntry[]) => ({ state: "ready", entries, truncated: false });

beforeEach(() => {
  vi.useFakeTimers();
  fs.workspaceListDir.mockReset().mockImplementation(async (_root: string, path: string) => ready(
    path ? [entry(`${path}/notes.txt`)] : [entry("Documents", "dir"), entry("Pictures", "dir")],
  ));
  fs.workspaceCompactChain.mockReset().mockResolvedValue(ready([]));
  fs.workspaceListFilesRecursive.mockReset().mockResolvedValue(ready([]));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function mount(treeViewMode: "tree" | "files" = "tree") {
  const hook = renderHook(() => useWorkspaceTreeData({ roots, expandedRootIds: expandedRoots, expandedDirKeys: expandedDirs, treeViewMode, onError }));
  await act(async () => {});
  fs.workspaceListDir.mockClear();
  fs.workspaceListFilesRecursive.mockClear();
  return hook;
}

it("ignores unseen descendants of a broad root without resetting or walking expanded siblings", async () => {
  const { result } = await mount();
  const before = result.current.directories;
  act(() => result.current.refreshPath("/users/qa/.local/share/com.taomni.app.qa/localstorage/state-wal"));
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(fs.workspaceListDir).not.toHaveBeenCalled();
  expect(fs.workspaceListFilesRecursive).not.toHaveBeenCalled();
  expect(result.current.directories).toBe(before);
});

it("coalesces a file burst into its loaded parent and keeps sibling and focus-bearing rows mounted", async () => {
  const { result } = await mount();
  const sibling = result.current.directories["home:Pictures"];
  fs.workspaceListDir.mockResolvedValue(ready([entry("Documents/new.txt")]));
  act(() => {
    for (let i = 0; i < 100; i += 1) result.current.refreshPath(`/users/qa/Documents/file-${i}.txt`);
  });
  expect(result.current.directories["home:Documents"].loading).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(fs.workspaceListDir.mock.calls).toEqual([[root.path, "Documents"]]);
  expect(result.current.directories["home:Documents"].entries).toEqual([entry("Documents/new.txt")]);
  expect(result.current.directories["home:Pictures"]).toBe(sibling);
});

it("refreshes root structural changes while rejecting sibling prefixes outside the root", async () => {
  const { result } = await mount();
  act(() => {
    result.current.refreshPath("/users/qa-other/Documents/file.txt");
    result.current.refreshPath("/users/qa/new-folder");
  });
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(fs.workspaceListDir.mock.calls).toEqual([[root.path, ""]]);
});

it("refreshes a visible flat index once per burst without walking all expanded directories", async () => {
  const { result } = await mount("files");
  act(() => {
    result.current.refreshPath("/users/qa/closed/a.txt");
    result.current.refreshPath("/users/qa/closed/b.txt");
  });
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(fs.workspaceListFilesRecursive).toHaveBeenCalledTimes(1);
  expect(fs.workspaceListDir).not.toHaveBeenCalled();
});

it("cancels queued external work on explicit reset and unmount", async () => {
  const { result, unmount } = await mount();
  act(() => {
    result.current.refreshPath("/users/qa/Documents/new.txt");
    result.current.reset();
  });
  fs.workspaceListDir.mockClear();
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(fs.workspaceListDir).not.toHaveBeenCalled();
  act(() => result.current.refreshPath("/users/qa/Pictures/new.txt"));
  unmount();
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(fs.workspaceListDir).not.toHaveBeenCalled();
});

it("retains the newest flat listing when consecutive external bursts finish out of order", async () => {
  const { result } = await mount("files");
  const replies: Array<(value: ReturnType<typeof ready>) => void> = [];
  fs.workspaceListFilesRecursive.mockImplementation(() => new Promise((resolve) => replies.push(resolve)));
  act(() => result.current.refreshPath("/users/qa/closed/new.txt"));
  await act(async () => vi.advanceTimersByTimeAsync(250));
  act(() => result.current.refreshPath("/users/qa/closed/new.txt"));
  await act(async () => vi.advanceTimersByTimeAsync(250));
  await act(async () => replies[1](ready([])));
  await act(async () => replies[0](ready([entry("closed/new.txt")])));
  expect(result.current.flatFiles.home.entries).toEqual([]);
});
