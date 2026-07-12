import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeWorkspaceRootInfo } from "../../../types";
import { useWorkspaceFileActions } from "./useWorkspaceFileActions";

const dialogMocks = vi.hoisted(() => ({
  confirmAppDialog: vi.fn(),
  promptAppDialog: vi.fn(),
}));
const workspaceMocks = vi.hoisted(() => ({
  workspaceCreateDir: vi.fn(),
  workspaceCreateFile: vi.fn(),
  workspaceDeletePath: vi.fn(),
  workspaceReadFile: vi.fn(),
  workspaceRenamePath: vi.fn(),
}));
const ipcMocks = vi.hoisted(() => ({
  selectFilePath: vi.fn(),
  selectFolderPath: vi.fn(),
}));

vi.mock("../../../lib/appDialogs", () => dialogMocks);
vi.mock("../../../lib/editor/workspace", () => workspaceMocks);
vi.mock("../../../lib/ipc", () => ipcMocks);
vi.mock("../../../lib/clipboard", () => ({ writeText: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const roots: CodeWorkspaceRootInfo[] = [{
  id: "root-1",
  name: "repo",
  path: "/repo",
  kind: "folder",
}];

function options(overrides: Record<string, unknown> = {}) {
  return {
    roots,
    selected: { kind: "dir" as const, rootId: "root-1", path: "src" },
    activeKey: null,
    openFiles: {},
    directories: {},
    expandedRoots: new Set<string>(),
    expandedDirs: new Set<string>(),
    treeViewMode: "tree" as const,
    rootsRef: { current: roots },
    looseFilesRef: { current: [] },
    openFilesRef: { current: {} },
    openOrderRef: { current: [] },
    setRoots: vi.fn(),
    setLooseFiles: vi.fn(),
    setSelected: vi.fn(),
    setExpandedRoots: vi.fn(),
    setExpandedDirs: vi.fn(),
    setOpenFiles: vi.fn(),
    setOpenOrder: vi.fn(),
    setActiveKey: vi.fn(),
    loadDir: vi.fn(async () => {}),
    loadFlatFiles: vi.fn(async () => {}),
    resetTreeData: vi.fn(),
    removeTreeDataRoot: vi.fn(),
    openFile: vi.fn(async () => {}),
    notifyWorkspacePathGitChanged: vi.fn(),
    onStatus: vi.fn(),
    ...overrides,
  };
}

describe("useWorkspaceFileActions", () => {
  beforeEach(() => {
    dialogMocks.confirmAppDialog.mockReset().mockResolvedValue(true);
    dialogMocks.promptAppDialog.mockReset();
    workspaceMocks.workspaceCreateDir.mockReset();
    workspaceMocks.workspaceCreateFile.mockReset();
    workspaceMocks.workspaceDeletePath.mockReset();
    workspaceMocks.workspaceReadFile.mockReset();
    workspaceMocks.workspaceRenamePath.mockReset();
    ipcMocks.selectFilePath.mockReset();
    ipcMocks.selectFolderPath.mockReset();
  });

  it("derives the selected directory and owns file creation", async () => {
    dialogMocks.promptAppDialog.mockResolvedValue("main.ts");
    workspaceMocks.workspaceCreateFile.mockResolvedValue({
      path: "src/main.ts",
      text: "",
      size: 0,
      mtime: 1,
      hash: "hash",
    });
    const props = options();
    const { result } = renderHook(() => useWorkspaceFileActions(props));

    expect(result.current.selectedRootDirectory).toEqual({ rootId: "root-1", path: "src" });
    await act(async () => result.current.createFile());

    expect(workspaceMocks.workspaceCreateFile).toHaveBeenCalledWith("/repo", "src/main.ts");
    expect(props.loadDir).toHaveBeenCalledWith("root-1", "src");
    expect(props.openFile).toHaveBeenCalledWith({
      kind: "root",
      rootId: "root-1",
      path: "src/main.ts",
    });
    expect(props.notifyWorkspacePathGitChanged).toHaveBeenCalledWith("root-1", "src/main.ts");
  });

  it("renames and deletes workspace paths through one mutation boundary", async () => {
    dialogMocks.promptAppDialog.mockResolvedValue("renamed.ts");
    workspaceMocks.workspaceRenamePath.mockResolvedValue({
      name: "renamed.ts",
      path: "src/renamed.ts",
      fileType: "file",
      size: 1,
      mtime: 1,
      isHidden: false,
    });
    const props = options();
    const { result } = renderHook(() => useWorkspaceFileActions(props));
    const selection = {
      kind: "file" as const,
      ref: { kind: "root" as const, rootId: "root-1", path: "src/original.ts" },
    };

    await act(async () => result.current.renameSelected(selection));
    expect(workspaceMocks.workspaceRenamePath).toHaveBeenCalledWith(
      "/repo",
      "src/original.ts",
      "src/renamed.ts",
    );
    expect(props.notifyWorkspacePathGitChanged).toHaveBeenCalledWith("root-1", "src/original.ts");
    expect(props.notifyWorkspacePathGitChanged).toHaveBeenCalledWith("root-1", "src/renamed.ts");

    await act(async () => result.current.deleteSelected(selection));
    expect(workspaceMocks.workspaceDeletePath).toHaveBeenCalledWith(
      "/repo",
      "src/original.ts",
      false,
    );
  });

  it("owns the internal tree clipboard and refreshes Git after paste", async () => {
    workspaceMocks.workspaceReadFile.mockResolvedValue({
      path: "src/source.ts",
      text: "source",
      size: 6,
      mtime: 1,
      hash: "hash",
    });
    workspaceMocks.workspaceCreateFile.mockResolvedValue({
      path: "dest/source.ts",
      text: "source",
      size: 6,
      mtime: 1,
      hash: "hash-2",
    });
    const props = options();
    const { result } = renderHook(() => useWorkspaceFileActions(props));

    act(() => result.current.stageTreeClipboard("copy", "root-1", "src/source.ts"));
    expect(result.current.canPasteTreeClipboard()).toBe(true);
    await act(async () => result.current.pasteTreeClipboard({ rootId: "root-1", path: "dest" }));

    expect(workspaceMocks.workspaceCreateFile).toHaveBeenCalledWith(
      "/repo",
      "dest/source.ts",
      "source",
    );
    expect(props.notifyWorkspacePathGitChanged).toHaveBeenCalledWith("root-1", "dest/source.ts");
  });
});
