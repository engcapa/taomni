import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WORKSPACE_ID, PLATFORM_WORKSPACES_STORAGE_KEY, useWorkspacePlatformStore } from "../workspacePlatformStore";

const read = () => JSON.parse(localStorage.getItem(PLATFORM_WORKSPACES_STORAGE_KEY) ?? "null");

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  useWorkspacePlatformStore.getState().reloadFromStorage();
});

afterEach(() => {
  useWorkspacePlatformStore.getState().reloadFromStorage();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("workspace metadata persistence outside file activation", () => {
  it("coalesces opens, tab selection and closes without writing on the input stack", () => {
    const write = vi.spyOn(Storage.prototype, "setItem");
    const store = useWorkspacePlatformStore.getState();
    const root = store.addRootFolder(DEFAULT_WORKSPACE_ID, { path: "/project" })!;
    const a = store.openFileInWorkspace(DEFAULT_WORKSPACE_ID, { rootId: root.id, path: "a.txt" });
    const b = store.openFileInWorkspace(DEFAULT_WORKSPACE_ID, { rootId: root.id, path: "b.html" });
    store.setActiveWorkspaceTab(DEFAULT_WORKSPACE_ID, a.id);
    store.closeWorkspaceTab(DEFAULT_WORKSPACE_ID, b.id);
    expect(store.getWorkspace()!.activeTabId).toBe(a.id);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(write).toHaveBeenCalledTimes(1);
    expect(read().workspaces[0].openTabs.map((tab: { id: string }) => tab.id)).toEqual([a.id]);
    expect(read().workspaces[0].activeTabId).toBe(a.id);
  });

  it.each(["beforeunload", "pagehide"])("flushes the latest file and session state on %s", (event) => {
    const store = useWorkspacePlatformStore.getState();
    const workspace = store.createWorkspace({ name: "close-immediately", rootPath: "/repo" });
    const file = store.openFileInWorkspace(workspace.id, { rootId: workspace.rootFolders[0].id, path: "notes.txt" });
    const terminal = store.openLocalTerminalInWorkspace(workspace.id);
    store.moveWorkspaceTab(workspace.id, terminal.id, 0);
    store.setActiveWorkspaceTab(workspace.id, file.id);
    window.dispatchEvent(new Event(event));
    const expected = store.getWorkspace(workspace.id);
    expect(read().workspaces.find((entry: { id: string }) => entry.id === workspace.id)).toEqual(expected);
    const write = vi.spyOn(Storage.prototype, "setItem");
    vi.advanceTimersByTime(1_000);
    expect(write).not.toHaveBeenCalled();
    store.reloadFromStorage();
    expect(store.getWorkspace(workspace.id)).toEqual(expected);
  });

  it("discards pending writes when explicitly reloading newer external state", () => {
    const store = useWorkspacePlatformStore.getState();
    store.createWorkspace({ name: "old-local-state" });
    localStorage.setItem(PLATFORM_WORKSPACES_STORAGE_KEY, JSON.stringify({
      version: 1, workspaces: [], activeWorkspaceId: DEFAULT_WORKSPACE_ID, createdNodes: [],
    }));
    store.reloadFromStorage();
    vi.advanceTimersByTime(1_000);
    expect(store.getWorkspace()!.id).toBe(DEFAULT_WORKSPACE_ID);
    expect(read().workspaces).toEqual([]);
  });

  it("does not overwrite a newer import during window teardown before the store reloads", () => {
    const store = useWorkspacePlatformStore.getState();
    store.createWorkspace({ name: "superseded" });
    const external = { version: 1, workspaces: [], activeWorkspaceId: DEFAULT_WORKSPACE_ID, createdNodes: [] };
    localStorage.setItem(PLATFORM_WORKSPACES_STORAGE_KEY, JSON.stringify(external));
    window.dispatchEvent(new Event("pagehide"));
    vi.advanceTimersByTime(1_000);
    expect(read()).toEqual(external);
    store.reloadFromStorage();
    expect(store.getWorkspace()!.id).toBe(DEFAULT_WORKSPACE_ID);
  });

  it("keeps the memory state usable after a failed write and saves on the next update", () => {
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new Error("storage full"); });
    const store = useWorkspacePlatformStore.getState();
    const workspace = store.createWorkspace({ name: "memory-state" });
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(store.getWorkspace(workspace.id)?.name).toBe("memory-state");
    write.mockRestore();
    store.renameWorkspace(workspace.id, "retry-state");
    vi.advanceTimersByTime(500);
    expect(read().workspaces.find((entry: { id: string }) => entry.id === workspace.id).name).toBe("retry-state");
  });
});
