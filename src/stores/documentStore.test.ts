import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDocumentStore } from "./documentStore";
import { MAX_LOCALSTORAGE_DRAFT_CHARS, VIEWER_DRAFTS_KEY } from "./viewerDrafts";
import { resetNotepadPreferences, setNotepadPreferences } from "./notepadPreferences";
import { viewerReadText, viewerReleaseTemp, viewerStat, viewerWriteText, type ViewerTextData, type ViewerWriteAck } from "../lib/viewer";
vi.mock("../lib/viewer", async (original) => ({ ...await original<typeof import("../lib/viewer")>(), viewerStat: vi.fn(), viewerReadText: vi.fn(), viewerReadTextChunk: vi.fn(), viewerWriteText: vi.fn(), viewerReleaseTemp: vi.fn() }));
const backups = vi.hoisted(() => new Map<string, { entry: { id: string; docId: string; path: string | null; name: string; encoding: string; bom: boolean; eol: string; savedHash: string; updatedAt: number; size: number }; content: string }[]>());
vi.mock("../lib/notepad/ipc", () => {
  let sequence = 0;
  return {
    notepadBackupWrite: vi.fn(async (args: { docId: string; path: string | null; name: string; content: string; encoding: string; bom: boolean; eol: string; savedHash: string }) => {
      const entry = {
        id: `${args.docId}__${++sequence}`, docId: args.docId, path: args.path, name: args.name,
        encoding: args.encoding, bom: args.bom, eol: args.eol, savedHash: args.savedHash,
        updatedAt: Math.floor(Date.now() / 1000), size: args.content.length,
      };
      backups.set(args.docId, [...(backups.get(args.docId) ?? []), { entry, content: args.content }].slice(-9));
      return entry;
    }),
    notepadBackupList: vi.fn(async () => [...backups.values()].flat().map((item) => item.entry)),
    notepadBackupRead: vi.fn(async (id: string) => {
      for (const list of backups.values()) {
        const found = list.find((item) => item.entry.id === id);
        if (found) return found;
      }
      throw new Error(`not_found: ${id}`);
    }),
    notepadBackupPrune: vi.fn(async (docId: string) => { backups.delete(docId); }),
  };
});
import { notepadBackupPrune, notepadBackupWrite } from "../lib/notepad/ipc";
const disk = (content = "original", hash = "old"): ViewerTextData => ({ path: "/docs/note.txt", content, hash, encoding: "UTF-8", bom: false, eol: "LF", mtime: 1, size: content.length, truncated: false });
const path = "/docs/note.txt";
const get = () => useDocumentStore.getState();
const document = () => get().documents[path];
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  backups.clear();
  resetNotepadPreferences();
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
  it("keeps an initial read error visible until the user explicitly retries", async () => {
    vi.mocked(viewerReadText).mockRejectedValueOnce(new Error("binary: Binary file"));
    await get().open(path);
    expect(document().error).toContain("binary");
    vi.mocked(viewerReadText).mockResolvedValue(disk("repaired", "repaired-hash"));
    await get().checkExternal(path);
    expect(viewerReadText).toHaveBeenCalledTimes(1);
    expect(document().error).toContain("binary");
    await get().open(path);
    expect(document().content).toBe("repaired");
    expect(document().error).toBeUndefined();
  });
  it("restores drafts and exposes disk conflict rather than overwriting", async () => {
    await get().open(path); get().edit(path, "draft");
    get().release(path);
    vi.mocked(viewerReadText).mockResolvedValue(disk("external", "new"));
    await get().open(path);
    expect(document().content).toBe("draft"); expect(document().restored).toBe(true);
    expect(document().external?.hash).toBe("new");
  });
  it("keeps a draft while the reopened document is still loading", async () => {
    await get().open(path); get().edit(path, "draft"); get().release(path);
    let resolve!: (value: ViewerTextData) => void;
    vi.mocked(viewerReadText).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const opening = get().open(path);
    await vi.waitFor(() => expect(document().loading).toBe(true));
    get().flushDrafts();
    expect(JSON.parse(localStorage.getItem(VIEWER_DRAFTS_KEY)!)[path].content).toBe("draft");
    resolve(disk()); await opening;
    expect(document().content).toBe("draft"); expect(document().restored).toBe(true);
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

  it("shows conflict banner instead of auto-reloading clean file when autoReloadCleanExternal is false", async () => {
    setNotepadPreferences({ autoReloadCleanExternal: false });
    await get().open(path);
    vi.mocked(viewerReadText).mockResolvedValue(disk("external", "new-hash"));
    await get().checkExternal(path);
    expect(document().content).toBe("original");
    expect(document().external?.content).toBe("external");
  });

  it("skips oversized drafts in localStorage while keeping small drafts", async () => {
    await get().open(path);
    get().edit(path, "x".repeat(MAX_LOCALSTORAGE_DRAFT_CHARS + 10));
    const stored = JSON.parse(localStorage.getItem(VIEWER_DRAFTS_KEY) ?? "{}") as Record<string, unknown>;
    expect(stored[path]).toBeUndefined();
  });

  it("persists an oversized keep-draft as a native backup and restores it on reopen", async () => {
    await get().open(path);
    const oversized = "x".repeat(MAX_LOCALSTORAGE_DRAFT_CHARS + 10);
    get().edit(path, oversized);
    await get().persistRecoveryDrafts([path]);
    expect(notepadBackupWrite).toHaveBeenCalledWith(expect.objectContaining({ docId: path, path, content: oversized }));
    expect((JSON.parse(localStorage.getItem(VIEWER_DRAFTS_KEY) ?? "{}") as Record<string, unknown>)[path]).toBeUndefined();
    get().release(path);
    expect(notepadBackupPrune).not.toHaveBeenCalled();
    await get().open(path);
    expect(document().content).toBe(oversized);
    expect(document().restored).toBe(true);
  });

  it("falls back to a native backup when localStorage rejects the keep-draft write", async () => {
    await get().open(path);
    get().edit(path, "quota draft");
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === VIEWER_DRAFTS_KEY) throw new DOMException("Quota exceeded", "QuotaExceededError");
      Reflect.apply(originalSetItem, this, [key, value]);
    });
    try {
      await get().persistRecoveryDrafts([path]);
    } finally {
      setItem.mockRestore();
    }
    expect(notepadBackupWrite).toHaveBeenCalledWith(expect.objectContaining({ docId: path, content: "quota draft" }));
    expect(get().draftError).toBeUndefined();
    get().release(path);
    await get().open(path);
    expect(document().content).toBe("quota draft");
    expect(document().restored).toBe(true);
  });

  it("rejects keep-draft when neither localStorage nor the native backup can persist", async () => {
    await get().open(path);
    get().edit(path, "x".repeat(MAX_LOCALSTORAGE_DRAFT_CHARS + 10));
    vi.mocked(notepadBackupWrite).mockRejectedValueOnce(new Error("io: disk full"));
    await expect(get().persistRecoveryDrafts([path])).rejects.toThrow("draft_recovery_failed");
    expect(get().draftError).toContain("disk full");
  });

  it("restores an oversized kept untitled draft through the native backup route", async () => {
    const id = "untitled:recovery";
    const oversized = "u".repeat(MAX_LOCALSTORAGE_DRAFT_CHARS + 10);
    get().createUntitled(id, { content: oversized, dirty: true });
    await get().persistRecoveryDrafts([id]);
    expect(notepadBackupWrite).toHaveBeenCalledWith(expect.objectContaining({ docId: id, path: null, content: oversized }));
    get().release(id);
    expect(notepadBackupPrune).not.toHaveBeenCalled();
    await get().open(id);
    expect(get().documents[id]?.content).toBe(oversized);
    expect(get().documents[id]?.restored).toBe(true);
  });

  it("prunes both the local draft and the native snapshot on discard", async () => {
    const id = "untitled:discard";
    const oversized = "d".repeat(MAX_LOCALSTORAGE_DRAFT_CHARS + 10);
    get().createUntitled(id, { content: oversized, dirty: true });
    await get().persistRecoveryDrafts([id]);
    expect(backups.has(id)).toBe(true);
    get().discard(id);
    expect(notepadBackupPrune).toHaveBeenCalledWith(id);
    expect(backups.has(id)).toBe(false);
    const stored = JSON.parse(localStorage.getItem(VIEWER_DRAFTS_KEY) ?? "{}") as Record<string, unknown>;
    expect(stored[id]).toBeUndefined();
    expect(get().documents[id].dirty).toBe(false);
  });
});
