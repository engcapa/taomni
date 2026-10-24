import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WORKSPACE_ID,
  PLATFORM_WORKSPACES_STORAGE_KEY,
  useWorkspacePlatformStore,
} from "../workspacePlatformStore";
import { useAppStore } from "../appStore";
import type { SessionConfig } from "../../lib/ipc";
import type { Tab } from "../../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "workspace_create_file" || command === "workspace_create_dir") {
      return { path: "stub" };
    }
    return undefined;
  }),
}));

function readStoredWorkspaces() {
  const raw = window.localStorage.getItem(PLATFORM_WORKSPACES_STORAGE_KEY);
  return raw ? JSON.parse(raw) as ReturnType<typeof useWorkspacePlatformStore.getState>["workspaces"] : [];
}

function makeSession(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    id: "ssh-prod-01",
    name: "prod-api-01",
    session_type: "SSH",
    group_path: null,
    host: "10.0.0.8",
    port: 22,
    username: "root",
    auth_method: "None",
    options_json: "{}",
    created_at: 0,
    updated_at: 0,
    last_connected_at: null,
    sort_order: 0,
    ...overrides,
  };
}

describe("workspacePlatformStore (TASK-01)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWorkspacePlatformStore.getState().resetForTests();
  });

  it("UT-WS-01-01: bootstraps the undeletable Default Workspace on empty storage", () => {
    window.localStorage.removeItem(PLATFORM_WORKSPACES_STORAGE_KEY);
    // Simulate a fresh module init by re-reading persistence through the store reset.
    useWorkspacePlatformStore.getState().resetForTests();
    const { workspaces } = useWorkspacePlatformStore.getState();
    expect(workspaces.length).toBeGreaterThanOrEqual(1);
    expect(workspaces[0].id).toBe(DEFAULT_WORKSPACE_ID);
    expect(workspaces[0].isDefault).toBe(true);
    expect(workspaces[0].name).toContain("Default Workspace");
  });

  it("UT-WS-01-02: rejects deleting the default workspace and falls back to it", () => {
    expect(useWorkspacePlatformStore.getState().deleteWorkspace(DEFAULT_WORKSPACE_ID)).toBe(false);
    expect(useWorkspacePlatformStore.getState().workspaces.some((ws) => ws.id === DEFAULT_WORKSPACE_ID)).toBe(true);

    const custom = useWorkspacePlatformStore.getState().createWorkspace("custom");
    expect(useWorkspacePlatformStore.getState().activeWorkspaceId).toBe(custom.id);
    expect(useWorkspacePlatformStore.getState().deleteWorkspace(custom.id)).toBe(true);
    expect(useWorkspacePlatformStore.getState().activeWorkspaceId).toBe(DEFAULT_WORKSPACE_ID);
    expect(useWorkspacePlatformStore.getState().workspaces.some((ws) => ws.id === custom.id)).toBe(false);
  });

  it("UT-WS-01-03: adds and dedupes multi-root folders, removing only the reference", () => {
    const store = useWorkspacePlatformStore.getState();
    store.addRootFolder(DEFAULT_WORKSPACE_ID, { path: "/repo/a", name: "a" });
    store.addRootFolder(DEFAULT_WORKSPACE_ID, { path: "/repo/b" });
    store.addRootFolder(DEFAULT_WORKSPACE_ID, { path: "/repo/a", name: "duplicate" });

    let workspace = useWorkspacePlatformStore.getState().workspaces[0];
    expect(workspace.rootFolders.map((root) => root.path)).toEqual(["/repo/a", "/repo/b"]);

    const rootId = workspace.rootFolders[0].id;
    useWorkspacePlatformStore.getState().removeRootFolder(DEFAULT_WORKSPACE_ID, rootId);
    workspace = useWorkspacePlatformStore.getState().workspaces[0];
    expect(workspace.rootFolders.map((root) => root.path)).toEqual(["/repo/b"]);
    // The persisted registry mirrors the in-memory state.
    expect(readStoredWorkspaces()[0].rootFolders).toHaveLength(1);
  });

  it("UT-WS-01-04: creates files/folders through the FS bridge and opens new files", async () => {
    const store = useWorkspacePlatformStore.getState();
    const root = store.addRootFolder(DEFAULT_WORKSPACE_ID, { path: "/repo/taomni" });
    expect(root).not.toBeNull();

    const fileTab = await useWorkspacePlatformStore.getState().createFileInWorkspace(DEFAULT_WORKSPACE_ID, root!.id, "src/index.ts");
    expect(fileTab?.kind).toBe("file");
    expect(fileTab?.filePath).toContain("src/index.ts");
    const workspace = useWorkspacePlatformStore.getState().workspaces[0];
    expect(workspace.openTabs.some((tab) => tab.id === fileTab!.id)).toBe(true);
    expect(workspace.activeTabId).toBe(fileTab!.id);

    const folderOk = await useWorkspacePlatformStore.getState().createFolderInWorkspace(DEFAULT_WORKSPACE_ID, root!.id, "src/utils");
    expect(folderOk).toBe(true);
  });

  it("UT-WS-01-05: opens an unpinned global session without polluting pinnedSessionIds", () => {
    const session = makeSession({ id: "global-mysql-01", session_type: "MySQL" });
    const tab = useWorkspacePlatformStore.getState().openSessionInWorkspace(DEFAULT_WORKSPACE_ID, session, { pinToWorkspace: false });
    const workspace = useWorkspacePlatformStore.getState().workspaces[0];
    expect(workspace.openTabs.some((entry) => entry.id === tab.id && entry.sessionId === "global-mysql-01")).toBe(true);
    expect(workspace.pinnedSessionIds).not.toContain("global-mysql-01");
    expect(tab.id.startsWith(`ws:${DEFAULT_WORKSPACE_ID}:sess:global-mysql-01`)).toBe(true);
  });

  it("UT-WS-01-06: pinToWorkspace promotes the session into the pinned list", () => {
    const session = makeSession({ id: "global-mysql-02" });
    useWorkspacePlatformStore.getState().openSessionInWorkspace(DEFAULT_WORKSPACE_ID, session, { pinToWorkspace: true });
    const workspace = useWorkspacePlatformStore.getState().workspaces[0];
    expect(workspace.pinnedSessionIds).toContain("global-mysql-02");
  });

  it("UT-WS-01-07: workspace session instances stay isolated from appStore tabs", () => {
    const session = makeSession();
    // Sessions mode opens a global terminal tab.
    const globalTab: Tab = {
      id: `ssh-${session.id}-1`,
      type: "terminal",
      title: session.name,
      sessionId: session.id,
      closable: true,
    };
    useAppStore.getState().addTab(globalTab);
    const globalTabId = globalTab.id;

    // Workspaces mode opens the same session config independently.
    const wsTab = useWorkspacePlatformStore.getState().openSessionInWorkspace(DEFAULT_WORKSPACE_ID, session);
    expect(wsTab.id).not.toBe(globalTabId);

    // Closing the workspace tab never touches the global tab.
    useWorkspacePlatformStore.getState().closeWorkspaceTab(DEFAULT_WORKSPACE_ID, wsTab.id);
    expect(useAppStore.getState().tabs.some((tab) => tab.id === globalTabId)).toBe(true);
    expect(useWorkspacePlatformStore.getState().workspaces[0].openTabs).toHaveLength(0);

    // And closing the global tab never touches workspace tabs.
    const wsTab2 = useWorkspacePlatformStore.getState().openSessionInWorkspace(DEFAULT_WORKSPACE_ID, session);
    useAppStore.getState().removeTab(globalTabId);
    expect(useWorkspacePlatformStore.getState().workspaces[0].openTabs.some((tab) => tab.id === wsTab2.id)).toBe(true);
    expect(useAppStore.getState().tabs.some((tab) => tab.id === globalTabId)).toBe(false);
  });

  it("UT-WS-01-08: manages the floating MFA window state with viewport clamping", () => {
    const app = useAppStore.getState();
    expect(app.floatingMfa.position).toEqual({ left: 50, bottom: 30 });
    expect(app.floatingMfa.open).toBe(false);

    useAppStore.getState().toggleFloatingMfa();
    expect(useAppStore.getState().floatingMfa.open).toBe(true);

    window.innerWidth = 800;
    window.innerHeight = 600;
    useAppStore.getState().setFloatingMfaPosition(200, 120);
    expect(useAppStore.getState().floatingMfa.position).toEqual({ left: 200, bottom: 120 });
    // Out-of-range coordinates clamp back inside the viewport.
    useAppStore.getState().setFloatingMfaPosition(5000, -40);
    const clamped = useAppStore.getState().floatingMfa.position;
    expect(clamped.left).toBeLessThanOrEqual(window.innerWidth);
    expect(clamped.bottom).toBeGreaterThanOrEqual(0);

    useAppStore.getState().setFloatingMfaPinned(true);
    expect(useAppStore.getState().floatingMfa.pinned).toBe(true);
    useAppStore.getState().setFloatingMfaSearchQuery("github");
    expect(useAppStore.getState().floatingMfa.searchQuery).toBe("github");
  });

  it("UT-WS-01-09: persistence keeps editor/Git tabs only and never writes credentials", () => {
    const session = makeSession();
    useWorkspacePlatformStore.getState().openSessionInWorkspace(DEFAULT_WORKSPACE_ID, {
      session,
      kind: "sftp",
      title: "prod sftp",
      sftp: {
        sessionId: "ws-sftp-runtime-1",
        host: session.host,
        port: session.port,
        username: "root",
        authMethod: "Password",
        authData: "vault:prod",
        networkSettingsJson: JSON.stringify({ proxyPass: "proxy-secret", jumpPassword: "jump-secret" }),
        attachedToTerminal: false,
      },
    });
    useWorkspacePlatformStore.getState().openWorkspaceFileTab(DEFAULT_WORKSPACE_ID, "/repo/src/a.ts");
    useWorkspacePlatformStore.getState().openGitPanel(DEFAULT_WORKSPACE_ID);

    const stored = readStoredWorkspaces()[0];
    expect(stored.openTabs.map((tab) => tab.kind).sort()).toEqual(["file", "git"]);
    const serialized = window.localStorage.getItem(PLATFORM_WORKSPACES_STORAGE_KEY) ?? "";
    expect(serialized).not.toContain("proxy-secret");
    expect(serialized).not.toContain("jump-secret");
    expect(serialized).not.toContain("\"sftp\"");
  });

  it("UT-WS-01-10: a restored registry drops session tabs and repairs the active tab", async () => {
    const sessionTab = {
      id: "ws:default-workspace:sess:ssh-1",
      workspaceId: DEFAULT_WORKSPACE_ID,
      kind: "terminal",
      title: "prod",
      closable: true,
      sessionId: "ssh-1",
      ssh: { sessionId: "ssh-1", host: "10.0.0.8", port: 22, username: "root", authMethod: "None", authData: null, optionsJson: "{}" },
    };
    const fileTab = {
      id: "ws:default-workspace:file-1",
      workspaceId: DEFAULT_WORKSPACE_ID,
      kind: "file",
      title: "a.ts",
      closable: true,
      filePath: "/repo/a.ts",
    };
    window.localStorage.setItem(PLATFORM_WORKSPACES_STORAGE_KEY, JSON.stringify([{
      id: DEFAULT_WORKSPACE_ID,
      name: "Default Workspace",
      description: "",
      isDefault: true,
      rootFolders: [],
      pinnedSessionIds: [],
      activeLeftToolWindow: "project",
      bottomDock: { open: false, activeTool: "terminal", heightPx: 165 },
      openTabs: [sessionTab, fileTab],
      activeTabId: sessionTab.id,
    }]));

    vi.resetModules();
    const reloaded = await import("../workspacePlatformStore");
    const workspace = reloaded.useWorkspacePlatformStore.getState().workspaces[0];
    expect(workspace.openTabs.map((tab) => tab.id)).toEqual([fileTab.id]);
    expect(workspace.activeTabId).toBe(fileTab.id);
    const serialized = window.localStorage.getItem(PLATFORM_WORKSPACES_STORAGE_KEY) ?? "";
    expect(serialized).not.toContain("\"ssh\"");
    expect(serialized).not.toContain(sessionTab.id);
  });

  it("UT-WS-01-11: openGitPanel reuses one Git tab and updates the focused path", () => {
    const first = useWorkspacePlatformStore.getState().openGitPanel(DEFAULT_WORKSPACE_ID, "/repo/a.ts");
    const second = useWorkspacePlatformStore.getState().openGitPanel(DEFAULT_WORKSPACE_ID, "/repo/b.ts");
    const gitTabs = useWorkspacePlatformStore.getState().workspaces[0].openTabs.filter((tab) => tab.kind === "git");
    expect(gitTabs).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(gitTabs[0].focusPath).toBe("/repo/b.ts");
  });

  it("UT-WS-01-12: Alt+Insert file requests are consumed once", () => {
    const app = useWorkspacePlatformStore.getState();
    app.requestNewFile();
    expect(useWorkspacePlatformStore.getState().newFileRequest).toBe(1);
    useWorkspacePlatformStore.getState().consumeNewFileRequest();
    expect(useWorkspacePlatformStore.getState().newFileRequest).toBe(0);
  });
});
