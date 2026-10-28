import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEntry, WorkspaceTreeLoadResult } from "../../../lib/editor/workspace";
import type { CodeWorkspaceRootInfo } from "../../../types";
import { useWorkspaceTreeData } from "./useWorkspaceTreeData";

const workspaceMocks = vi.hoisted(() => ({
  workspaceListDir: vi.fn(),
  workspaceCompactChain: vi.fn(),
  workspaceListFilesRecursive: vi.fn(),
}));
vi.mock("../../../lib/editor/workspace", () => workspaceMocks);

const root: CodeWorkspaceRootInfo = { id: "home", name: "HOME", path: "C:/Users/qa", kind: "folder" };
const roots = [root];
const expandedRoots = new Set([root.id]);
const noExpandedDirs = new Set<string>();
const onError = vi.fn();
type Result = WorkspaceTreeLoadResult<WorkspaceEntry>;
const ready = (entries: WorkspaceEntry[]): Result => ({ state: "ready", entries, truncated: false });
const entry = (path: string, fileType: "dir" | "file" = "dir"): WorkspaceEntry => ({
  name: path.split("/").at(-1)!, path, fileType, size: 0, mtime: 1, isHidden: false,
});
const requestedPaths = () => workspaceMocks.workspaceCompactChain.mock.calls.map(([, path]) => path);

