import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeWorkspaceRootInfo } from "../../../types";
import { useWorkspaceTreeClipboard } from "./useWorkspaceTreeClipboard";
import { notifyClipboardWritten } from "../../../lib/clipboardOwnership";

const clipboard = vi.hoisted(() => ({ readFilesResult: vi.fn(), writeFiles: vi.fn() }));
const lsp = vi.hoisted(() => ({ lspWorkspaceWillFileOperation: vi.fn(), lspWorkspaceDidFileOperation: vi.fn() }));
vi.mock("../../../lib/clipboard", () => clipboard);
vi.mock("../../../lib/editor/lsp", () => lsp);
function setup() {
  return { workspaceId: "workspace", rootsRef: { current: [
    { id: "one", name: "one", path: "/one", kind: "folder" }, { id: "two", name: "two", path: "/two", kind: "folder" },
  ] as CodeWorkspaceRootInfo[] }, importPaths: vi.fn(async () => {}), applyResourceOperation: vi.fn(async () => {}),
  loadDir: vi.fn(async () => {}), loadFlatFiles: vi.fn(async () => {}), onStatus: vi.fn() };
}
beforeEach(() => {
  clipboard.readFilesResult.mockReset().mockResolvedValue({ ok: true, paths: ["/external/b.bin", "/external/bundle"] });
  clipboard.writeFiles.mockReset().mockResolvedValue(undefined);
  lsp.lspWorkspaceWillFileOperation.mockReset().mockResolvedValue(undefined);
  lsp.lspWorkspaceDidFileOperation.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("workspace system file clipboard", () => {
  it("publishes file/dir references and reads the latest external clipboard instead of private copied paths", async () => {
    const options = setup();
    const { result } = renderHook(() => useWorkspaceTreeClipboard(options));
    await act(async () => result.current.stageTreeClipboard("copy", "one", "binary.bin"));
    expect(clipboard.writeFiles).toHaveBeenCalledWith(["/one/binary.bin"]);
    await act(async () => result.current.pasteTreeClipboard({ rootId: "two", path: "target" }));
    expect(options.importPaths).toHaveBeenCalledWith({ rootId: "two", path: "target" }, ["/external/b.bin", "/external/bundle"]);
    expect(options.applyResourceOperation).not.toHaveBeenCalled();
  });

  it("allows Paste before any internal Copy, reports empty/failed reads and permits retry", async () => {
    const options = setup();
    const { result } = renderHook(() => useWorkspaceTreeClipboard(options));
    expect(result.current.canPasteTreeClipboard()).toBe(true);
    clipboard.readFilesResult.mockResolvedValueOnce({ ok: true, paths: [] }).mockResolvedValueOnce({ ok: false, message: "permission denied" });
    await act(async () => result.current.pasteTreeClipboard({ rootId: "two", path: "" }));
    expect(options.onStatus).toHaveBeenLastCalledWith("No files on the system clipboard");
    await act(async () => result.current.pasteTreeClipboard({ rootId: "two", path: "" }));
    expect(options.onStatus).toHaveBeenLastCalledWith("Paste failed: permission denied");
    expect(options.importPaths).not.toHaveBeenCalled();
    await act(async () => result.current.pasteTreeClipboard({ rootId: "two", path: "" }));
    expect(options.importPaths).toHaveBeenCalledTimes(1);
  });

  it("does not publish successful Copy feedback after native file-list write failure", async () => {
    const options = setup();
    clipboard.writeFiles.mockRejectedValueOnce("native unavailable");
    const { result } = renderHook(() => useWorkspaceTreeClipboard(options));
    await act(async () => result.current.stageTreeClipboard("copy", "one", "note.txt"));
    expect(options.onStatus).toHaveBeenCalledExactlyOnceWith("Copy failed: native unavailable");
    await act(async () => result.current.stageTreeClipboard("copy", "one", "folder", true));
    expect(options.onStatus).toHaveBeenLastCalledWith("Copied file reference: /one/folder");
  });

  it("retains same-root Cut rename lifecycle without publishing system move semantics", async () => {
    const options = setup();
    const { result } = renderHook(() => useWorkspaceTreeClipboard(options));
    await act(async () => result.current.stageTreeClipboard("cut", "one", "src/folder", true));
    await act(async () => result.current.pasteTreeClipboard({ rootId: "one", path: "dest" }));
    expect(options.applyResourceOperation).toHaveBeenCalledWith(expect.objectContaining({
      kind: "rename", oldPath: "/one/src/folder", newPath: "/one/dest/folder", overwrite: false,
    }));
    expect(lsp.lspWorkspaceDidFileOperation).toHaveBeenCalledWith("workspace", { kind: "rename", files: [{ oldPath: "/one/src/folder", newPath: "/one/dest/folder", isDirectory: true }] });
    expect(clipboard.writeFiles).not.toHaveBeenCalled();
    expect(clipboard.readFilesResult).not.toHaveBeenCalled();
    expect(options.loadFlatFiles).toHaveBeenCalledWith("one", true);
  });

  it("expires internal Cut after leaving the app or another text copy so external paste cannot move a stale source", async () => {
    const options = setup();
    const { result } = renderHook(() => useWorkspaceTreeClipboard(options));
    for (const event of ["blur", "copy"]) {
      await act(async () => result.current.stageTreeClipboard("cut", "one", "note.txt"));
      act(() => { window.dispatchEvent(new Event(event)); });
      await act(async () => result.current.pasteTreeClipboard({ rootId: "one", path: "dest" }));
    }
    expect(options.applyResourceOperation).not.toHaveBeenCalled();
    expect(options.importPaths).toHaveBeenCalledTimes(2);
  });

  it("invalidates a destructive Cut when Copy Path or another app helper writes text without a DOM copy event", async () => {
    const options = setup();
    const { result } = renderHook(() => useWorkspaceTreeClipboard(options));
    await act(async () => result.current.stageTreeClipboard("cut", "one", "source.bin"));
    act(() => notifyClipboardWritten());
    clipboard.readFilesResult.mockResolvedValueOnce({ ok: true, paths: [] });
    await act(async () => result.current.pasteTreeClipboard({ rootId: "one", path: "dest" }));
    expect(options.applyResourceOperation).not.toHaveBeenCalled();
    expect(options.importPaths).not.toHaveBeenCalled();
    expect(options.onStatus).toHaveBeenLastCalledWith("No files on the system clipboard");
  });

  it("deduplicates in-flight Paste and discards a late clipboard read after target removal", async () => {
    const options = setup();
    let finish!: (value: unknown) => void;
    clipboard.readFilesResult.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useWorkspaceTreeClipboard(options));
    let pending!: Promise<void>;
    act(() => { pending = result.current.pasteTreeClipboard({ rootId: "two", path: "dest" }); });
    await act(async () => result.current.pasteTreeClipboard({ rootId: "two", path: "dest" }));
    expect(clipboard.readFilesResult).toHaveBeenCalledTimes(1);
    options.rootsRef.current = [options.rootsRef.current[0]];
    await act(async () => { finish({ ok: true, paths: ["/external/note"] }); await pending; });
    expect(options.importPaths).not.toHaveBeenCalled();
  });

  it("serializes native Copy writes and prevents late completion feedback after unmount", async () => {
    const options = setup();
    let finish!: () => void;
    clipboard.writeFiles.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    const { result, unmount } = renderHook(() => useWorkspaceTreeClipboard(options));
    let one!: Promise<void>, two!: Promise<void>;
    act(() => {
      one = result.current.stageTreeClipboard("copy", "one", "first");
      two = result.current.stageTreeClipboard("copy", "one", "second");
    });
    await act(async () => {});
    expect(clipboard.writeFiles).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => { finish(); await Promise.all([one, two]); });
    expect(clipboard.writeFiles).toHaveBeenCalledTimes(1);
    expect(options.onStatus).not.toHaveBeenCalled();
  });
});
