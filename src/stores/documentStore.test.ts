import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDocumentStore } from "./documentStore";
import { VIEWER_DRAFTS_KEY } from "./viewerDrafts";
import { viewerReadText, viewerReleaseTemp, viewerStat, viewerWriteText, type ViewerTextData, type ViewerWriteAck } from "../lib/viewer";
vi.mock("../lib/viewer", async (original) => ({ ...await original<typeof import("../lib/viewer")>(), viewerStat: vi.fn(), viewerReadText: vi.fn(), viewerReadTextChunk: vi.fn(), viewerWriteText: vi.fn(), viewerReleaseTemp: vi.fn() }));
const disk = (content = "original", hash = "old"): ViewerTextData => ({ path: "/docs/note.txt", content, hash, encoding: "UTF-8", bom: false, eol: "LF", mtime: 1, size: content.length, truncated: false });
const path = "/docs/note.txt";
const get = () => useDocumentStore.getState();
const document = () => get().documents[path];
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  useDocumentStore.setState({ documents: {}, closeRequest: undefined, draftError: undefined });
  vi.mocked(viewerStat).mockResolvedValue({ path, size: 8, mtime: 1, mime: "text/plain", isFile: true });
  vi.mocked(viewerReadText).mockResolvedValue(disk());
  vi.mocked(viewerWriteText).mockResolvedValue({ hash: "written", size: 6, mtime: 2 });
  vi.mocked(viewerReleaseTemp).mockResolvedValue();
});
describe("shared document owner", () => {
  it("deduplicates concurrent loads and preserves a shared dirty document", async () => {
    await Promise.all([get().open(path), get().open(path)]);
    expect(viewerReadText).toHaveBeenCalledTimes(1);
    get().edit(path, "changed"); await get().open(path);
    expect(document().content).toBe("changed"); expect(document().dirty).toBe(true);
    expect(JSON.parse(localStorage.getItem(VIEWER_DRAFTS_KEY)!)[path].content).toBe("changed");
  });
  it("retains edits made during save and uses the successful snapshot hash next time", async () => {
    await get().open(path); get().edit(path, "snapshot");
    let resolve!: (value: ViewerWriteAck) => void;
    vi.mocked(viewerWriteText).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const saving = get().save(path); get().edit(path, "newer");
    resolve({ hash: "snapshot-hash", size: 8, mtime: 2 }); await saving;
    expect(document().content).toBe("newer"); expect(document().dirty).toBe(true);
    expect(document().savedContent).toBe("snapshot");
    await get().save(path);
    expect(viewerWriteText).toHaveBeenLastCalledWith(expect.objectContaining({ content: "newer", expectedHash: "snapshot-hash" }));
    expect(document().dirty).toBe(false);
  });
  it("does not silently overwrite external changes", async () => {
    await get().open(path); get().edit(path, "mine");
    vi.mocked(viewerReadText).mockResolvedValue(disk("external", "external-hash"));
    await get().checkExternal(path);
    expect(document().content).toBe("mine"); expect(document().external?.content).toBe("external");
    await expect(get().save(path)).rejects.toThrow("conflict");
    expect(viewerWriteText).not.toHaveBeenCalled();
    get().keepMine(path); await get().save(path);
    expect(viewerWriteText).toHaveBeenCalledWith(expect.objectContaining({ content: "mine", expectedHash: "external-hash" }));
  });
  it("reloads clean documents even when external edits retain mtime", async () => {
    await get().open(path);
    vi.mocked(viewerReadText).mockResolvedValue(disk("external", "new"));
    await get().checkExternal(path);
    expect(document().content).toBe("external"); expect(document().dirty).toBe(false);
  });
  it("restores drafts and exposes disk conflict rather than overwriting", async () => {
    await get().open(path); get().edit(path, "draft");
    get().release(path);
    vi.mocked(viewerReadText).mockResolvedValue(disk("external", "new"));
    await get().open(path);
    expect(document().content).toBe("draft"); expect(document().restored).toBe(true);
    expect(document().external?.hash).toBe("new");
  });
  it("preserves persisted drafts if flushDrafts runs while open() is still loading", async () => {
    await get().open(path); get().edit(path, "draft");
    get().release(path);
    useDocumentStore.setState({ documents: {}, closeRequest: undefined, draftError: undefined });
    let resolve!: (value: ViewerTextData) => void;
    vi.mocked(viewerReadText).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const reloading = get().open(path);
    await Promise.resolve();
    expect(document().loading).toBe(true);
    get().flushDrafts();
    expect(JSON.parse(localStorage.getItem(VIEWER_DRAFTS_KEY)!)[path].content).toBe("draft");
    resolve(disk("external", "new"));
    await reloading;
    expect(document().content).toBe("draft"); expect(document().restored).toBe(true);
    expect(document().dirty).toBe(true);
  });
  it("never edits or saves a remote read-only copy", async () => {
    await get().open(path, "Remote copy"); get().edit(path, "blocked"); await get().save(path);
    expect(document().content).toBe("original"); expect(viewerWriteText).not.toHaveBeenCalled();
    get().release(path); expect(viewerReleaseTemp).toHaveBeenCalledWith(path);
  });
  it("bounds large readonly reads and takes a second explicit open for editable content", async () => {
    vi.mocked(viewerStat).mockResolvedValue({ path, size: 6 * 1024 * 1024, mtime: 1, mime: "text/plain", isFile: true });
    vi.mocked(viewerReadText).mockResolvedValue({ ...disk("prefix", ""), truncated: true, nextOffset: 262142 });
    await get().open(path);
    expect(viewerReadText).toHaveBeenCalledWith(path, 256 * 1024);
    expect(document().readOnly).toBe(true); expect(document().nextOffset).toBe(262142);
  });
  it("ignores a load that completes after final host release", async () => {
    let resolve!: (value: ViewerTextData) => void;
    vi.mocked(viewerReadText).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const opening = get().open(path); await Promise.resolve();
    get().release(path); resolve(disk()); await opening;
    expect(document()).toBeUndefined();
  });
  it("round trips CRLF and BOM metadata and marks explicit format conversion dirty", async () => {
    vi.mocked(viewerReadText).mockResolvedValue({ ...disk("a\r\nb\r\n"), eol: "CRLF", bom: true, encoding: "UTF-16LE" });
    await get().open(path);
    expect(document().content).toBe("a\nb\n");
    get().edit(path, "a\nb\nc\n"); await get().save(path);
    expect(viewerWriteText).toHaveBeenCalledWith(expect.objectContaining({ encoding: "UTF-16LE", bom: true, eol: "CRLF" }));
    get().configure(path, { eol: "LF" }); expect(document().dirty).toBe(true);
  });
});
