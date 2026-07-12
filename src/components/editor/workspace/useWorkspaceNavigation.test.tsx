import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCodeWorkspaceStore } from "../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceFileRef, CodeWorkspaceRootInfo } from "../../../types";
import type { OpenFileState } from "./codeWorkspaceModel";
import { useWorkspaceNavigation } from "./useWorkspaceNavigation";

const roots: CodeWorkspaceRootInfo[] = [{
  id: "root-1",
  name: "repo",
  path: "/repo",
  kind: "folder",
}];

function openState(ref: CodeWorkspaceFileRef): OpenFileState {
  const path = ref.path;
  return {
    key: ref.kind === "root" ? `root:${ref.rootId}:${path}` : `loose:${ref.id}`,
    ref,
    path,
    title: path.split("/").pop() ?? path,
    subtitle: `repo / ${path}`,
    languagePath: path,
    text: "",
    savedText: "",
    hash: "hash",
    mtime: 1,
    size: 0,
    loading: false,
    saving: false,
    dirty: false,
    error: null,
  };
}

describe("useWorkspaceNavigation", () => {
  beforeEach(() => {
    useCodeWorkspaceStore.setState({ byInstanceId: {} });
    useCodeWorkspaceStore.getState().ensureInstance("workspace-1");
  });

  it("builds file navigation items and opens search after warming every root", () => {
    const loadFlatFiles = vi.fn(async () => {});
    const setMode = vi.fn();
    const setOpen = vi.fn();
    const { result } = renderHook(() => useWorkspaceNavigation({
      workspaceInstanceId: "workspace-1",
      activeKey: null,
      roots,
      flatFiles: {
        "root-1": {
          entries: [
            { name: "main.ts", path: "src/main.ts", fileType: "file", size: 1, mtime: 1, isHidden: false },
            { name: ".git", path: ".git", fileType: "dir", size: 0, mtime: 1, isHidden: true },
          ],
          loaded: true,
          loading: false,
          error: null,
          truncated: true,
        },
      },
      visible: true,
      rootsRef: { current: roots },
      looseFilesRef: { current: [] },
      openFilesRef: { current: {} },
      loadFlatFiles,
      openFile: vi.fn(async () => {}),
      setSearchEverywhereMode: setMode,
      setSearchEverywhereOpen: setOpen,
      setRecentEntries: vi.fn(),
      setRecentFilesOpen: vi.fn(),
    }));

    expect(result.current.goToFileItems).toEqual([{
      rootId: "root-1",
      rootName: "repo",
      path: "src/main.ts",
    }]);
    expect(result.current.goToFileTruncated).toBe(true);
    act(() => result.current.openSearchEverywhere("symbols"));
    expect(loadFlatFiles).toHaveBeenCalledWith("root-1");
    expect(setMode).toHaveBeenCalledWith("symbols");
    expect(setOpen).toHaveBeenCalledWith(true);
  });

  it("owns recent files and back-forward navigation history", async () => {
    const first: CodeWorkspaceFileRef = { kind: "root", rootId: "root-1", path: "src/first.ts" };
    const second: CodeWorkspaceFileRef = { kind: "root", rootId: "root-1", path: "src/second.ts" };
    const openFilesRef = { current: {
      "root:root-1:src/first.ts": openState(first),
      "root:root-1:src/second.ts": openState(second),
    } };
    const openFile = vi.fn(async () => {});
    const setRecentEntries = vi.fn();
    const setRecentFilesOpen = vi.fn();
    const props = {
      workspaceInstanceId: "workspace-1",
      roots,
      flatFiles: {},
      visible: false,
      rootsRef: { current: roots },
      looseFilesRef: { current: [] },
      openFilesRef,
      loadFlatFiles: vi.fn(async () => {}),
      openFile,
      setSearchEverywhereMode: vi.fn(),
      setSearchEverywhereOpen: vi.fn(),
      setRecentEntries,
      setRecentFilesOpen,
    };
    const { result, rerender } = renderHook(
      ({ activeKey }) => useWorkspaceNavigation({ ...props, activeKey }),
      { initialProps: { activeKey: "root:root-1:src/first.ts" as string | null } },
    );
    rerender({ activeKey: "root:root-1:src/second.ts" });
    await waitFor(() => expect(result.current.navCan.back).toBe(true));

    act(() => result.current.navigateHistory(-1));
    expect(openFile).toHaveBeenCalledWith(first);
    expect(result.current.navCan.forward).toBe(true);

    act(() => result.current.openRecentFiles());
    expect(setRecentEntries).toHaveBeenCalledWith([
      expect.objectContaining({ ref: second, open: true }),
      expect.objectContaining({ ref: first, open: true }),
    ]);
    expect(setRecentFilesOpen).toHaveBeenCalledWith(true);
  });

  it("opens Go to File results in preview or the opposite split", () => {
    const openFile = vi.fn(async () => {});
    const setSearchEverywhereOpen = vi.fn();
    const { result } = renderHook(() => useWorkspaceNavigation({
      workspaceInstanceId: "workspace-1",
      activeKey: null,
      roots,
      flatFiles: {},
      visible: false,
      rootsRef: { current: roots },
      looseFilesRef: { current: [] },
      openFilesRef: { current: {} },
      loadFlatFiles: vi.fn(async () => {}),
      openFile,
      setSearchEverywhereMode: vi.fn(),
      setSearchEverywhereOpen,
      setRecentEntries: vi.fn(),
      setRecentFilesOpen: vi.fn(),
    }));
    const item = { rootId: "root-1", rootName: "repo", path: "src/main.ts" };

    act(() => result.current.openGoToFileItem(item));
    expect(openFile).toHaveBeenLastCalledWith(
      { kind: "root", rootId: "root-1", path: "src/main.ts" },
      { preview: true },
    );

    act(() => result.current.openGoToFileItem(item, { split: true }));
    expect(openFile).toHaveBeenLastCalledWith(
      { kind: "root", rootId: "root-1", path: "src/main.ts" },
      { groupId: "secondary" },
    );
    expect(useCodeWorkspaceStore.getState().getInstance("workspace-1").splitOrientation).toBe("vertical");
    expect(setSearchEverywhereOpen).toHaveBeenCalledWith(false);
  });
});
