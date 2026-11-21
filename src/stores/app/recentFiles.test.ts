import { beforeEach, describe, expect, it } from "vitest";
import { RECENT_FILES_KEY, useRecentFilesStore } from "./recentFiles";
import { setNotepadPreferences, resetNotepadPreferences } from "../notepadPreferences";

beforeEach(() => {
  localStorage.clear();
  resetNotepadPreferences();
  useRecentFilesStore.setState({ recentFiles: [], closedStack: [] });
});

describe("recent files store (V-11)", () => {
  it("orders by MRU, enforces limit, ignores untitled, renames, removes, and clears", () => {
    setNotepadPreferences({ recentMax: 5 });
    const store = useRecentFilesStore.getState();
    store.recordRecent("untitled:123", "新建 1");
    expect(useRecentFilesStore.getState().recentFiles).toHaveLength(0);

    for (let i = 1; i <= 7; i += 1) {
      store.recordRecent(`/docs/f${i}.txt`);
    }
    expect(useRecentFilesStore.getState().recentFiles.map((f) => f.name)).toEqual([
      "f7.txt",
      "f6.txt",
      "f5.txt",
      "f4.txt",
      "f3.txt",
    ]);

    store.recordRecent("/docs/f5.txt");
    expect(useRecentFilesStore.getState().recentFiles[0].name).toBe("f5.txt");

    store.renameRecent("/docs/f5.txt", "/docs/renamed.txt");
    expect(useRecentFilesStore.getState().recentFiles[0]).toMatchObject({
      path: "/docs/renamed.txt",
      name: "renamed.txt",
    });

    store.removeRecent("/docs/renamed.txt");
    expect(useRecentFilesStore.getState().recentFiles.some((f) => f.name === "renamed.txt")).toBe(false);

    store.clearRecent();
    expect(useRecentFilesStore.getState().recentFiles).toEqual([]);
    expect(JSON.parse(localStorage.getItem(RECENT_FILES_KEY)!)).toEqual([]);
  });

  it("tracks closed files stack for Reopen Last Closed", () => {
    const store = useRecentFilesStore.getState();
    store.pushClosed("/docs/a.txt");
    store.pushClosed("/docs/b.txt");
    expect(store.popClosed()?.path).toBe("/docs/b.txt");
    expect(store.popClosed()?.path).toBe("/docs/a.txt");
    expect(store.popClosed()).toBeUndefined();
  });
});
