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
