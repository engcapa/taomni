import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteItem } from "../lib/notes";
import { useNotesTaskStore } from "./notesTaskStore";
import { useNotesContentStore } from "./notesContentStore";

const ipc = vi.hoisted(() => ({ getNote: vi.fn(), updateNoteMetadata: vi.fn(), archiveNote: vi.fn(),
  deleteNote: vi.fn(), setSteps: vi.fn(), upsertTags: vi.fn(), nowSecs: () => 1234 }));
vi.mock("../lib/notes", () => ipc);
function note(overrides: Partial<NoteItem> = {}): NoteItem {
  return { id: "a", title: "Title", body: "original", completed_at: null, pinned: false, archived_at: null,
    color: null, priority: 0, due_at: null, reminder_at: null, repeat_rule: null,
    source_tab_id: null, source_session_id: null, source_title: null, source_uri: null,
    created_at: 1, updated_at: 1, steps: [], tags: [], ...overrides };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  useNotesTaskStore.setState({ records: {}, pending: {}, errors: {} });
  useNotesContentStore.setState({ documents: {} });
  ipc.getNote.mockResolvedValue(note());
});

describe("Notes task ownership", () => {
  it("patches tasks independently of an unsaved or conflicted content draft", async () => {
    const contents = useNotesContentStore.getState();
    contents.edit(note(), { body: "unsaved" });
    const draft = useNotesContentStore.getState().documents.a;
    ipc.updateNoteMetadata.mockResolvedValue(note({ pinned: true }));
    expect(await useNotesTaskStore.getState().patch("a", { pinned: true })).toBe(true);
    expect(ipc.updateNoteMetadata).toHaveBeenCalledWith("a", { pinned: true });
    expect(useNotesContentStore.getState().documents.a).toBe(draft);
    expect(draft).toMatchObject({ body: "unsaved", dirty: true });
  });

  it("serializes independent mutations and refreshes only after their own write", async () => {
    const first = deferred<NoteItem>();
    ipc.updateNoteMetadata.mockReturnValueOnce(first.promise).mockResolvedValueOnce(note({ pinned: true, priority: 3 }));
    const store = useNotesTaskStore.getState();
    const pin = store.patch("a", { pinned: true });
    const priority = store.patch("a", { priority: 3 });
    const refresh = store.load("a");
    expect(ipc.updateNoteMetadata).toHaveBeenCalledTimes(1);
    expect(ipc.getNote).not.toHaveBeenCalled();
    ipc.getNote.mockResolvedValue(note({ pinned: true, priority: 3 }));
    first.resolve(note({ pinned: true }));
    await Promise.all([pin, priority, refresh]);
    expect(ipc.updateNoteMetadata).toHaveBeenCalledTimes(2);
    expect(useNotesTaskStore.getState().records.a).toMatchObject({ pinned: true, priority: 3 });
    expect(useNotesTaskStore.getState().pending.a).toBe(0);
  });

  it("rejects a late read that started before a newer patch or refresh", async () => {
    const old = deferred<NoteItem>();
    const store = useNotesTaskStore.getState();
    ipc.getNote.mockReturnValueOnce(old.promise);
    const loading = store.load("a");
    ipc.updateNoteMetadata.mockResolvedValue(note({ priority: 2 }));
    await store.patch("a", { priority: 2 });
    old.resolve(note());
    await loading;
    expect(useNotesTaskStore.getState().records.a?.priority).toBe(2);
    const slow = deferred<NoteItem>();
    ipc.getNote.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(note({ priority: 3 }));
    const slowLoad = store.load("a");
    await store.load("a");
    slow.resolve(note());
    await slowLoad;
    expect(useNotesTaskStore.getState().records.a?.priority).toBe(3);
  });

  it("keeps failure visible across refresh and retries only the failed metadata patch", async () => {
    const store = useNotesTaskStore.getState();
    ipc.updateNoteMetadata.mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce(note({ due_at: 50 }));
    expect(await store.patch("a", { due_at: 50 })).toBe(false);
    await store.load("a");
    expect(useNotesTaskStore.getState().errors.a).toContain("disk full");
    expect(await store.retry("a")).toBe(true);
    expect(ipc.updateNoteMetadata).toHaveBeenLastCalledWith("a", { due_at: 50 });
    expect(useNotesTaskStore.getState().errors.a).toBeNull();
  });

  it("applies checklist and tag changes to current persisted state", async () => {
    const store = useNotesTaskStore.getState();
    const remoteStep = { id: "step", note_id: "a", title: "external", completed_at: null, sort_order: 0, created_at: 1, updated_at: 1 };
    const remoteTag = { id: "keep", name: "keep", color: null, created_at: 1, updated_at: 1 };
    const newTag = { ...remoteTag, id: "new", name: "new" };
    ipc.getNote.mockResolvedValue(note({ steps: [remoteStep], tags: [remoteTag] }));
    await store.changeSteps("a", (steps) => [...steps, { title: "added" }]);
    expect(ipc.setSteps).toHaveBeenCalledWith("a", [remoteStep, { title: "added", sort_order: 1 }]);
    ipc.upsertTags.mockResolvedValue([newTag]);
    ipc.updateNoteMetadata.mockResolvedValue(note({ tags: [remoteTag, newTag] }));
    await store.addTag("a", " new ");
    expect(ipc.updateNoteMetadata).toHaveBeenLastCalledWith("a", { tag_ids: ["keep", "new"] });
  });

  it("does not treat missing notes as successful changes or deletion failures as success", async () => {
    const store = useNotesTaskStore.getState();
    ipc.updateNoteMetadata.mockResolvedValue(null);
    expect(await store.complete("a", true)).toBe(false);
    expect(useNotesTaskStore.getState().errors.a).toContain("deleted");
    ipc.deleteNote.mockRejectedValueOnce(new Error("locked")).mockResolvedValueOnce(undefined);
    expect(await store.remove("delete-id")).toBe(false);
    expect(await store.retry("delete-id")).toBe(true);
    expect(useNotesTaskStore.getState().records["delete-id"]).toBeNull();
  });
});

it("retains a failed field when an unrelated task change succeeds", async () => {
  const id = "independent-fields";
  const store = useNotesTaskStore.getState();
  ipc.updateNoteMetadata.mockRejectedValueOnce(new Error("schedule failed"))
    .mockResolvedValueOnce(note({ id, pinned: true }))
    .mockResolvedValueOnce(note({ id, pinned: true, due_at: 500 }));
  expect(await store.patch(id, { due_at: 500 })).toBe(false);
  expect(await store.patch(id, { pinned: true })).toBe(true);
  expect(useNotesTaskStore.getState().errors[id]).toContain("schedule failed");
  expect(await store.retry(id)).toBe(true);
  expect(ipc.updateNoteMetadata).toHaveBeenLastCalledWith(id, { due_at: 500 });
  expect(useNotesTaskStore.getState().records[id]).toMatchObject({ pinned: true, due_at: 500 });
});

it("retries a failed task read without writing stale metadata", async () => {
  const id = "read-retry";
  const store = useNotesTaskStore.getState();
  ipc.getNote.mockRejectedValueOnce(new Error("read failed")).mockResolvedValueOnce(note({ id, priority: 3 }));
  await store.load(id);
  expect(useNotesTaskStore.getState().errors[id]).toContain("read failed");
  expect(await store.retry(id)).toBe(true);
  expect(useNotesTaskStore.getState().records[id]?.priority).toBe(3);
  expect(ipc.updateNoteMetadata).not.toHaveBeenCalled();
});
