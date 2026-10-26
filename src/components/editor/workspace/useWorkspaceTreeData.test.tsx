import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeWorkspaceRootInfo } from "../../../types";
import type { WorkspaceTreeLoadResult } from "../../../lib/editor/workspace";
import { useWorkspaceTreeData } from "./useWorkspaceTreeData";

const workspaceMocks = vi.hoisted(() => ({
  workspaceListDir: vi.fn(),
  workspaceCompactChain: vi.fn(),
  workspaceListFilesRecursive: vi.fn(),
}));

vi.mock("../../../lib/editor/workspace", () => workspaceMocks);

const root: CodeWorkspaceRootInfo = {
  id: "root-1",
  name: "repo",
  path: "/repo",
  kind: "folder",
};
const roots = [root];
const expandedRoots = new Set([root.id]);
const noExpandedRoots = new Set<string>();

const ready = (entries: unknown[], truncated = false): WorkspaceTreeLoadResult<unknown> => ({
  state: "ready",
  entries,
  truncated,
});

const ENTRY = {
  name: "a.ts",
  path: "a.ts",
  fileType: "file",
  size: 1,
  mtime: 1,
  isHidden: false,
};

describe("useWorkspaceTreeData", () => {
  beforeEach(() => {
    workspaceMocks.workspaceListDir.mockReset().mockResolvedValue(ready([]));
    workspaceMocks.workspaceCompactChain.mockReset().mockResolvedValue(ready([]));
    workspaceMocks.workspaceListFilesRecursive.mockReset().mockResolvedValue(ready([]));
  });

  it("loads expanded roots and recursive flat indexes", async () => {
    const onError = vi.fn();
    const { result, rerender } = renderHook(
      ({ mode, filter }: { mode: "tree" | "flat"; filter?: string }) => useWorkspaceTreeData({
        roots,
        expandedRootIds: expandedRoots,
        treeViewMode: mode,
        treeFilter: filter ?? "",
        onError,
      }),
      { initialProps: { mode: "tree" as "tree" | "flat", filter: "" } },
    );

    await waitFor(() => expect(result.current.directories["root-1:"]?.loaded).toBe(true));
    expect(workspaceMocks.workspaceListDir).toHaveBeenCalledWith("/repo", "");
    expect(workspaceMocks.workspaceListFilesRecursive).not.toHaveBeenCalled();

    rerender({ mode: "tree", filter: "http" });
    await waitFor(() => expect(result.current.flatFiles[root.id]?.loaded).toBe(true));
    expect(workspaceMocks.workspaceListFilesRecursive).toHaveBeenCalledWith("/repo", "", 25, 2_000);

    // Flat mode reuses the already-warmed index (no second recursive scan).
    workspaceMocks.workspaceListFilesRecursive.mockClear();
    rerender({ mode: "flat", filter: "" });
    expect(result.current.flatFiles[root.id]?.loaded).toBe(true);
    expect(workspaceMocks.workspaceListFilesRecursive).not.toHaveBeenCalled();
  });

  it("rehydrates visible expanded descendants without scanning collapsed branches", async () => {
    const dir = (path: string) => ({ ...ENTRY, path, name: path.split("/").at(-1) ?? path, fileType: "dir" });
    const listings: Record<string, typeof ENTRY[]> = {
      "": [dir("src"), dir("Documents"), dir("closed")],
      src: [dir("src/main"), dir("src/collapsed"), ENTRY],
      "src/main": [{ ...ENTRY, path: "src/main/a.ts" }],
      Documents: [{ ...ENTRY, path: "Documents/notes.txt" }],
    };
    workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => ready(listings[path] ?? []));
    const onError = vi.fn();
    const { result } = renderHook(() => useWorkspaceTreeData({
      roots, expandedRootIds: expandedRoots,
      expandedDirKeys: new Set(["root-1:src", "root-1:src/main", "root-1:Documents", "root-1:closed/hidden"]),
      treeViewMode: "tree", onError,
    }));
    await waitFor(() => expect(result.current.directories["root-1:src/main"]?.entries).toEqual([
      { ...ENTRY, path: "src/main/a.ts" },
    ]));
    expect(result.current.directories["root-1:Documents"]?.loaded).toBe(true);
    expect(workspaceMocks.workspaceListDir.mock.calls.map(([, path]) => path).sort())
      .toEqual(["", "Documents", "src", "src/main"]);
    expect(workspaceMocks.workspaceListFilesRecursive).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("loads restored descendants when a saved workspace definition arrives after mount", async () => {
    workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => ready(
      path ? [{ ...ENTRY, path: "src/a.ts" }] : [{ ...ENTRY, name: "src", path: "src", fileType: "dir" }],
    ));
    const onError = vi.fn();
    const { result, rerender } = renderHook(({ currentRoots }) => useWorkspaceTreeData({
      roots: currentRoots, expandedRootIds: expandedRoots, expandedDirKeys: new Set(["root-1:src"]),
      treeViewMode: "list", onError,
    }), { initialProps: { currentRoots: [] as CodeWorkspaceRootInfo[] } });
    expect(workspaceMocks.workspaceListDir).not.toHaveBeenCalled();
    rerender({ currentRoots: roots });
    await waitFor(() => expect(result.current.directories["root-1:src"]?.loaded).toBe(true));
    expect(result.current.directories["root-1:src"].entries).toEqual([{ ...ENTRY, path: "src/a.ts" }]);
    expect(workspaceMocks.workspaceListDir).toHaveBeenCalledTimes(2);
  });

  it("preserves a restored directory error until an explicit retry", async () => {
    workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => path
      ? { state: "failed", message: "Permission denied" }
      : ready([{ ...ENTRY, name: "src", path: "src", fileType: "dir" }]));
    const onError = vi.fn();
    const { result, rerender } = renderHook(() => useWorkspaceTreeData({
      roots, expandedRootIds: expandedRoots, expandedDirKeys: new Set(["root-1:src"]), treeViewMode: "tree", onError,
    }));
    await waitFor(() => expect(result.current.directories["root-1:src"]?.error).toBe("Permission denied"));
    rerender();
    expect(workspaceMocks.workspaceListDir).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    workspaceMocks.workspaceListDir.mockResolvedValueOnce(ready([ENTRY]));
    await act(async () => result.current.loadDir(root.id, "src"));
    expect(result.current.directories["root-1:src"]).toMatchObject({ loaded: true, error: null, entries: [ENTRY] });
  });

  it("discards in-flight results after reset and removes one root cache", async () => {
    let resolveListing!: (result: WorkspaceTreeLoadResult<unknown>) => void;
    workspaceMocks.workspaceListDir.mockImplementation(() => new Promise<WorkspaceTreeLoadResult<unknown>>((resolve) => {
      resolveListing = resolve;
    }));
    const onError = vi.fn();
    const { result } = renderHook(() => useWorkspaceTreeData({
      roots,
      expandedRootIds: noExpandedRoots,
      treeViewMode: "tree",
      onError,
    }));

    let pending: Promise<void>;
    act(() => {
      pending = result.current.loadDir(root.id, "src");
    });
    await waitFor(() => expect(result.current.directories["root-1:src"]?.loading).toBe(true));
    act(() => result.current.reset());
    resolveListing(ready([]));
    await act(async () => pending);
    expect(result.current.directories).toEqual({});

    workspaceMocks.workspaceListDir.mockResolvedValue(ready([]));
    await act(async () => result.current.loadDir(root.id, "src"));
    expect(result.current.directories["root-1:src"]?.loaded).toBe(true);
    act(() => result.current.removeRoot(root.id));
    expect(result.current.directories).toEqual({});
  });

  it("retains directory rows during refresh and rejects a response from the previous generation", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useWorkspaceTreeData({
      roots, expandedRootIds: noExpandedRoots, treeViewMode: "tree", onError,
    }));
    workspaceMocks.workspaceListDir.mockResolvedValueOnce(ready([ENTRY]));
    await act(async () => result.current.loadDir(root.id, "src"));
    const pending: Array<(value: WorkspaceTreeLoadResult<unknown>) => void> = [];
    workspaceMocks.workspaceListDir.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    let oldRequest!: Promise<void>, newRequest!: Promise<void>;
    act(() => { oldRequest = result.current.loadDir(root.id, "src"); });
    act(() => result.current.reset({ retainListings: true }));
    act(() => { newRequest = result.current.loadDir(root.id, "src"); });
    expect(result.current.directories["root-1:src"]).toMatchObject({ loaded: true, loading: true, entries: [ENTRY] });
    await act(async () => { pending[0](ready([])); await oldRequest; });
    expect(result.current.directories["root-1:src"].entries).toEqual([ENTRY]);
    const updated = { ...ENTRY, size: 20 };
    await act(async () => { pending[1](ready([updated])); await newRequest; });
    expect(result.current.directories["root-1:src"]).toMatchObject({ loading: false, entries: [updated] });
  });

  it("keeps the compact endpoint mounted until its refreshed chain is ready", async () => {
    const onError = vi.fn();
    const directory = { ...ENTRY, name: "src", path: "src", fileType: "dir" };
    workspaceMocks.workspaceListDir.mockResolvedValue(ready([directory]));
    workspaceMocks.workspaceCompactChain.mockResolvedValue(ready([{ ...ENTRY, path: "src/main/a.ts" }]));
    const { result } = renderHook(() => useWorkspaceTreeData({
      roots, expandedRootIds: expandedRoots, treeViewMode: "compact", onError,
    }));
    await waitFor(() => expect(result.current.compactChains["root-1:src"]?.path).toBe("src/main"));
    let resolveChain!: (value: WorkspaceTreeLoadResult<unknown>) => void;
    workspaceMocks.workspaceCompactChain.mockImplementationOnce(() => new Promise((resolve) => { resolveChain = resolve; }));
    act(() => result.current.reset({ retainListings: true }));
    await waitFor(() => expect(resolveChain).toBeTypeOf("function"));
    expect(result.current.compactChains["root-1:src"]).toMatchObject({ path: "src/main", loading: true });
    await act(async () => resolveChain(ready([{ ...ENTRY, path: "src/changed/a.ts" }])));
    expect(result.current.compactChains["root-1:src"]).toMatchObject({ path: "src/changed", loading: false });
  });

  it.each(["flat", "files", "tree", "packages"] as const)("refreshes a retained recursive index in %s view", async (mode) => {
    const onError = vi.fn();
    workspaceMocks.workspaceListFilesRecursive.mockResolvedValue(ready([ENTRY]));
    const { result } = renderHook(() => useWorkspaceTreeData({
      roots, expandedRootIds: noExpandedRoots, treeViewMode: mode, treeFilter: mode === "tree" ? "a" : "", onError,
    }));
    await waitFor(() => expect(result.current.flatFiles[root.id]?.loaded).toBe(true));
    let resolveIndex!: (value: WorkspaceTreeLoadResult<unknown>) => void;
    workspaceMocks.workspaceListFilesRecursive.mockImplementationOnce(() => new Promise((resolve) => { resolveIndex = resolve; }));
    act(() => result.current.reset({ retainListings: true }));
    await waitFor(() => expect(resolveIndex).toBeTypeOf("function"));
    expect(result.current.flatFiles[root.id]).toMatchObject({ loaded: true, loading: true, entries: [ENTRY] });
    await act(async () => resolveIndex(ready([])));
    expect(result.current.flatFiles[root.id]).toMatchObject({ loading: false, entries: [] });
  });

  // ── W0 §8.20.1 boundary: non-ready unions keep cache + error, never crash ──

  it.each([
    ["failed", { state: "failed", message: "workspace_list_dir returned no payload" }],
    ["unavailable", { state: "unavailable", reason: "backend missing" }],
  ])("keeps previous cache + error row when listDir resolves %s", async (_label, payload) => {
    const onError = vi.fn();
    const { result } = renderHook(() => useWorkspaceTreeData({
      roots,
      expandedRootIds: noExpandedRoots,
      treeViewMode: "tree",
      onError,
    }));

    // Seed a good cache first.
    workspaceMocks.workspaceListDir.mockResolvedValueOnce(ready([ENTRY]));
    await act(async () => result.current.loadDir(root.id, "src"));
    expect(result.current.directories["root-1:src"]).toMatchObject({
      loaded: true,
      error: null,
    });

    workspaceMocks.workspaceListDir.mockResolvedValueOnce(payload);
    await act(async () => result.current.loadDir(root.id, "src"));
    const state = result.current.directories["root-1:src"];
    expect(state?.loaded).toBe(true);
    expect(state?.loading).toBe(false);
    expect(state?.error).toBeTruthy();
    // Previous entries survive (error row + retry, not a blank/crashed tree).
    expect(state?.entries).toEqual([ENTRY]);
    expect(onError).toHaveBeenCalled();
  });

  it("propagates the truncated flag from a capped recursive listing", async () => {
    workspaceMocks.workspaceListFilesRecursive.mockResolvedValue(
      ready([ENTRY], true),
    );
    const onError = vi.fn();
    const { result } = renderHook(() => useWorkspaceTreeData({
      roots,
      expandedRootIds: noExpandedRoots,
      treeViewMode: "flat",
      onError,
    }));
    await waitFor(() => expect(result.current.flatFiles[root.id]?.loaded).toBe(true));
    expect(result.current.flatFiles[root.id]?.truncated).toBe(true);
  });

  it("does not resurrect cache when the root disappears mid-flight", async () => {
    let resolveListing!: (result: WorkspaceTreeLoadResult<unknown>) => void;
    workspaceMocks.workspaceListDir.mockImplementation(() => new Promise<WorkspaceTreeLoadResult<unknown>>((resolve) => {
      resolveListing = resolve;
    }));
    const onError = vi.fn();
    const { result, rerender } = renderHook(
      ({ currentRoots }: { currentRoots: CodeWorkspaceRootInfo[] }) => useWorkspaceTreeData({
        roots: currentRoots,
        expandedRootIds: noExpandedRoots,
        treeViewMode: "tree",
        onError,
      }),
      { initialProps: { currentRoots: roots } },
    );

    let pending: Promise<void>;
    act(() => {
      pending = result.current.loadDir(root.id, "src");
    });
    await waitFor(() => expect(result.current.directories["root-1:src"]?.loading).toBe(true));

    // Root removed while the request is in flight…
    rerender({ currentRoots: [] });
    act(() => result.current.removeRoot(root.id));
    resolveListing(ready([ENTRY]));
    await act(async () => pending);
    // …the late response must not write state back for the dead root.
    expect(result.current.directories["root-1:src"]).toBeUndefined();
  });
});
