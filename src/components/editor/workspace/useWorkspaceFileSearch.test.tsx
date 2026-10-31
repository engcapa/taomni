import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { workspaceListDir, type WorkspaceTreeLoadResult, type WorkspaceEntry } from "../../../lib/editor/workspace";
import { useWorkspaceFileSearch } from "./useWorkspaceFileSearch";

vi.mock("../../../lib/editor/workspace", () => ({ workspaceListDir: vi.fn() }));
const roots = [{ id: "home", name: "HOME", path: "/home/test", kind: "folder" as const }];
const flat = { home: { entries: [], loaded: true, loading: false, truncated: true, error: null } };
const entry = (path: string, fileType: "file" | "dir" = "file"): WorkspaceEntry => ({
  name: path.split("/").pop()!, path, fileType, size: 0, mtime: 0, isHidden: path.startsWith("."),
});
const ready = (entries: WorkspaceEntry[]): WorkspaceTreeLoadResult<WorkspaceEntry> => ({ state: "ready", entries, truncated: false });
beforeEach(() => { vi.mocked(workspaceListDir).mockReset(); });

it("finds root and nested non-source files beyond the capped index while skipping build trees", async () => {
  vi.mocked(workspaceListDir).mockImplementation(async (_root, path) => ready(path ? [entry("Documents/report.txt")] : [
    entry(".bashrc"), entry("Documents", "dir"), entry("node_modules", "dir"), entry("target", "dir"),
  ]));
  const { result, rerender } = renderHook(({ query }) => useWorkspaceFileSearch(roots, flat, query), { initialProps: { query: ".bashrc" } });
  await waitFor(() => expect(result.current?.loading).toBe(false));
  expect(result.current?.items.map((item) => item.path)).toEqual([".bashrc"]);
  rerender({ query: "report.txt" });
  await waitFor(() => expect(result.current?.items.map((item) => item.path)).toEqual(["Documents/report.txt"]));
  expect(vi.mocked(workspaceListDir).mock.calls.some(([, path]) => path === "node_modules" || path === "target")).toBe(false);
});

it("cancels scheduling and ignores late directory responses when query closes or changes", async () => {
  let release!: (result: WorkspaceTreeLoadResult<WorkspaceEntry>) => void;
  vi.mocked(workspaceListDir).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
    .mockResolvedValue(ready([entry("new.txt")]));
  const { result, rerender } = renderHook(({ query }) => useWorkspaceFileSearch(roots, flat, query), { initialProps: { query: "old" } });
  await waitFor(() => expect(workspaceListDir).toHaveBeenCalledTimes(1));
  rerender({ query: "new" });
  await waitFor(() => expect(result.current?.loading).toBe(false));
  await act(async () => release(ready([entry("old.txt"), entry("old-directory", "dir")])));
  expect(result.current?.items.map((item) => item.path)).toEqual(["new.txt"]);
  expect(workspaceListDir).toHaveBeenCalledTimes(2);
  rerender({ query: "" });
  expect(result.current).toBeNull();
});

it("retains readable results and reports inaccessible directories; reuses complete indexes", async () => {
  vi.mocked(workspaceListDir).mockImplementation(async (_root, path) => path
    ? { state: "failed", message: "Permission denied" } : ready([entry("report.txt"), entry("private", "dir")]));
  const { result, rerender } = renderHook(({ truncated }) => useWorkspaceFileSearch(roots,
    { home: { ...flat.home, truncated } }, "report"), { initialProps: { truncated: true } });
  await waitFor(() => expect(result.current?.loading).toBe(false));
  expect(result.current?.items[0]?.path).toBe("report.txt");
  expect(result.current?.error).toBe("Permission denied");
  rerender({ truncated: false });
  expect(result.current).toBeNull();
});

it("does no work for empty queries and debounces rapid edits", async () => {
  vi.mocked(workspaceListDir).mockResolvedValue(ready([entry("report.txt")]));
  const { result, rerender } = renderHook(({ query }) => useWorkspaceFileSearch(roots, flat, query), { initialProps: { query: "" } });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
  expect(workspaceListDir).not.toHaveBeenCalled();
  rerender({ query: "r" });
  rerender({ query: "rep" });
  rerender({ query: "report" });
  await waitFor(() => expect(result.current?.loading).toBe(false));
  expect(workspaceListDir).toHaveBeenCalledTimes(1);
  expect(result.current?.items[0]?.path).toBe("report.txt");
});

it("keeps at most two reads outstanding across query changes and stops after close", async () => {
  const releases: Array<() => void> = [];
  vi.mocked(workspaceListDir).mockResolvedValueOnce(ready([entry("one", "dir"), entry("two", "dir"), entry("three", "dir")]))
    .mockImplementation(() => new Promise((resolve) => releases.push(() => resolve(ready([entry("report.txt")])))));
  const { result, rerender } = renderHook(({ query }) => useWorkspaceFileSearch(roots, flat, query), { initialProps: { query: "old" } });
  await waitFor(() => expect(releases).toHaveLength(2));
  rerender({ query: "new" });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
  expect(workspaceListDir).toHaveBeenCalledTimes(3);
  rerender({ query: "" });
  await act(async () => releases.forEach((release) => release()));
  expect(result.current).toBeNull();
  expect(workspaceListDir).toHaveBeenCalledTimes(3);
});

it("finds empty and heavy folders themselves without walking excluded contents, and bounds broad results", async () => {
  vi.mocked(workspaceListDir).mockImplementation(async (_root, path) => ready(path ? [] : [entry("Empty", "dir"), entry("target", "dir")]));
  const { result, rerender } = renderHook(({ query }) => useWorkspaceFileSearch(roots, flat, query, true), { initialProps: { query: "Empty" } });
  await waitFor(() => expect(result.current?.loading).toBe(false));
  expect(result.current?.items[0]?.entry.fileType).toBe("dir");
  rerender({ query: "target" });
  await waitFor(() => expect(result.current?.loading).toBe(false));
  expect(result.current?.items[0]?.path).toBe("target");
  expect(vi.mocked(workspaceListDir).mock.calls.some(([, path]) => path === "target")).toBe(false);
  vi.mocked(workspaceListDir).mockResolvedValue(ready(Array.from({ length: 1000 }, (_, index) => entry(`doc-${index}.txt`))));
  rerender({ query: "doc-" });
  await waitFor(() => expect(result.current?.loading).toBe(false));
  expect(result.current?.items).toHaveLength(200);
  expect(result.current?.truncated).toBe(true);
});
