import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useExplorerSearch } from "./useExplorerSearch";
import { explorerCancelOperation, explorerSearchEntries, type ExplorerSearchResults } from "../../lib/explorer";
import { setExplorerPreferences } from "./explorerPreferences";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../../lib/explorer", () => ({
  explorerSearchEntries: vi.fn(),
  explorerCancelOperation: vi.fn(async () => {}),
}));

function result(path: string, overrides: Partial<ExplorerSearchResults> = {}): ExplorerSearchResults {
  return {
    entries: [{ name: "match.md", path, size: 1, mtime: 1, mode: 0, fileType: "file", isHidden: false, relativePath: "nested/match.md" }],
    scanned: 12, truncated: false, cancelled: false, failed: [], ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setExplorerPreferences({ searchRecursive: false });
});

afterEach(cleanup);

describe("Explorer glob and recursive search", () => {
  it("keeps plain current-folder filtering local until recursion is enabled", async () => {
    vi.mocked(explorerSearchEntries).mockResolvedValue(result("/root/match.md"));
    const { result: controller } = renderHook(() => useExplorerSearch("/root", true, 0));
    act(() => controller.current.setQuery("notes"));
    expect(controller.current.active).toBe(false);
    expect(explorerSearchEntries).not.toHaveBeenCalled();
    act(() => controller.current.setRecursive(true));
    await waitFor(() => expect(explorerSearchEntries).toHaveBeenCalledWith("/root", "notes", true, true, expect.any(String)));
    await waitFor(() => expect(controller.current.results).toHaveLength(1));
    expect(controller.current.relativePaths["/root/match.md"]).toBe("nested/match.md");
  });

  it("uses glob search without recursion and preserves result metadata", async () => {
    vi.mocked(explorerSearchEntries).mockResolvedValue(result("/root/match.md", { truncated: true }));
    const { result: controller } = renderHook(() => useExplorerSearch("/root", true, 0));
    act(() => controller.current.setQuery("*.md"));
    await waitFor(() => expect(controller.current.truncated).toBe(true));
    expect(explorerSearchEntries).toHaveBeenCalledWith("/root", "*.md", false, true, expect.any(String));
    expect(controller.current.results[0]).toMatchObject({ name: "match.md", relativePath: "nested/match.md" });
  });

  it("cancels superseded requests and never publishes stale results", async () => {
    const first = deferred<ExplorerSearchResults>();
    const second = deferred<ExplorerSearchResults>();
    vi.mocked(explorerSearchEntries).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result: controller } = renderHook(() => useExplorerSearch("/root", true, 0));
    act(() => controller.current.setQuery("*.md"));
    await waitFor(() => expect(explorerSearchEntries).toHaveBeenCalledTimes(1));
    act(() => controller.current.setQuery("*.ts"));
    await waitFor(() => expect(explorerSearchEntries).toHaveBeenCalledTimes(2));
    expect(explorerCancelOperation).toHaveBeenCalled();
    await act(async () => { second.resolve(result("/root/new.ts")); await second.promise; });
    await act(async () => { first.resolve(result("/root/old.md")); await first.promise; });
    expect(controller.current.results[0].path).toBe("/root/new.ts");
    expect(controller.current.searching).toBe(false);
  });

  it("cancels a slow search and publishes its explicit partial/cancelled state", async () => {
    const pending = deferred<ExplorerSearchResults>();
    vi.mocked(explorerSearchEntries).mockReturnValue(pending.promise);
    const { result: controller } = renderHook(() => useExplorerSearch("/root", true, 0));
    act(() => controller.current.setQuery("**/*.md"));
    await waitFor(() => expect(explorerSearchEntries).toHaveBeenCalledTimes(1));
    act(() => controller.current.cancel());
    expect(controller.current.cancelling).toBe(true);
    await act(async () => { pending.resolve(result("/root/partial.md", { cancelled: true, scanned: 40 })); await pending.promise; });
    expect(controller.current.cancelled).toBe(true);
    expect(controller.current.scanned).toBe(40);
    expect(controller.current.searching).toBe(false);
  });

  it("surfaces invalid patterns and retries without leaving a stale error", async () => {
    vi.mocked(explorerSearchEntries).mockRejectedValueOnce(new Error("invalid_query: Unclosed character class"))
      .mockResolvedValueOnce(result("/root/match.md"));
    const { result: controller } = renderHook(() => useExplorerSearch("/root", true, 0));
    act(() => controller.current.setQuery("["));
    await waitFor(() => expect(controller.current.error).toContain("invalid_query"));
    act(() => controller.current.retry());
    await waitFor(() => expect(controller.current.results).toHaveLength(1));
    expect(controller.current.error).toBeNull();
  });
});