describe("Compact workspace directory loading", () => {
  beforeEach(() => {
    workspaceMocks.workspaceListDir.mockReset().mockResolvedValue(ready([]));
    workspaceMocks.workspaceCompactChain.mockReset().mockResolvedValue(ready([]));
    workspaceMocks.workspaceListFilesRecursive.mockReset().mockResolvedValue(ready([]));
    onError.mockReset();
  });

  it("compacts visible rows without walking the descendants of collapsed Home directories", async () => {
    workspaceMocks.workspaceListDir.mockResolvedValue(ready([entry("AppData"), entry("Documents")]));
    workspaceMocks.workspaceCompactChain.mockImplementation(async (_root: string, path: string) => ready({
      AppData: [entry("AppData/Local"), entry("AppData/settings.ini", "file")],
      "AppData/Local": [entry("AppData/Local/Packages"), entry("AppData/Local/cache.db", "file")],
      Documents: [entry("Documents/notes.txt", "file")],
    }[path] ?? []));
    const { result, rerender } = renderHook(({ expandedDirKeys, expandedRootIds }) => useWorkspaceTreeData({
      roots, expandedRootIds, expandedDirKeys, treeViewMode: "compact", onError,
    }), { initialProps: { expandedDirKeys: noExpandedDirs, expandedRootIds: expandedRoots } });

    await waitFor(() => expect(result.current.compactChains["home:Documents"]?.loading).toBe(false));
    expect(requestedPaths().sort()).toEqual(["AppData", "Documents"]);
    expect(result.current.directories["home:AppData/Local"]).toBeUndefined();

    rerender({ expandedDirKeys: new Set(["home:AppData"]), expandedRootIds: expandedRoots });
    await waitFor(() => expect(result.current.compactChains["home:AppData/Local"]?.loading).toBe(false));
    expect(requestedPaths().sort()).toEqual(["AppData", "AppData/Local", "Documents"]);
    expect(result.current.compactChains["home:AppData/Local/Packages"]).toBeUndefined();
    expect(workspaceMocks.workspaceListFilesRecursive).not.toHaveBeenCalled();

    // A watcher refresh must not revisit listings retained under a now-closed row.
    rerender({ expandedDirKeys: noExpandedDirs, expandedRootIds: expandedRoots });
    workspaceMocks.workspaceCompactChain.mockClear();
    act(() => result.current.reset({ retainListings: true }));
    await waitFor(() => expect(result.current.compactChains["home:Documents"]?.loading).toBe(false));
    expect(requestedPaths().sort()).toEqual(["AppData", "Documents"]);

    // Even the root can be collapsed while its old listings remain cached.
    rerender({ expandedDirKeys: noExpandedDirs, expandedRootIds: new Set<string>() });
    workspaceMocks.workspaceCompactChain.mockClear();
    act(() => result.current.reset({ retainListings: true }));
    await act(async () => {});
    expect(requestedPaths()).toEqual([]);
  });

  it("follows expanded compact endpoints and restores their visible children", async () => {
    workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => ready(
      path ? [entry("src/main/java/api")] : [entry("src")],
    ));
    workspaceMocks.workspaceCompactChain.mockImplementation(async (_root: string, path: string) => ready({
      src: [entry("src/main/java/api"), entry("src/main/java/App.java", "file")],
      "src/main/java/api": [entry("src/main/java/api/nested"), entry("src/main/java/api/index.ts", "file")],
    }[path] ?? []));
    const { result } = renderHook(() => useWorkspaceTreeData({
      roots, expandedRootIds: expandedRoots, expandedDirKeys: new Set(["home:src/main/java"]),
      treeViewMode: "compact", onError,
    }));
    await waitFor(() => expect(result.current.compactChains["home:src/main/java/api"]?.loading).toBe(false));
    expect(result.current.compactChains["home:src"]?.path).toBe("src/main/java");
    expect(requestedPaths().sort()).toEqual(["src", "src/main/java/api"]);
    expect(result.current.compactChains["home:src/main/java/api/nested"]).toBeUndefined();
  });

  it("bounds native requests across refreshes and discards stale results", async () => {
    const folders = Array.from({ length: 12 }, (_, i) => entry(`folder-${i}`));
    workspaceMocks.workspaceListDir.mockResolvedValue(ready(folders));
    const pending: Array<{ path: string; resolve: (value: Result) => void }> = [];
    let active = 0;
    let peak = 0;
    workspaceMocks.workspaceCompactChain.mockImplementation((_root: string, path: string) => {
      active += 1;
      peak = Math.max(peak, active);
      return new Promise<Result>((resolve) => pending.push({ path, resolve: (value) => { active -= 1; resolve(value); } }));
    });
    const { result, rerender } = renderHook(({ currentRoots }) => useWorkspaceTreeData({
      roots: currentRoots, expandedRootIds: expandedRoots, treeViewMode: "compact", onError,
    }), { initialProps: { currentRoots: roots } });
    await waitFor(() => expect(pending.length).toBeGreaterThan(0));
    expect(active).toBeLessThanOrEqual(4);
    act(() => result.current.reset({ retainListings: true }));
    expect(peak).toBeLessThanOrEqual(4);

    const stale = pending.shift()!;
    await act(async () => stale.resolve(ready([entry(`${stale.path}/obsolete/file.txt`, "file")])));
    expect(result.current.directories[`home:${stale.path}/obsolete`]).toBeUndefined();
    expect(peak).toBeLessThanOrEqual(4);

    // Removing a root also cancels its queued work and its right to publish late results.
    rerender({ currentRoots: [] });
    act(() => result.current.removeRoot(root.id));
    const callsBeforeRemoval = requestedPaths().length;
    await act(async () => {
      for (const request of pending.splice(0)) request.resolve(ready([entry(`${request.path}/late.txt`, "file")]));
    });
    expect(requestedPaths()).toHaveLength(callsBeforeRemoval);
    expect(result.current.compactChains).toEqual({});
    expect(result.current.directories).toEqual({});
  });

  it("does not automatically retry denied directories when a sibling finishes", async () => {
    workspaceMocks.workspaceListDir.mockResolvedValue(ready([entry("Denied"), entry("Documents")]));
    workspaceMocks.workspaceCompactChain.mockImplementation(async (_root: string, path: string): Promise<Result> => path === "Denied"
      ? { state: "failed", message: "Access is denied" }
      : ready([entry("Documents/notes.txt", "file")]));
    const { result } = renderHook(() => useWorkspaceTreeData({
      roots, expandedRootIds: expandedRoots, treeViewMode: "compact", onError,
    }));
    await waitFor(() => expect(result.current.compactChains["home:Documents"]?.loading).toBe(false));
    expect(result.current.compactChains["home:Denied"]?.error).toBe("Access is denied");
    expect(requestedPaths().filter((path) => path === "Denied")).toHaveLength(1);

    workspaceMocks.workspaceCompactChain.mockResolvedValue(ready([]));
    act(() => result.current.reset({ retainListings: true }));
    await waitFor(() => expect(result.current.compactChains["home:Denied"]?.error).toBeNull());
    await waitFor(() => expect(result.current.compactChains["home:Denied"]?.loading).toBe(false));
    expect(requestedPaths().filter((path) => path === "Denied")).toHaveLength(2);
  });

  it("stops queued work when leaving Compact and after unmount", async () => {
    workspaceMocks.workspaceListDir.mockResolvedValue(ready(Array.from({ length: 12 }, (_, i) => entry(`folder-${i}`))));
    const pending: Array<(value: Result) => void> = [];
    workspaceMocks.workspaceCompactChain.mockImplementation(() => new Promise<Result>((resolve) => pending.push(resolve)));
    const { rerender, unmount } = renderHook(({ mode }: { mode: "tree" | "compact" }) => useWorkspaceTreeData({
      roots, expandedRootIds: expandedRoots, treeViewMode: mode, onError,
    }), { initialProps: { mode: "compact" as "tree" | "compact" } });
    await waitFor(() => expect(pending.length).toBeGreaterThan(0));
    const started = requestedPaths().length;
    expect(started).toBeLessThanOrEqual(4);
    rerender({ mode: "tree" });
    await act(async () => pending.splice(0).forEach((resolve) => resolve(ready([]))));
    expect(requestedPaths()).toHaveLength(started);
    rerender({ mode: "compact" });
    await waitFor(() => expect(pending.length).toBeGreaterThan(0));
    const beforeUnmount = requestedPaths().length;
    unmount();
    await act(async () => pending.splice(0).forEach((resolve) => resolve(ready([]))));
    expect(requestedPaths()).toHaveLength(beforeUnmount);
  });
});
