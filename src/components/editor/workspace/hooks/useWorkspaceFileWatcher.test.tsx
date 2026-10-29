import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeLoadingFile } from "../codeWorkspaceModel";
import { useWorkspaceFileWatcher } from "./useWorkspaceFileWatcher";

const ipc = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock("../../../../lib/editor/lsp", () => ({ lspStartWorkspaceWatcher: ipc.start, lspStopWorkspaceWatcher: ipc.stop }));
vi.mock("../../../../lib/runtime", async (original) => ({ ...await original<typeof import("../../../../lib/runtime")>(), isTauriRuntime: () => true }));
const root = { id: "home", name: "home", path: "/users/qa", kind: "folder" as const };
const file = { ...makeLoadingFile({ kind: "root", rootId: root.id, path: "Documents/notes.txt" }, [root], []), loading: false };
const status = vi.fn();
beforeEach(() => { ipc.start.mockReset().mockResolvedValue(undefined); ipc.stop.mockReset().mockResolvedValue(undefined); status.mockClear(); });
afterEach(cleanup);

it("watches expanded directories and open files without restarting on text, caret or equal root publication", () => {
  const { rerender, unmount } = renderHook(({ text, expanded, files }) => useWorkspaceFileWatcher({
    roots: [{ ...root }], looseFiles: [], workspaceInstanceId: "home-workspace", setStatusMessage: status,
    workspaceUi: { expandedDirKeys: expanded, openFiles: files ? { [file.key]: { ...file, text } } : {} },
  }), { initialProps: { text: "first", expanded: ["home:Documents"], files: true } });
  expect(ipc.start).toHaveBeenLastCalledWith("home-workspace", [root.path, "/users/qa/Documents/notes.txt"], ["/users/qa/Documents"]);
  rerender({ text: "edited", expanded: ["home:Documents"], files: true });
  expect(ipc.start).toHaveBeenCalledTimes(1);
  expect(ipc.stop).not.toHaveBeenCalled();
  rerender({ text: "edited", expanded: ["home:Documents", "home:Pictures"], files: true });
  expect(ipc.start).toHaveBeenCalledTimes(2);
  expect(ipc.start.mock.lastCall?.[2]).toEqual(["/users/qa/Documents", "/users/qa/Pictures"]);
  rerender({ text: "", expanded: ["home:Pictures"], files: false });
  expect(ipc.start).toHaveBeenLastCalledWith("home-workspace", [root.path], ["/users/qa/Pictures"]);
  unmount();
  expect(ipc.stop).toHaveBeenCalledTimes(3);
});

it("surfaces current initialization failures and ignores a disposed registration's late failure", async () => {
  let reject!: (error: Error) => void;
  ipc.start.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const props = { roots: [root], looseFiles: [], workspaceUi: { openFiles: {}, expandedDirKeys: [] }, setStatusMessage: status };
  const { rerender } = renderHook(({ id }) => useWorkspaceFileWatcher({ ...props, workspaceInstanceId: id }), { initialProps: { id: "old" } });
  rerender({ id: "current" });
  await act(async () => reject(new Error("old registration failed")));
  expect(status).not.toHaveBeenCalled();
  ipc.start.mockRejectedValueOnce(new Error("permission denied"));
  rerender({ id: "latest" });
  await act(async () => {});
  expect(status).toHaveBeenCalledWith("File watcher unavailable: permission denied");
});
