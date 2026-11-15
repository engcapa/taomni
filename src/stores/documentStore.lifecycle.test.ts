import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDocumentStore } from "./documentStore";
import {
  viewerReadText, viewerReadTextChunk, viewerReleaseTemp, viewerStat, viewerWriteText,
  type ViewerTextData, type ViewerWriteAck,
} from "../lib/viewer";

vi.mock("../lib/viewer", async (original) => ({ ...await original<typeof import("../lib/viewer")>(),
  viewerStat: vi.fn(), viewerReadText: vi.fn(), viewerReadTextChunk: vi.fn(), viewerWriteText: vi.fn(), viewerReleaseTemp: vi.fn(),
}));
const path = "/lifecycle/note.txt";
const get = () => useDocumentStore.getState();
const current = () => get().documents[path];
const disk = (content = "original", hash = "old"): ViewerTextData => ({ path, content, hash,
  encoding: "UTF-8", bom: false, eol: "LF", mtime: 1, size: content.length, truncated: false });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function reopen() {
  get().release(path);
  localStorage.clear();
  vi.mocked(viewerReadText).mockResolvedValue(disk("new owner", "new-owner-hash"));
  await get().open(path);
}

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  useDocumentStore.setState({ documents: {}, closeRequest: undefined, draftError: undefined });
  vi.mocked(viewerStat).mockResolvedValue({ path, size: 8, mtime: 1, mime: "text/plain", isFile: true });
  vi.mocked(viewerReadText).mockResolvedValue(disk());
  vi.mocked(viewerWriteText).mockResolvedValue({ hash: "written", size: 6, mtime: 2 });
  vi.mocked(viewerReleaseTemp).mockResolvedValue(undefined);
});
afterEach(() => { if (current()) get().release(path); });

