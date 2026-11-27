import { beforeEach, describe, expect, it, vi } from "vitest";
import { guardViewerClose, confirmViewerExit, saveViewerChanges, trackModuleDocumentDraft, viewerHasChanges } from "./closeGuard";
import { useDocumentStore } from "../../stores/documentStore";
import { viewerReadText, viewerStat } from "../viewer";
vi.mock("../viewer", async (original) => ({ ...await original<typeof import("../viewer")>(), viewerStat: vi.fn(), viewerReadText: vi.fn() }));
const path = "/test.txt";
beforeEach(() => {
  localStorage.clear(); useDocumentStore.setState({ documents: {}, moduleDrafts: {}, closeRequest: undefined });
  vi.mocked(viewerStat).mockResolvedValue({ path, size: 3, mtime: 1, mime: "text/plain", isFile: true });
  vi.mocked(viewerReadText).mockResolvedValue({ path, content: "old", hash: "hash", encoding: "UTF-8", bom: false, eol: "LF", mtime: 1, size: 3, truncated: false });
});
describe("viewer closing and application exit", () => {
  it("defers mutation until save/discard and preserves cancel", async () => {
    await useDocumentStore.getState().open(path); useDocumentStore.getState().edit(path, "mine");
    const proceed = vi.fn(), cancel = vi.fn();
    guardViewerClose([path], proceed, cancel);
    expect(proceed).not.toHaveBeenCalled();
    const request = useDocumentStore.getState().closeRequest!;
    expect(request.paths).toEqual([path]); request.cancel?.();
    expect(cancel).toHaveBeenCalledOnce(); expect(useDocumentStore.getState().documents[path].dirty).toBe(true);
    useDocumentStore.setState({ closeRequest: undefined });
    useDocumentStore.getState().discard(path); guardViewerClose([path], proceed);
    expect(proceed).toHaveBeenCalledOnce();
  });
  it("cancels an exit when another close prompt already owns the document", async () => {
    await useDocumentStore.getState().open(path); useDocumentStore.getState().edit(path, "mine");
    guardViewerClose([path], vi.fn());
    await expect(confirmViewerExit()).resolves.toBe(false);
  });

  it("guards a module draft and preserves it when Save a copy is cancelled", async () => {
    const path = "/document.pdf";
    const save = vi.fn().mockResolvedValue(false);
    const release = trackModuleDocumentDraft({ path, save, discard: vi.fn() });
    const proceed = vi.fn();
    guardViewerClose([path], proceed);
    expect(proceed).not.toHaveBeenCalled();
    expect(useDocumentStore.getState().closeRequest?.paths).toEqual([path]);
    await expect(saveViewerChanges(path)).resolves.toBe(false);
    expect(save).toHaveBeenCalledOnce();
    expect(viewerHasChanges(path)).toBe(true);
    release();
    expect(viewerHasChanges(path)).toBe(false);
  });
});
