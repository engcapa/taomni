import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeWorkspaceRootInfo } from "../../../types";
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

describe("useWorkspaceTreeData", () => {
  beforeEach(() => {
    workspaceMocks.workspaceListDir.mockReset().mockResolvedValue([]);
    workspaceMocks.workspaceCompactChain.mockReset().mockResolvedValue({ path: "", entries: [] });
    workspaceMocks.workspaceListFilesRecursive.mockReset().mockResolvedValue([]);
  });

  it("loads expanded roots and recursive flat indexes", async () => {
    const onError = vi.fn();
    const { result, rerender } = renderHook(
      ({ mode }: { mode: "tree" | "flat" }) => useWorkspaceTreeData({
        roots,
        expandedRootIds: expandedRoots,
        treeViewMode: mode,
        onError,
      }),
      { initialProps: { mode: "tree" } as { mode: "tree" | "flat" } },
    );

    await waitFor(() => expect(result.current.directories["root-1:"]?.loaded).toBe(true));
    expect(workspaceMocks.workspaceListDir).toHaveBeenCalledWith("/repo", "");

    rerender({ mode: "flat" });
    await waitFor(() => expect(result.current.flatFiles[root.id]?.loaded).toBe(true));
    expect(workspaceMocks.workspaceListFilesRecursive).toHaveBeenCalledWith("/repo", "", 25, 2_000);
  });

  it("discards in-flight results after reset and removes one root cache", async () => {
    let resolveListing!: (entries: unknown[]) => void;
    workspaceMocks.workspaceListDir.mockImplementation(() => new Promise<unknown[]>((resolve) => {
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
    resolveListing([]);
    await act(async () => pending);
    expect(result.current.directories).toEqual({});

    workspaceMocks.workspaceListDir.mockResolvedValue([]);
    await act(async () => result.current.loadDir(root.id, "src"));
    expect(result.current.directories["root-1:src"]?.loaded).toBe(true);
    act(() => result.current.removeRoot(root.id));
    expect(result.current.directories).toEqual({});
  });
});
