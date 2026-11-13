import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useExplorerOperations } from "./useExplorerOperations";
import { getExplorerClipboard, setExplorerClipboard } from "./explorerClipboard";
import { useSftpStore } from "../../stores/sftpStore";
import { freshSession, emptyPane } from "../../stores/sftp/listing";
import { readFilesResult } from "../../lib/clipboard";
import { notifyClipboardWritten } from "../../lib/clipboardOwnership";
import { explorerCancelOperation, explorerWriteClipboardFiles, explorerUpdateCutClipboard, explorerSameVolume, localCopyEntries, localMoveEntries, localTrashEntries, localTrashRestore, localRenameEntry } from "../../lib/explorer";
import { sftpRemove, type FileEntry } from "../../lib/sftp";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../../lib/explorer", () => ({
  explorerCancelOperation: vi.fn(async () => {}), explorerSameVolume: vi.fn(async () => true),
  explorerWriteClipboardFiles: vi.fn(async () => {}), explorerUpdateCutClipboard: vi.fn(async () => true), localCopyEntries: vi.fn(), localMoveEntries: vi.fn(),
  localTrashEntries: vi.fn(), localTrashRestore: vi.fn(), localRenameEntry: vi.fn(), localCreateEntry: vi.fn(),
}));
vi.mock("../../lib/clipboard", () => ({ readFilesResult: vi.fn(), writeText: vi.fn(async () => {}) }));
vi.mock("../../lib/sftp", () => ({
  effectiveFileType: (entry: FileEntry) => entry.fileType, sftpRemove: vi.fn(), sftpOpenPath: vi.fn(),
  sftpListLocalDetailed: vi.fn(async () => ({ entries: [], skippedCount: 0, diagnostics: [] })),
  sftpLocalHome: vi.fn(), sftpAttach: vi.fn(), sftpDetach: vi.fn(), sftpRealpath: vi.fn(),
}));
const entry = (name: string): FileEntry => ({ name, path: `/source/${name}`, fileType: "file", size: 7, mtime: 1, mode: 0, isHidden: false });
const alpha = entry("alpha.txt");
const beta = entry("beta.txt");
beforeEach(() => {
  vi.clearAllMocks(); setExplorerClipboard(null);
  useSftpStore.setState({ sessions: { tab: { ...freshSession("tab"), attached: true, local: { ...emptyPane(), path: "/target", entries: [alpha, beta] } } } });
  vi.mocked(localCopyEntries).mockResolvedValue({ done: [{ from: alpha.path, to: "/target/alpha.txt" }], failed: [] });
  vi.mocked(localMoveEntries).mockResolvedValue({ done: [{ from: alpha.path, to: "/target/alpha.txt" }], failed: [] });
  vi.mocked(readFilesResult).mockResolvedValue({ ok: true, paths: [alpha.path] });
  vi.mocked(explorerSameVolume).mockResolvedValue(true);
});
afterEach(cleanup);
async function idle(result: { current: ReturnType<typeof useExplorerOperations> }) {
  await waitFor(() => expect(result.current.busy).toBe(false));
}
describe("Explorer operation clipboard ownership", () => {
  it("writes the real file-list format and only exposes cut state after success", async () => {
    const { result } = renderHook(() => useExplorerOperations("tab"));
    await act(async () => { await result.current.copy([alpha, beta], true); });
    expect(explorerWriteClipboardFiles).toHaveBeenCalledWith([alpha.path, beta.path], true);
    expect(getExplorerClipboard()).toEqual({ paths: [alpha.path, beta.path], cut: true });
    vi.mocked(explorerWriteClipboardFiles).mockRejectedValueOnce(new Error("clipboard unavailable"));
    await act(async () => { await result.current.copy([beta], true); });
    expect(getExplorerClipboard()?.paths).toEqual([alpha.path, beta.path]);
    expect(result.current.toast).toMatchObject({ error: true, message: "Error: clipboard unavailable" });
  });
  it("a Copy in another app surface cancels an earlier cut even for the same file list", async () => {
    const { result } = renderHook(() => useExplorerOperations("tab"));
    await act(async () => { await result.current.copy([alpha], true); });
    act(() => notifyClipboardWritten());
    await act(async () => { await result.current.paste(); });
    expect(localCopyEntries).toHaveBeenCalled();
    expect(localMoveEntries).not.toHaveBeenCalled();
  });
  it("system clipboard is authoritative and external files never inherit app-local cut", async () => {
    setExplorerClipboard({ paths: [beta.path], cut: true });
    const { result } = renderHook(() => useExplorerOperations("tab"));
    await act(async () => { await result.current.paste(); });
    await idle(result);
    expect(localCopyEntries).toHaveBeenCalledWith([alpha.path], "/target", expect.any(String));
    expect(localMoveEntries).not.toHaveBeenCalled();
    expect(getExplorerClipboard()).toBeNull();
  });
  it("clipboard-read failure does not replay cached files", async () => {
    setExplorerClipboard({ paths: [alpha.path], cut: true });
    vi.mocked(readFilesResult).mockResolvedValue({ ok: false, message: "owner conversion failed" });
    const { result } = renderHook(() => useExplorerOperations("tab"));
    await act(async () => { await result.current.paste(); });
    expect(localCopyEntries).not.toHaveBeenCalled(); expect(localMoveEntries).not.toHaveBeenCalled();
    expect(result.current.toast?.message).toContain("owner conversion failed");
  });
  it("partial cut leaves failed sources retryable, reports every reason and never repeats successes", async () => {
    setExplorerClipboard({ paths: [alpha.path, beta.path], cut: true });
    vi.mocked(readFilesResult).mockResolvedValue({ ok: true, paths: [alpha.path, beta.path] });
    vi.mocked(localMoveEntries).mockResolvedValue({ done: [{ from: alpha.path, to: "/target/alpha.txt" }], failed: [{ path: beta.path, code: "denied", message: "Permission denied" }] });
    const { result } = renderHook(() => useExplorerOperations("tab"));
    await act(async () => { await result.current.paste(); });
    expect(explorerUpdateCutClipboard).toHaveBeenCalledWith([alpha.path, beta.path], [beta.path]);
    expect(getExplorerClipboard()).toEqual({ paths: [beta.path], cut: true });
    expect(result.current.toast).toMatchObject({ error: true });
    expect(result.current.toast?.message).toContain("Permission denied");
  });
  it("does not overwrite an external clipboard replacement during a cut", async () => {
    setExplorerClipboard({ paths: [alpha.path], cut: true });
    vi.mocked(explorerUpdateCutClipboard).mockResolvedValueOnce(false);
    const { result } = renderHook(() => useExplorerOperations("tab"));
    await act(async () => { await result.current.paste(); });
    expect(explorerUpdateCutClipboard).toHaveBeenCalledWith([alpha.path], []);
    expect(getExplorerClipboard()).toBeNull();
  });
});
describe("Explorer recoverable deletion and drop semantics", () => {
  it("retains Undo for successfully trashed items while failed ones require explicit permanent confirmation", async () => {
    vi.mocked(localTrashEntries).mockResolvedValue({ trashed: [{ id: "opaque", originalPath: alpha.path }], failed: [{ path: beta.path, code: "trash_unavailable", message: "No trash on volume" }] });
    vi.mocked(localTrashRestore).mockResolvedValue({ done: [{ from: "opaque", to: alpha.path }], failed: [] });
    const { result } = renderHook(() => useExplorerOperations("tab"));
    act(() => result.current.remove([alpha, beta]));
    await waitFor(() => expect(result.current.toast?.undo).toBeTypeOf("function"));
    expect(result.current.deletePrompt).toMatchObject({ entries: [beta], reason: expect.stringContaining("No trash on volume") });
    expect(sftpRemove).not.toHaveBeenCalled();
    await idle(result);
    act(() => result.current.toast?.undo?.());
    await waitFor(() => expect(localTrashRestore).toHaveBeenCalledWith([{ id: "opaque", originalPath: alpha.path }]));
  });
  it("ShiftDelete never touches disk before confirmation, then reports partial failures", async () => {
    const { result } = renderHook(() => useExplorerOperations("tab"));
    act(() => result.current.remove([alpha, beta], true));
    expect(sftpRemove).not.toHaveBeenCalled();
    vi.mocked(sftpRemove).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("deleted source"));
    await act(async () => { await result.current.permanentDelete([alpha, beta]); });
    expect(sftpRemove).toHaveBeenCalledTimes(2);
    expect(result.current.toast?.message).toContain("deleted source");
  });
  it("cross-volume drops copy while same-volume drops move, and Ctrl/Option overrides force copy", async () => {
    const { result } = renderHook(() => useExplorerOperations("tab"));
    vi.mocked(explorerSameVolume).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await act(async () => { await result.current.drop([alpha.path, beta.path], "/target", false); });
    expect(localCopyEntries).toHaveBeenCalledWith([alpha.path], "/target", expect.any(String));
    expect(localMoveEntries).toHaveBeenCalledWith([beta.path], "/target", expect.any(String));
    vi.mocked(localCopyEntries).mockClear(); vi.mocked(localMoveEntries).mockClear();
    await act(async () => { await result.current.drop([alpha.path], "/target", true); });
    expect(localCopyEntries).toHaveBeenCalledTimes(1); expect(localMoveEntries).not.toHaveBeenCalled();
  });
  it("cancelling a multi-source drop stops the remaining commands and preserves completed results", async () => {
    let resolve!: (value: { done: { from: string; to: string }[]; failed: never[] }) => void;
    vi.mocked(localMoveEntries).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const { result } = renderHook(() => useExplorerOperations("tab"));
    act(() => { void result.current.drop([alpha.path, beta.path], "/target", false); });
    await waitFor(() => expect(localMoveEntries).toHaveBeenCalledTimes(1));
    act(() => result.current.cancel());
    await act(async () => { resolve({ done: [{ from: alpha.path, to: "/target/alpha.txt" }], failed: [] }); });
    await idle(result);
    expect(explorerCancelOperation).toHaveBeenCalled();
    expect(localMoveEntries).toHaveBeenCalledTimes(1);
    expect(result.current.toast?.message).toContain("Cancelled");
  });
  it("failed inline rename keeps editing and selection, successful rename selects the backend returned spelling", async () => {
    const { result } = renderHook(() => useExplorerOperations("tab"));
    act(() => result.current.setRenamePath(alpha.path));
    vi.mocked(localRenameEntry).mockRejectedValueOnce(new Error("already exists"));
    let success = true;
    await act(async () => { success = await result.current.rename(alpha, "beta.txt"); });
    expect(success).toBe(false); expect(result.current.renamePath).toBe(alpha.path);
    vi.mocked(localRenameEntry).mockResolvedValueOnce("/target/renamed.txt");
    await act(async () => { success = await result.current.rename(alpha, "renamed.txt"); });
    expect(success).toBe(true); expect(result.current.renamePath).toBeNull();
    expect(useSftpStore.getState().sessions.tab.local.selection).toEqual(["/target/renamed.txt"]);
  });
});
