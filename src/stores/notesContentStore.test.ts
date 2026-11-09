import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteItem } from "../lib/notes";
import { useNotesContentStore } from "./notesContentStore";
import { readNoteDrafts } from "./notesContentRecovery";

const ipc = vi.hoisted(() => ({ getNote: vi.fn(), listNotes: vi.fn(), saveNoteContent: vi.fn() }));
vi.mock("../lib/notes", () => ipc);

function note(id = "a", title = "Title", body = "original"): NoteItem {
  return {
    id, title, body, completed_at: null, pinned: true, archived_at: null,
    color: "#abcdef", priority: 3, due_at: 1234, reminder_at: 1200,
    repeat_rule: null, source_tab_id: null, source_session_id: null,
    source_title: null, source_uri: null, created_at: 1, updated_at: 2, steps: [], tags: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  localStorage.clear();
  useNotesContentStore.setState({ documents: {}, catalog: [], catalogError: null, recoveryError: null });
  vi.resetAllMocks();
  ipc.listNotes.mockResolvedValue([]);
});

describe("shared Notes document ownership", () => {
  it("keeps edits from both entry points in one draft and saves only content", async () => {
    const original = note();
    const store = useNotesContentStore.getState();
    store.adopt(original);
    store.edit(original, { body: "workspace body" });
    store.edit(original, { title: "compact title" });
    // A stale list render must not reset an in-progress draft.
    store.adopt(original);
    ipc.saveNoteContent.mockResolvedValue(note("a", "compact title", "workspace body"));
    expect(await store.save("a")).toBe(true);
    expect(ipc.saveNoteContent).toHaveBeenCalledWith("a",
      { title: "compact title", body: "workspace body" }, { title: "Title", body: "original" });
    expect(useNotesContentStore.getState().documents.a).toMatchObject({ title: "compact title", body: "workspace body", dirty: false });
    expect(readNoteDrafts()).toEqual({});
  });

  it("retains typing during a pending save and serializes a second save against the new baseline", async () => {
    const first = deferred<NoteItem>();
    ipc.saveNoteContent.mockReturnValueOnce(first.promise).mockResolvedValueOnce(note("a", "Title", "second edit"));
    const store = useNotesContentStore.getState();
    store.adopt(note());
    store.edit(note(), { body: "first edit" });
    const saving = store.save("a");
    store.edit(note(), { body: "second edit" });
    const savingAgain = store.save("a");
    expect(ipc.saveNoteContent).toHaveBeenCalledTimes(1);
    first.resolve(note("a", "Title", "first edit"));
    await Promise.all([saving, savingAgain]);
    expect(ipc.saveNoteContent).toHaveBeenLastCalledWith("a",
      { title: "Title", body: "second edit" }, { title: "Title", body: "first edit" });
    expect(useNotesContentStore.getState().documents.a).toMatchObject({ body: "second edit", dirty: false, saving: false });
  });

  it.each(["conflict", "missing"] as const)("preserves the draft when persistence reports %s", async (kind) => {
    const store = useNotesContentStore.getState();
    store.adopt(note());
    store.edit(note(), { body: "retained draft" });
    ipc.saveNoteContent.mockRejectedValue({ kind, message: "External edit" });
    expect(await store.save("a")).toBe(false);
    expect(useNotesContentStore.getState().documents.a).toMatchObject({ body: "retained draft", dirty: true, error: kind });
    expect(readNoteDrafts().a.body).toBe("retained draft");
    expect(await store.save("a")).toBe(false);
    expect(ipc.saveNoteContent).toHaveBeenCalledTimes(1);
  });

  it("allows retry after a storage failure without changing the expected content", async () => {
    const store = useNotesContentStore.getState();
    store.adopt(note());
    store.edit(note(), { body: "draft" });
    ipc.saveNoteContent.mockRejectedValueOnce(new Error("Disk full")).mockResolvedValueOnce(note("a", "Title", "draft"));
    expect(await store.save("a")).toBe(false);
    expect(useNotesContentStore.getState().documents.a.error).toBe("storage");
    expect(await store.save("a")).toBe(true);
    expect(useNotesContentStore.getState().documents.a.error).toBeNull();
    expect(ipc.saveNoteContent).toHaveBeenLastCalledWith("a", { title: "Title", body: "draft" }, { title: "Title", body: "original" });
  });

  it("refreshes clean content but marks an external change as conflict for a dirty draft", async () => {
    const store = useNotesContentStore.getState();
    store.adopt(note());
    ipc.getNote.mockResolvedValueOnce(note("a", "Title", "external"));
    await store.refresh("a");
    expect(useNotesContentStore.getState().documents.a.body).toBe("external");
    store.edit(note(), { body: "local draft" });
    ipc.getNote.mockResolvedValueOnce(note("a", "Title", "external again"));
    await store.refresh("a");
    expect(useNotesContentStore.getState().documents.a).toMatchObject({ body: "local draft", error: "conflict" });
  });

  it("ignores a late refresh and keeps edits made during an explicit reload", async () => {
    const stale = deferred<NoteItem>();
    const reload = deferred<NoteItem>();
    const store = useNotesContentStore.getState();
    store.adopt(note());
    ipc.getNote.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(note("a", "Title", "newest"));
    const oldRequest = store.refresh("a");
    await store.refresh("a");
    stale.resolve(note("a", "Title", "stale"));
    await oldRequest;
    expect(useNotesContentStore.getState().documents.a.body).toBe("newest");
    ipc.getNote.mockReturnValueOnce(reload.promise);
    const loading = store.reload("a");
    store.edit(note(), { body: "typed during reload" });
    reload.resolve(note("a", "Title", "disk"));
    expect(await loading).toBe(false);
    expect(useNotesContentStore.getState().documents.a.body).toBe("typed during reload");
  });

  it("recovers dirty title and body with their original conflict baseline", () => {
    const store = useNotesContentStore.getState();
    store.adopt(note());
    store.edit(note(), { title: "draft title", body: "draft body" });
    expect(readNoteDrafts().a).toMatchObject({ title: "draft title", body: "draft body",
      saved: { title: "Title", body: "original" }, dirty: true, saving: false });
  });

  it("flushes typing made while a navigation save is pending and ignores a stale list afterward", async () => {
    const first = deferred<NoteItem>();
    ipc.saveNoteContent.mockReturnValueOnce(first.promise).mockResolvedValueOnce(note("a", "Title", "latest"));
    const store = useNotesContentStore.getState();
    store.adopt(note());
    store.edit(note(), { body: "first" });
    const saving = store.save("a");
    store.edit(note(), { body: "latest" });
    first.resolve(note("a", "Title", "first"));
    expect(await saving).toBe(true);
    store.adopt(note());
    expect(useNotesContentStore.getState().documents.a).toMatchObject({ body: "latest", dirty: false });
    expect(ipc.saveNoteContent).toHaveBeenCalledTimes(2);
  });

  it("keeps floating recovery independent of the main window journal", () => {
    const store = useNotesContentStore.getState();
    store.adopt(note());
    store.edit(note(), { body: "main draft" });
    window.history.replaceState(null, "", "#notes=singleton");
    expect(readNoteDrafts()).toEqual({});
    store.edit(note(), { body: "floating draft" });
    expect(readNoteDrafts().a.body).toBe("floating draft");
    window.history.replaceState(null, "", window.location.pathname);
    expect(readNoteDrafts().a.body).toBe("main draft");
  });
});
