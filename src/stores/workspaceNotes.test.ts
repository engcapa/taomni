import { beforeEach, describe, expect, it } from "vitest";
import { readPersistedPlatformState, useWorkspacePlatformStore } from "./workspacePlatformStore";
import { NOTES_WORKSPACE_ID } from "./workspaceNotes";

beforeEach(() => {
  localStorage.clear();
  useWorkspacePlatformStore.getState().reloadFromStorage();
});

describe("built-in Notes workspace", () => {
  it("exists alongside Default on first launch and remains protected", () => {
    const store = useWorkspacePlatformStore.getState();
    expect(store.getWorkspace(NOTES_WORKSPACE_ID)?.name).toBe("Notes");
    expect(store.addRootFolder(NOTES_WORKSPACE_ID, { path: "/tmp/project" })).toBeNull();
    expect(store.deleteWorkspace(NOTES_WORKSPACE_ID)).toBe(false);
    store.renameWorkspace(NOTES_WORKSPACE_ID, "renamed");
    expect(store.getWorkspace(NOTES_WORKSPACE_ID)?.name).toBe("Notes");
  });

  it("routes global terminal and Git entries to a workspace that can display them", () => {
    const store = useWorkspacePlatformStore.getState();
    store.setActiveWorkspace(NOTES_WORKSPACE_ID);
    const terminal = store.openLocalTerminalInWorkspace(NOTES_WORKSPACE_ID);
    const git = store.openGitTab(NOTES_WORKSPACE_ID);
    expect(terminal.workspaceId).toBe("default-workspace");
    expect(git.workspaceId).toBe("default-workspace");
    expect(store.getWorkspace(NOTES_WORKSPACE_ID)?.openTabs).toEqual([]);
    expect(useWorkspacePlatformStore.getState().activeWorkspaceId).toBe("default-workspace");
  });

  it("opens the same note only once across title changes and restores its stable identity", () => {
    const store = useWorkspacePlatformStore.getState();
    const first = store.openNoteInWorkspace("a", "First title");
    store.openNoteInWorkspace("b", "First title");
    const again = store.openNoteInWorkspace("a", "Changed title");
    expect(again.id).toBe(first.id);
    expect(store.getWorkspace(NOTES_WORKSPACE_ID)?.openTabs).toHaveLength(2);
    window.dispatchEvent(new Event("pagehide"));
    const restored = readPersistedPlatformState();
    expect(restored.activeWorkspaceId).toBe(NOTES_WORKSPACE_ID);
    expect(restored.workspaces.find((workspace) => workspace.id === NOTES_WORKSPACE_ID)).toMatchObject({ activeTabId: first.id,
      openTabs: [expect.objectContaining({ kind: "note", noteId: "a" }), expect.objectContaining({ kind: "note", noteId: "b" })] });
  });
});
