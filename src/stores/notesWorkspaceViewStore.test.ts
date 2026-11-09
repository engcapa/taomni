import { beforeEach, expect, it, vi } from "vitest";
import { useNotesWorkspaceViewStore } from "./notesWorkspaceViewStore";
import { useNotesStore } from "./notesStore";
const ipc = vi.hoisted(() => ({ listNotes: vi.fn(), listTags: vi.fn(), getPrefs: vi.fn(), setPrefs: vi.fn(), nowSecs: () => 1234 }));
vi.mock("../lib/notes", () => ipc);
beforeEach(() => {
  vi.resetAllMocks();
  ipc.listNotes.mockResolvedValue([]); ipc.listTags.mockResolvedValue([]); ipc.getPrefs.mockResolvedValue({}); ipc.setPrefs.mockResolvedValue(undefined);
  useNotesWorkspaceViewStore.setState({ notes: [], tags: [], search: "", statusFilters: ["recent_incomplete"], tagFilterId: null,
    initialized: false, loading: false, error: null });
});
it("uses native query semantics with independent persisted workspace filters", async () => {
  useNotesStore.setState({ search: "compact", statusFilters: ["completed"] });
  ipc.getPrefs.mockResolvedValue({ "notes.workspace.statusFilters": '["pinned"]' });
  const store = useNotesWorkspaceViewStore.getState();
  await store.init();
  store.toggleFilter("overdue"); store.setSearch(" tags "); store.setTagFilter("tag-id");
  await store.load();
  expect(ipc.listNotes).toHaveBeenLastCalledWith({ filters: ["pinned", "overdue"], search: "tags", tag_id: "tag-id", now: 1234 });
  expect(ipc.setPrefs).toHaveBeenCalledWith({ "notes.workspace.statusFilters": '["pinned","overdue"]' });
  expect(useNotesStore.getState()).toMatchObject({ search: "compact", statusFilters: ["completed"] });
  store.toggleFilter("all");
  expect(useNotesWorkspaceViewStore.getState().statusFilters).toEqual(["all"]);
  store.resetForCreate();
  expect(useNotesWorkspaceViewStore.getState()).toMatchObject({ search: "", tagFilterId: null, statusFilters: ["recent_incomplete"] });
  await store.load();
});
it("does not let old queries overwrite newer searches and exposes errors for retry", async () => {
  let resolve!: (value: unknown[]) => void;
  ipc.listNotes.mockReturnValueOnce(new Promise((done) => { resolve = done; })).mockResolvedValueOnce([{ id: "current" }]);
  const store = useNotesWorkspaceViewStore.getState();
  const old = store.load();
  store.setSearch("new");
  await vi.waitFor(() => expect(useNotesWorkspaceViewStore.getState().notes).toEqual([{ id: "current" }]));
  resolve([{ id: "old" }]); await old;
  expect(useNotesWorkspaceViewStore.getState().notes).toEqual([{ id: "current" }]);
  ipc.listNotes.mockRejectedValueOnce(new Error("unavailable")); await store.load();
  expect(useNotesWorkspaceViewStore.getState().error).toContain("unavailable");
  await store.load(); expect(useNotesWorkspaceViewStore.getState().error).toBeNull();
});
it("keeps a user's new status selection when preferences arrive late", async () => {
  let resolve!: (value: Record<string, string>) => void;
  ipc.getPrefs.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const store = useNotesWorkspaceViewStore.getState();
  const initialization = store.init();
  store.toggleFilter("all");
  resolve({ "notes.workspace.statusFilters": '["archived"]' });
  await initialization;
  expect(useNotesWorkspaceViewStore.getState().statusFilters).toEqual(["all"]);
});
it("persists rapid filter changes in invocation order when an older write finishes last", async () => {
  let persisted = '["recent_incomplete"]';
  let finishOlderWrite!: () => void;
  ipc.setPrefs
    .mockImplementationOnce((prefs: Record<string, string>) => new Promise<void>((resolve) => {
      finishOlderWrite = () => {
        persisted = prefs["notes.workspace.statusFilters"];
        resolve();
      };
    }))
    .mockImplementationOnce(async (prefs: Record<string, string>) => {
      persisted = prefs["notes.workspace.statusFilters"];
    });
  const store = useNotesWorkspaceViewStore.getState();
  store.toggleFilter("all");
  store.toggleFilter("completed");
  await Promise.resolve();
  finishOlderWrite();
  await vi.waitFor(() => expect(persisted).toBe('["completed"]'));
  expect(useNotesWorkspaceViewStore.getState().statusFilters).toEqual(["completed"]);
  expect(persisted).toBe('["completed"]');
});
it("continues later writes after a failure without publishing a stale error", async () => {
  let rejectOlderWrite!: (error: Error) => void;
  const persisted: string[] = [];
  ipc.setPrefs
    .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOlderWrite = reject; }))
    .mockImplementationOnce(async (prefs: Record<string, string>) => {
      persisted.push(prefs["notes.workspace.statusFilters"]);
    });
  const store = useNotesWorkspaceViewStore.getState();
  store.toggleFilter("all");
  store.toggleFilter("completed");
  await vi.waitFor(() => expect(ipc.setPrefs).toHaveBeenCalledTimes(1));
  rejectOlderWrite(new Error("old failure"));
  await vi.waitFor(() => expect(persisted).toEqual(['["completed"]']));
  expect(ipc.setPrefs).toHaveBeenCalledTimes(2);
  expect(useNotesWorkspaceViewStore.getState()).toMatchObject({ statusFilters: ["completed"], error: null });
});
it("exposes a failure from the newest preference write", async () => {
  ipc.setPrefs.mockRejectedValueOnce(new Error("latest failure"));
  useNotesWorkspaceViewStore.getState().toggleFilter("all");
  await vi.waitFor(() => expect(useNotesWorkspaceViewStore.getState().error).toContain("latest failure"));
});
