import { StrictMode, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { useWorkspaceDropImport } from "./useWorkspaceDropImport";

const importPaths = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/editor/workspace/importing", () => ({ workspaceImportPaths: importPaths }));
const entry = { name: "note.txt", path: "dest/nested/note.txt", fileType: "file", size: 1, mtime: 1, isHidden: false };
function setup() {
  return {
    workspaceId: "workspace",
    rootsRef: { current: [
      { id: "one", path: "/one", name: "first", kind: "folder" },
      { id: "two", path: "/two", name: "second", kind: "folder" },
    ] as CodeWorkspaceRootInfo[] },
    setExpandedRoots: vi.fn(), setExpandedDirs: vi.fn(), loadDir: vi.fn(async () => {}), loadFlatFiles: vi.fn(async () => {}),
    refreshPath: vi.fn(), notifyGitChanged: vi.fn(), onStatus: vi.fn(),
  };
}
beforeEach(() => { importPaths.mockReset().mockResolvedValue({ imported: [entry], failures: [] }); });

describe("drop import ownership", () => {
  it("imports to the explicit second root, expands destination ancestors and refreshes without selecting/opening files", async () => {
    const options = setup();
    const { result } = renderHook(() => useWorkspaceDropImport(options));
    await act(async () => result.current({ rootId: "two", path: "dest/nested" }, ["/outside/note.txt"]));
    expect(importPaths).toHaveBeenCalledExactlyOnceWith("/two", "dest/nested", ["/outside/note.txt"]);
    expect(options.setExpandedRoots.mock.calls[0][0](new Set(["one"]))).toEqual(new Set(["one", "two"]));
    expect(options.setExpandedDirs.mock.calls[0][0](new Set())).toEqual(new Set(["two:dest", "two:dest/nested"]));
    expect(options.loadDir).toHaveBeenCalledExactlyOnceWith("two", "dest/nested");
    expect(options.loadFlatFiles).toHaveBeenCalledExactlyOnceWith("two", true);
    expect(options.refreshPath).toHaveBeenCalledExactlyOnceWith("/two/dest/nested/note.txt");
    expect(options.notifyGitChanged).toHaveBeenCalledExactlyOnceWith("two", "dest/nested/note.txt");
    expect(options.onStatus).toHaveBeenLastCalledWith("Imported 1 item(s) into second / dest/nested");
  });

  it("reports preflight failure, releases the duplicate guard and permits retry", async () => {
    const options = setup();
    importPaths.mockRejectedValueOnce("Path already exists: note.txt");
    const { result } = renderHook(() => useWorkspaceDropImport(options));
    const target = { rootId: "two", path: "dest" };
    await act(async () => result.current(target, ["/outside/note.txt"]));
    expect(options.onStatus).toHaveBeenLastCalledWith("Import failed: Path already exists: note.txt");
    expect(options.loadDir).not.toHaveBeenCalled();
    await act(async () => result.current(target, ["/outside/note.txt"]));
    expect(importPaths).toHaveBeenCalledTimes(2);
    expect(options.loadDir).toHaveBeenCalledTimes(1);
  });

  it("suppresses duplicate in-flight drops and reports mixed success without losing error details", async () => {
    const options = setup();
    let finish!: (value: unknown) => void;
    importPaths.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useWorkspaceDropImport(options));
    const target = { rootId: "two", path: "dest" };
    let pending!: Promise<void>;
    act(() => { pending = result.current(target, ["/outside/note.txt", "/outside/bad"]); });
    await act(async () => result.current(target, ["/outside/bad", "/outside/note.txt"]));
    expect(importPaths).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({ imported: [entry], failures: [{ sourcePath: "/outside/bad", message: "permission denied" }] });
      await pending;
    });
    expect(options.onStatus).toHaveBeenLastCalledWith("Imported 1 item(s) into second / dest; 1 failed: /outside/bad: permission denied");
    expect(options.notifyGitChanged).toHaveBeenCalledTimes(1);
  });

  it.each(["unmount", "root removal", "root replacement", "owner switch"])("does not publish late completion after %s", async (change) => {
    const options = setup();
    let finish!: (value: unknown) => void;
    importPaths.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const { result, rerender, unmount } = renderHook((deps) => useWorkspaceDropImport(deps), { initialProps: options });
    let pending!: Promise<void>;
    act(() => { pending = result.current({ rootId: "two", path: "dest" }, ["/outside/note.txt"]); });
    if (change === "unmount") unmount();
    else if (change === "root removal") options.rootsRef.current = [options.rootsRef.current[0]];
    else if (change === "root replacement") options.rootsRef.current = options.rootsRef.current.map((root) => root.id === "two" ? { ...root, path: "/replacement" } : root);
    else rerender({ ...options, workspaceId: "another" });
    await act(async () => { finish({ imported: [entry], failures: [] }); await pending; });
    expect(options.loadDir).not.toHaveBeenCalled();
    expect(options.setExpandedRoots).not.toHaveBeenCalled();
    expect(options.refreshPath).not.toHaveBeenCalled();
    expect(options.notifyGitChanged).not.toHaveBeenCalled();
    expect(options.onStatus).toHaveBeenCalledTimes(1);
  });

  it("works under StrictMode and ignores unknown roots and empty sources", async () => {
    const options = setup();
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => useWorkspaceDropImport(options), { wrapper });
    await act(async () => result.current({ rootId: "unknown", path: "" }, ["/outside/note.txt"]));
    await act(async () => result.current({ rootId: "two", path: "" }, []));
    expect(importPaths).not.toHaveBeenCalled();
    await act(async () => result.current({ rootId: "two", path: "" }, ["/outside/note.txt"]));
    expect(importPaths).toHaveBeenCalledTimes(1);
  });
});