describe("shared document async owner generations", () => {
  it.each(["success", "failure"] as const)("does not publish an old reload %s into a reopened same-path document", async (outcome) => {
    await get().open(path);
    const read = deferred<ViewerTextData>();
    vi.mocked(viewerReadText).mockReturnValueOnce(read.promise);
    const task = get().reload(path);
    await reopen();
    const owner = current();
    if (outcome === "success") read.resolve(disk("stale reload", "stale"));
    else read.reject(new Error("old reload failed"));
    await task;
    expect(current()).toBe(owner);
    expect(current().content).toBe("new owner");
    expect(current().error).toBeUndefined();
  });

  it.each(["success", "failure"] as const)("does not publish an old external check %s into a reopened document", async (outcome) => {
    await get().open(path);
    const read = deferred<ViewerTextData>();
    vi.mocked(viewerReadText).mockReturnValueOnce(read.promise);
    const task = get().checkExternal(path);
    await reopen();
    const owner = current();
    if (outcome === "success") read.resolve(disk("old external", "stale"));
    else read.reject(new Error("old external failed"));
    await task;
    expect(current()).toBe(owner);
    expect(current().error).toBeUndefined();
  });

  it.each(["success", "failure"] as const)("does not publish an old save %s or suppress the new owner's save", async (outcome) => {
    await get().open(path); get().edit(path, "old owner edit");
    const write = deferred<ViewerWriteAck>();
    vi.mocked(viewerWriteText).mockReturnValueOnce(write.promise);
    const oldTask = get().save(path).catch((error: unknown) => error);
    await reopen();
    get().edit(path, "new owner edit");
    const newTask = get().save(path);
    expect(viewerWriteText).toHaveBeenCalledTimes(2);
    await newTask;
    const owner = current();
    if (outcome === "success") write.resolve({ hash: "stale-save", size: 14, mtime: 2 });
    else write.reject(new Error("conflict: old save failed"));
    await oldTask;
    expect(current()).toBe(owner);
    expect(current().savedContent).toBe("new owner edit");
    expect(current().savedHash).toBe("written");
    expect(current().error).toBeUndefined();
  });

  it("keeps new pending saves registered after an old released owner's save settles", async () => {
    await get().open(path); get().edit(path, "first");
    const oldWrite = deferred<ViewerWriteAck>();
    vi.mocked(viewerWriteText).mockReturnValueOnce(oldWrite.promise);
    const oldTask = get().save(path);
    await reopen(); get().edit(path, "second");
    const newWrite = deferred<ViewerWriteAck>();
    vi.mocked(viewerWriteText).mockReturnValueOnce(newWrite.promise);
    const newTask = get().save(path);
    oldWrite.resolve({ hash: "old-write", size: 5, mtime: 2 }); await oldTask;
    expect(get().save(path)).toBe(newTask);
    expect(viewerWriteText).toHaveBeenCalledTimes(2);
    newWrite.resolve({ hash: "new-write", size: 6, mtime: 3 }); await newTask;
    expect(current().savedHash).toBe("new-write");
  });

  it("starts a reopened owner's external check while the previous owner is still reading", async () => {
    await get().open(path);
    const oldRead = deferred<ViewerTextData>();
    vi.mocked(viewerReadText).mockReturnValueOnce(oldRead.promise);
    const oldTask = get().checkExternal(path);
    await reopen();
    const newRead = deferred<ViewerTextData>();
    vi.mocked(viewerReadText).mockReturnValueOnce(newRead.promise);
    const newTask = get().checkExternal(path);
    expect(viewerReadText).toHaveBeenCalledTimes(4);
    oldRead.resolve(disk("stale", "stale")); await oldTask;
    // The stale check's finally must not remove the newer check's pending marker.
    await get().checkExternal(path);
    expect(viewerReadText).toHaveBeenCalledTimes(4);
    newRead.resolve(disk("new external", "new-external")); await newTask;
    expect(current().content).toBe("new external");
  });

  it("preserves user edits made while an external read is pending", async () => {
    await get().open(path);
    const read = deferred<ViewerTextData>();
    vi.mocked(viewerReadText).mockReturnValueOnce(read.promise);
    const task = get().checkExternal(path);
    get().edit(path, "typed while reading");
    read.resolve(disk("external", "changed")); await task;
    expect(current().content).toBe("typed while reading");
    expect(current().dirty).toBe(true);
    expect(current().external?.content).toBe("external");
  });

  it("does not let a pre-save external read revert a successful save", async () => {
    await get().open(path);
    const read = deferred<ViewerTextData>();
    vi.mocked(viewerReadText).mockReturnValueOnce(read.promise);
    const task = get().checkExternal(path);
    get().edit(path, "saved edit"); await get().save(path);
    read.resolve(disk("original", "old")); await task;
    expect(current().content).toBe("saved edit");
    expect(current().savedHash).toBe("written");
  });

  it("latest explicit reload wins without old failures clearing the new loading state", async () => {
    await get().open(path);
    const oldRead = deferred<ViewerTextData>();
    const newRead = deferred<ViewerTextData>();
    vi.mocked(viewerReadText).mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    const oldTask = get().reload(path);
    const newTask = get().reload(path);
    oldRead.reject(new Error("stale failure")); await oldTask;
    expect(current().loading).toBe(true);
    expect(current().error).toBeUndefined();
    newRead.resolve(disk("latest", "latest-hash")); await newTask;
    expect(current().content).toBe("latest");
  });

  it("ignores a chunk failure from an earlier owner", async () => {
    vi.mocked(viewerStat).mockResolvedValueOnce({ path, size: 6 * 1024 * 1024, mtime: 1, mime: "text/plain", isFile: true });
    vi.mocked(viewerReadText).mockResolvedValueOnce({ ...disk("prefix", ""), truncated: true });
    await get().open(path);
    const chunk = deferred<{ content: string; nextOffset: number; eof: boolean }>();
    vi.mocked(viewerReadTextChunk).mockReturnValueOnce(chunk.promise);
    const task = get().readChunk(path, 262144);
    await reopen(); const owner = current();
    chunk.reject(new Error("old chunk failed")); await task;
    expect(current()).toBe(owner);
    expect(current().error).toBeUndefined();
  });
});
