import { beforeEach, describe, expect, it } from "vitest";
import type { SessionConfig } from "../../lib/ipc";
import {
  DEFAULT_WORKSPACE_ID,
  PLATFORM_WORKSPACES_STORAGE_KEY,
  readPersistedPlatformState,
  useWorkspacePlatformStore,
} from "../workspacePlatformStore";
import { useAppStore } from "../appStore";
import type { Tab } from "../../types";

function session(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    id: "global-mysql-01",
    name: "global-mysql-01",
    session_type: "MySQL",
    group_path: "User sessions",
    host: "10.0.0.5",
    port: 3306,
    username: "root",
    auth_method: "Password",
    options_json: "{}",
    created_at: 1,
    updated_at: 1,
    last_connected_at: null,
    sort_order: 0,
    ...overrides,
  };
}

function appTab(id: string): Tab {
  return { id, type: "terminal", title: id, closable: true };
}

function resetPlatformStore(): void {
  window.localStorage.removeItem(PLATFORM_WORKSPACES_STORAGE_KEY);
  useWorkspacePlatformStore.getState().reloadFromStorage();
}

beforeEach(() => {
  window.localStorage.clear();
  resetPlatformStore();
  useAppStore.setState({ tabs: [], activeTabId: null });
});

describe("workspacePlatformStore (TASK-01)", () => {
  it("UT-WS-01-01 initializes the undeletable default workspace from empty storage", () => {
    const state = useWorkspacePlatformStore.getState();
    expect(state.workspaces.length).toBeGreaterThanOrEqual(1);
    expect(state.workspaces[0]).toMatchObject({
      id: DEFAULT_WORKSPACE_ID,
      isDefault: true,
    });
    expect(state.workspaces[0].name).toContain("Default Workspace");
    expect(state.activeWorkspaceId).toBe(DEFAULT_WORKSPACE_ID);
  });

  it("UT-WS-01-02 rejects deleting the default workspace and falls back for a deleted active workspace", () => {
    const store = useWorkspacePlatformStore.getState();
    expect(store.deleteWorkspace(DEFAULT_WORKSPACE_ID)).toBe(false);
    expect(useWorkspacePlatformStore.getState().workspaces.some((workspace) => workspace.id === DEFAULT_WORKSPACE_ID)).toBe(true);

    const custom = store.createWorkspace({ name: "ws-custom" });
    expect(useWorkspacePlatformStore.getState().activeWorkspaceId).toBe(custom.id);
    expect(useWorkspacePlatformStore.getState().deleteWorkspace(custom.id)).toBe(true);
    expect(useWorkspacePlatformStore.getState().workspaces.some((workspace) => workspace.id === custom.id)).toBe(false);
    expect(useWorkspacePlatformStore.getState().activeWorkspaceId).toBe(DEFAULT_WORKSPACE_ID);
  });

  it("UT-WS-01-03 adds, dedupes and removes multi-root folders without touching disk", () => {
    const store = useWorkspacePlatformStore.getState();
    const custom = store.createWorkspace({ name: "multi-root" });
    const a = store.addRootFolder(custom.id, { path: "/repo/a", name: "a" });
    const b = store.addRootFolder(custom.id, { path: "/repo/b", name: "b" });
    expect(a && b).toBeTruthy();
    let workspace = useWorkspacePlatformStore.getState().workspaces.find((entry) => entry.id === custom.id)!;
    expect(workspace.rootFolders.map((root) => root.path)).toEqual(["/repo/a", "/repo/b"]);

    const duplicate = store.addRootFolder(custom.id, { path: "/repo/a/", name: "again" });
    workspace = useWorkspacePlatformStore.getState().workspaces.find((entry) => entry.id === custom.id)!;
    expect(workspace.rootFolders).toHaveLength(2);
    expect(duplicate?.path).toBe("/repo/a");

    store.removeRootFolder(custom.id, a!.id);
    workspace = useWorkspacePlatformStore.getState().workspaces.find((entry) => entry.id === custom.id)!;
    expect(workspace.rootFolders.map((root) => root.path)).toEqual(["/repo/b"]);
  });

  it("UT-WS-01-04 keeps created files/folders in sync and opens new files", () => {
    const store = useWorkspacePlatformStore.getState();
    const custom = store.createWorkspace({ name: "creator", rootPath: "/repo/a" });
    const root = useWorkspacePlatformStore.getState().workspaces.find((entry) => entry.id === custom.id)!.rootFolders[0];

    const tab = store.createFileInWorkspace(custom.id, root.id, "src/index.ts");
    store.createFolderInWorkspace(custom.id, root.id, "src/utils");

    const workspace = useWorkspacePlatformStore.getState().workspaces.find((entry) => entry.id === custom.id)!;
    expect(tab?.kind).toBe("file");
    expect(tab?.filePath).toBe("src/index.ts");
    expect(workspace.openTabs.some((entry) => entry.kind === "file" && entry.filePath === "src/index.ts")).toBe(true);
    expect(workspace.activeTabId).toBe(tab?.id);

    const nodes = useWorkspacePlatformStore.getState().createdNodes.filter((node) => node.workspaceId === custom.id);
    expect(nodes.map((node) => `${node.kind}:${node.path}`).sort()).toEqual([
      "file:src/index.ts",
      "folder:src/utils",
    ]);
  });

  it("UT-WS-01-05 opens a global session that is not pinned without touching the pin list", () => {
    const store = useWorkspacePlatformStore.getState();
    const workspace = store.workspaces[0];
    const tab = store.openSessionInWorkspace(workspace.id, session(), { pinToWorkspace: false });
    const updated = useWorkspacePlatformStore.getState().workspaces.find((entry) => entry.id === workspace.id)!;
    expect(tab.kind).toBe("database");
    expect(tab.id.startsWith(`ws:${workspace.id}:sess:global-mysql-01`)).toBe(true);
    expect(tab.sessionId).toBe("global-mysql-01");
    expect(updated.openTabs.map((entry) => entry.id)).toContain(tab.id);
    expect(updated.pinnedSessionIds).toEqual([]);
  });

  it("UT-WS-01-06 pins a session when the picker asks for it", () => {
    const store = useWorkspacePlatformStore.getState();
    const workspace = store.workspaces[0];
    const tab = store.openSessionInWorkspace(workspace.id, session({ id: "ssh-prod-01", session_type: "SSH" }), {
      pinToWorkspace: true,
    });
    const updated = useWorkspacePlatformStore.getState().workspaces.find((entry) => entry.id === workspace.id)!;
    expect(tab.kind).toBe("terminal");
    expect(updated.openTabs.some((entry) => entry.id === tab.id)).toBe(true);
    expect(updated.pinnedSessionIds).toEqual(["ssh-prod-01"]);
  });

  it("UT-WS-01-07 keeps workspace sessions isolated from Sessions-mode app tabs", () => {
    const sessionConfig = session({ id: "ssh-prod-01", name: "prod-api-01", session_type: "SSH" });
    useAppStore.getState().addTab(appTab("ssh-prod-01-global"));
    const globalTabId = useAppStore.getState().tabs[0].id;

    const store = useWorkspacePlatformStore.getState();
    const workspaceId = store.workspaces[0].id;
    const wsTab = store.openSessionInWorkspace(workspaceId, sessionConfig);
    expect(wsTab.id).not.toBe(globalTabId);
    expect(useAppStore.getState().tabs.map((tab) => tab.id)).toEqual([globalTabId]);

    useWorkspacePlatformStore.getState().closeWorkspaceTab(workspaceId, wsTab.id);
    expect(useAppStore.getState().tabs.map((tab) => tab.id)).toEqual([globalTabId]);
    expect(useWorkspacePlatformStore.getState().workspaces[0].openTabs).toHaveLength(0);

    const secondWsTab = useWorkspacePlatformStore.getState().openSessionInWorkspace(workspaceId, sessionConfig);
    useAppStore.getState().removeTab(globalTabId);
    expect(useAppStore.getState().tabs).toHaveLength(0);
    expect(useWorkspacePlatformStore.getState().workspaces[0].openTabs.some((tab) => tab.id === secondWsTab.id)).toBe(true);
  });

  it("UT-WS-01-08 manages the bottom-left floating MFA window state with viewport clamping", () => {
    useAppStore.setState({
      floatingMfa: { open: false, pinned: false, position: { left: 50, bottom: 30 }, searchQuery: "" },
    });
    const store = useAppStore.getState();
    expect(useAppStore.getState().floatingMfa.position).toEqual({ left: 50, bottom: 30 });

    store.toggleFloatingMfa();
    expect(useAppStore.getState().floatingMfa.open).toBe(true);
    useAppStore.getState().toggleFloatingMfa();
    expect(useAppStore.getState().floatingMfa.open).toBe(false);

    useAppStore.getState().setFloatingMfaPosition(-100, -50);
    expect(useAppStore.getState().floatingMfa.position.left).toBeGreaterThanOrEqual(8);
    expect(useAppStore.getState().floatingMfa.position.bottom).toBeGreaterThanOrEqual(8);

    useAppStore.getState().setFloatingMfaPosition(99999, 99999);
    const clamped = useAppStore.getState().floatingMfa.position;
    expect(clamped.left).toBeLessThanOrEqual(window.innerWidth - 280);
    expect(clamped.bottom).toBeLessThanOrEqual(window.innerHeight);

    useAppStore.getState().setFloatingMfaPinned(true);
    expect(useAppStore.getState().floatingMfa.pinned).toBe(true);
    useAppStore.getState().setFloatingMfaSearch("github");
    expect(useAppStore.getState().floatingMfa.searchQuery).toBe("github");
  });

  it("persists the workspace list and restores it after a reload", () => {
    const store = useWorkspacePlatformStore.getState();
    const custom = store.createWorkspace({ name: "persisted", rootPath: "/repo/persisted" });
    store.addRootFolder(custom.id, { path: "/repo/extra" });
    store.pinSession(custom.id, "ssh-a");

    const stored = window.localStorage.getItem(PLATFORM_WORKSPACES_STORAGE_KEY);
    expect(stored).toContain("persisted");

    const reread = readPersistedPlatformState();
    expect(reread.activeWorkspaceId).toBe(custom.id);
    const restored = reread.workspaces.find((entry) => entry.id === custom.id)!;
    expect(restored.rootFolders.map((root) => root.path)).toEqual(["/repo/persisted", "/repo/extra"]);
    expect(restored.pinnedSessionIds).toEqual(["ssh-a"]);
  });

  it("repairs corrupt storage with a fresh default workspace", () => {
    window.localStorage.setItem(PLATFORM_WORKSPACES_STORAGE_KEY, "{not-json");
    const reread = readPersistedPlatformState();
    expect(reread.workspaces).toHaveLength(1);
    expect(reread.workspaces[0].id).toBe(DEFAULT_WORKSPACE_ID);
    expect(reread.activeWorkspaceId).toBe(DEFAULT_WORKSPACE_ID);
  });
});
