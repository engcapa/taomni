import { create } from "zustand";
import { type SessionConfig } from "../lib/ipc";
import { workspaceCreateDir, workspaceCreateFile } from "../lib/editor/workspace/resources";
import type { TerminalProfile } from "../lib/terminalProfile";
import type { SshConnectInfo } from "../components/terminal/TerminalPanel";
import type {
  CommandTerminalConnectInfo,
  DbConnectInfo,
  HBaseConnectInfo,
  LocalShellSelection,
  RdpConnectInfo,
  SftpTabInfo,
  VncConnectInfo,
} from "../types";

/** localStorage persistence key for the platform workspace registry. */
export const PLATFORM_WORKSPACES_STORAGE_KEY = "taomni.platformWorkspaces.v1";

/** Reserved id of the undeletable default workspace. */
export const DEFAULT_WORKSPACE_ID = "default-workspace";

export interface WorkspaceRootFolder {
  id: string;
  name: string;
  path: string;
  addedAt: number;
}

export type WorkspaceTabKind =
  | "file"
  | "git"
  | "terminal"
  | "sftp"
  | "database"
  | "redis"
  | "hbase-shell"
  | "rdp"
  | "vnc";

export type WorkspaceLeftToolWindow = "project" | "sessions" | "structure";

export interface WorkspaceIsolatedTab {
  /** Unique runtime id: `ws:${workspaceId}:${kind}:${suffix}` — never enters appStore.tabs. */
  id: string;
  workspaceId: string;
  kind: WorkspaceTabKind;
  title: string;
  closable: boolean;
  filePath?: string;
  rootFolderId?: string;
  sessionId?: string;
  protocol?: string;
  /** Connection payloads for session tabs; plain JSON so tabs survive reload. */
  ssh?: SshConnectInfo;
  commandTerminal?: CommandTerminalConnectInfo;
  localShell?: LocalShellSelection;
  terminalProfile?: TerminalProfile;
  sftp?: SftpTabInfo;
  db?: DbConnectInfo;
  hbase?: HBaseConnectInfo;
  vnc?: VncConnectInfo;
  rdp?: RdpConnectInfo;
}

/** A session launch prepared by the layout layer (auth resolved, payloads built). */
export interface WorkspaceSessionLaunch {
  session: SessionConfig;
  kind?: WorkspaceTabKind;
  title?: string;
  ssh?: SshConnectInfo;
  commandTerminal?: CommandTerminalConnectInfo;
  localShell?: LocalShellSelection;
  terminalProfile?: TerminalProfile;
  sftp?: SftpTabInfo;
  db?: DbConnectInfo;
  hbase?: HBaseConnectInfo;
  vnc?: VncConnectInfo;
  rdp?: RdpConnectInfo;
}

export interface PlatformWorkspace {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  rootFolders: WorkspaceRootFolder[];
  pinnedSessionIds: string[];
  activeLeftToolWindow: WorkspaceLeftToolWindow;
  bottomDock: {
    open: boolean;
    activeTool: string;
    heightPx: number;
  };
  openTabs: WorkspaceIsolatedTab[];
  activeTabId: string;
}

interface WorkspacePlatformState {
  workspaces: PlatformWorkspace[];
  activeWorkspaceId: string;
  /** Ctrl+Alt+O "open any session" picker visibility (session state). */
  sessionPickerOpen: boolean;
  setSessionPickerOpen: (open: boolean) => void;
  createWorkspace: (name: string) => PlatformWorkspace;
  deleteWorkspace: (id: string) => boolean;
  renameWorkspace: (id: string, name: string) => void;
  setActiveWorkspace: (id: string) => void;
  addRootFolder: (workspaceId: string, folder: { path: string; name?: string }) => WorkspaceRootFolder | null;
  removeRootFolder: (workspaceId: string, rootId: string) => void;
  createFileInWorkspace: (workspaceId: string, rootId: string, relativePath: string) => Promise<WorkspaceIsolatedTab | null>;
  createFolderInWorkspace: (workspaceId: string, rootId: string, relativePath: string) => Promise<boolean>;
  openWorkspaceFileTab: (workspaceId: string, filePath: string, title?: string) => WorkspaceIsolatedTab;
  openGitPanel: (workspaceId: string) => WorkspaceIsolatedTab;
  /** Open a default-shell local terminal as an isolated workspace tab. */
  openLocalTerminalInWorkspace: (workspaceId: string, title?: string) => WorkspaceIsolatedTab;
  openSessionInWorkspace: (
    workspaceId: string,
    launch: SessionConfig | WorkspaceSessionLaunch,
    options?: { pinToWorkspace?: boolean },
  ) => WorkspaceIsolatedTab;
  closeWorkspaceTab: (workspaceId: string, tabId: string) => void;
  setActiveWorkspaceTab: (workspaceId: string, tabId: string) => void;
  setLeftToolWindow: (workspaceId: string, tool: WorkspaceLeftToolWindow) => void;
  togglePinSession: (workspaceId: string, sessionId: string) => void;
  resetForTests: () => void;
}

const BOTTOM_DOCK_TOOLS = ["terminal", "problems", "run", "find", "bookmarks", "todo", "services", "database"] as const;

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createDefaultWorkspace(): PlatformWorkspace {
  return {
    id: DEFAULT_WORKSPACE_ID,
    name: "Default Workspace",
    description: "Default workspace",
    isDefault: true,
    rootFolders: [],
    pinnedSessionIds: [],
    activeLeftToolWindow: "project",
    bottomDock: { open: false, activeTool: "terminal", heightPx: 165 },
    openTabs: [],
    activeTabId: "",
  };
}

function sanitizeWorkspace(raw: unknown): PlatformWorkspace | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<PlatformWorkspace>;
  if (typeof candidate.id !== "string" || typeof candidate.name !== "string") return null;
  return {
    id: candidate.id,
    name: candidate.name,
    description: typeof candidate.description === "string" ? candidate.description : "",
    isDefault: candidate.isDefault === true || candidate.id === DEFAULT_WORKSPACE_ID,
    rootFolders: Array.isArray(candidate.rootFolders)
      ? candidate.rootFolders.filter((folder): folder is WorkspaceRootFolder =>
        !!folder && typeof (folder as WorkspaceRootFolder).path === "string")
      : [],
    pinnedSessionIds: Array.isArray(candidate.pinnedSessionIds)
      ? candidate.pinnedSessionIds.filter((id): id is string => typeof id === "string")
      : [],
    activeLeftToolWindow: candidate.activeLeftToolWindow === "sessions" || candidate.activeLeftToolWindow === "structure"
      ? candidate.activeLeftToolWindow
      : "project",
    bottomDock: {
      open: candidate.bottomDock?.open === true,
      activeTool: BOTTOM_DOCK_TOOLS.includes(candidate.bottomDock?.activeTool as never)
        ? (candidate.bottomDock?.activeTool as string)
        : "terminal",
      heightPx: typeof candidate.bottomDock?.heightPx === "number" ? candidate.bottomDock.heightPx : 165,
    },
    openTabs: Array.isArray(candidate.openTabs)
      ? candidate.openTabs.filter((tab): tab is WorkspaceIsolatedTab => !!tab && typeof (tab as WorkspaceIsolatedTab).id === "string")
      : [],
    activeTabId: typeof candidate.activeTabId === "string" ? candidate.activeTabId : "",
  };
}

function loadPersisted(): PlatformWorkspace[] {
  if (typeof window === "undefined") return [createDefaultWorkspace()];
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(PLATFORM_WORKSPACES_STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (!raw) return [createDefaultWorkspace()];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [createDefaultWorkspace()];
    const workspaces = parsed
      .map(sanitizeWorkspace)
      .filter((workspace): workspace is PlatformWorkspace => workspace !== null);
    if (workspaces.length === 0) return [createDefaultWorkspace()];
    if (!workspaces.some((workspace) => workspace.id === DEFAULT_WORKSPACE_ID)) {
      workspaces.unshift(createDefaultWorkspace());
    }
    return workspaces;
  } catch {
    // Corrupt payload falls back to the guaranteed default workspace.
    return [createDefaultWorkspace()];
  }
}

function persist(workspaces: PlatformWorkspace[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PLATFORM_WORKSPACES_STORAGE_KEY, JSON.stringify(workspaces));
  } catch {
    // Storage quota or privacy mode: keep the in-memory state authoritative.
  }
}

function normalizeRelativeSegments(relativePath: string): string[] {
  return relativePath.replace(/\\/g, "/").split("/").map((part) => part.trim()).filter((part) => part.length > 0 && part !== ".");
}

function joinWorkspacePathValue(rootPath: string, relative: string): string {
  const cleanRoot = rootPath.replace(/[\\/]+$/, "");
  return `${cleanRoot}/${relative.replace(/^[\\/]+/, "")}`;
}

/**
 * Best-effort `mkdir -p` for workspace-relative parent chains: the browser
 * VFS requires every parent to exist before a write, and a freshly added
 * root folder may not exist there yet. Errors (already exists, native root
 * present) are swallowed - the following file write surfaces real failures.
 */
async function ensureWorkspaceDirectories(rootPath: string, segments: string[]): Promise<void> {
  try {
    await workspaceCreateDir(rootPath, "");
  } catch {
    // Root already exists (or cannot be created) - proceed.
  }
  for (let index = 0; index < segments.length; index += 1) {
    try {
      await workspaceCreateDir(rootPath, segments.slice(0, index + 1).join("/"));
    } catch {
      // Segment already exists - continue with the next one.
    }
  }
}

function sessionKind(session: SessionConfig): WorkspaceTabKind {
  switch (session.session_type) {
    case "Sftp": return "sftp";
    case "Database": return "database";
    case "Redis": return "redis";
    case "HBase": return "hbase-shell";
    case "Rdp": return "rdp";
    case "Vnc": return "vnc";
    default: return "terminal";
  }
}

function updateWorkspace(
  workspaces: PlatformWorkspace[],
  workspaceId: string,
  update: (workspace: PlatformWorkspace) => PlatformWorkspace,
): PlatformWorkspace[] {
  return workspaces.map((workspace) => (workspace.id === workspaceId ? update(workspace) : workspace));
}

export const useWorkspacePlatformStore = create<WorkspacePlatformState>((set, get) => {
  const commit = (mutate: (workspaces: PlatformWorkspace[]) => PlatformWorkspace[]) => {
    set((state) => {
      const workspaces = mutate(state.workspaces);
      persist(workspaces);
      return { workspaces };
    });
  };

  const initial = loadPersisted();
  persist(initial);

  return {
    workspaces: initial,
    activeWorkspaceId: initial.some((workspace) => workspace.isDefault)
      ? (initial.find((workspace) => workspace.isDefault)?.id ?? DEFAULT_WORKSPACE_ID)
      : initial[0].id,
    sessionPickerOpen: false,
    setSessionPickerOpen: (open) => set((state) => (state.sessionPickerOpen === open ? state : { sessionPickerOpen: open })),

    createWorkspace: (name) => {
      const workspace: PlatformWorkspace = {
        ...createDefaultWorkspace(),
        id: makeId("ws"),
        name: name.trim() || `Workspace ${get().workspaces.length}`,
        isDefault: false,
      };
      commit((workspaces) => [...workspaces, workspace]);
      set({ activeWorkspaceId: workspace.id });
      return workspace;
    },

    deleteWorkspace: (id) => {
      const target = get().workspaces.find((workspace) => workspace.id === id);
      if (!target || target.isDefault) return false;
      commit((workspaces) => workspaces.filter((workspace) => workspace.id !== id));
      if (get().activeWorkspaceId === id) set({ activeWorkspaceId: DEFAULT_WORKSPACE_ID });
      return true;
    },

    renameWorkspace: (id, name) => {
      commit((workspaces) => updateWorkspace(workspaces, id, (workspace) => ({ ...workspace, name })));
    },

    setActiveWorkspace: (id) => {
      if (get().workspaces.some((workspace) => workspace.id === id)) {
        set({ activeWorkspaceId: id });
      }
    },

    addRootFolder: (workspaceId, folder) => {
      const path = folder.path.trim();
      if (!path) return null;
      const workspace = get().workspaces.find((item) => item.id === workspaceId);
      if (!workspace) return null;
      const existing = workspace.rootFolders.find((item) => item.path === path);
      if (existing) return existing;
      const root: WorkspaceRootFolder = {
        id: makeId("root"),
        name: folder.name?.trim() || path.split(/[\\/]/).filter(Boolean).pop() || path,
        path,
        addedAt: Date.now(),
      };
      commit((workspaces) => updateWorkspace(workspaces, workspaceId, (item) => ({
        ...item,
        rootFolders: [...item.rootFolders, root],
      })));
      return root;
    },

    removeRootFolder: (workspaceId, rootId) => {
      commit((workspaces) => updateWorkspace(workspaces, workspaceId, (item) => ({
        ...item,
        rootFolders: item.rootFolders.filter((root) => root.id !== rootId),
        openTabs: item.openTabs.filter((tab) => tab.rootFolderId !== rootId),
      })));
    },

    createFileInWorkspace: async (workspaceId, rootId, relativePath) => {
      const workspace = get().workspaces.find((item) => item.id === workspaceId);
      const root = workspace?.rootFolders.find((item) => item.id === rootId);
      if (!workspace || !root) return null;
      const segments = normalizeRelativeSegments(relativePath);
      const fileName = segments.pop();
      if (!fileName) return null;
      try {
        await ensureWorkspaceDirectories(root.path, segments);
        const relative = segments.length > 0 ? `${segments.join("/")}/${fileName}` : fileName;
        await workspaceCreateFile(root.path, relative);
        const filePath = joinWorkspacePathValue(root.path, relative);
        return get().openWorkspaceFileTab(workspaceId, filePath, fileName);
      } catch {
        return null;
      }
    },

    createFolderInWorkspace: async (workspaceId, rootId, relativePath) => {
      const workspace = get().workspaces.find((item) => item.id === workspaceId);
      const root = workspace?.rootFolders.find((item) => item.id === rootId);
      if (!workspace || !root) return false;
      const segments = normalizeRelativeSegments(relativePath);
      if (segments.length === 0) return false;
      try {
        await ensureWorkspaceDirectories(root.path, segments.slice(0, -1));
        await workspaceCreateDir(root.path, segments.join("/"));
        return true;
      } catch {
        return false;
      }
    },
    openWorkspaceFileTab: (workspaceId, filePath, title) => {
      const existing = get().workspaces
        .find((item) => item.id === workspaceId)
        ?.openTabs.find((tab) => tab.kind === "file" && tab.filePath === filePath);
      if (existing) {
        get().setActiveWorkspaceTab(workspaceId, existing.id);
        return existing;
      }
      const workspace = get().workspaces.find((item) => item.id === workspaceId);
      const rootFolderId = workspace?.rootFolders.find((root) => filePath.startsWith(root.path))?.id;
      const tab: WorkspaceIsolatedTab = {
        id: makeId(`ws:${workspaceId}:file`),
        workspaceId,
        kind: "file",
        title: title ?? filePath.split(/[\\/]/).pop() ?? filePath,
        closable: true,
        filePath,
        rootFolderId,
      };
      commit((workspaces) => updateWorkspace(workspaces, workspaceId, (item) => ({
        ...item,
        openTabs: [...item.openTabs, tab],
        activeTabId: tab.id,
      })));
      return tab;
    },

    openGitPanel: (workspaceId) => {
      const existing = get().workspaces
        .find((item) => item.id === workspaceId)
        ?.openTabs.find((tab) => tab.kind === "git");
      if (existing) {
        get().setActiveWorkspaceTab(workspaceId, existing.id);
        return existing;
      }
      const tab: WorkspaceIsolatedTab = {
        id: makeId(`ws:${workspaceId}:git`),
        workspaceId,
        kind: "git",
        title: "Git",
        closable: true,
      };
      commit((workspaces) => updateWorkspace(workspaces, workspaceId, (item) => ({
        ...item,
        openTabs: [...item.openTabs, tab],
        activeTabId: tab.id,
      })));
      return tab;
    },

    openLocalTerminalInWorkspace: (workspaceId, title) => {
      const tab: WorkspaceIsolatedTab = {
        id: makeId(`ws:${workspaceId}:local`),
        workspaceId,
        kind: "terminal",
        title: title ?? "Local",
        closable: true,
      };
      commit((workspaces) => updateWorkspace(workspaces, workspaceId, (item) => ({
        ...item,
        openTabs: [...item.openTabs, tab],
        activeTabId: tab.id,
      })));
      return tab;
    },

    openSessionInWorkspace: (workspaceId, launch, options) => {
      const session = "session" in launch ? launch.session : launch;
      const kind = "kind" in launch && launch.kind ? launch.kind : sessionKind(session);
      const title = "title" in launch && launch.title ? launch.title : (session.name || session.host || session.id);
      const tab: WorkspaceIsolatedTab = {
        id: makeId(`ws:${workspaceId}:sess:${session.id}`),
        workspaceId,
        kind,
        title,
        closable: true,
        sessionId: session.id,
        protocol: session.session_type,
      };
      if ("session" in launch) {
        const payload = launch;
        tab.ssh = payload.ssh;
        tab.commandTerminal = payload.commandTerminal;
        tab.localShell = payload.localShell;
        tab.terminalProfile = payload.terminalProfile;
        tab.sftp = payload.sftp;
        tab.db = payload.db;
        tab.hbase = payload.hbase;
        tab.vnc = payload.vnc;
        tab.rdp = payload.rdp;
      }
      commit((workspaces) => updateWorkspace(workspaces, workspaceId, (item) => ({
        ...item,
        openTabs: [...item.openTabs, tab],
        activeTabId: tab.id,
        pinnedSessionIds: options?.pinToWorkspace && !item.pinnedSessionIds.includes(session.id)
          ? [...item.pinnedSessionIds, session.id]
          : item.pinnedSessionIds,
      })));
      return tab;
    },

    closeWorkspaceTab: (workspaceId, tabId) => {
      commit((workspaces) => updateWorkspace(workspaces, workspaceId, (item) => {
        const openTabs = item.openTabs.filter((tab) => tab.id !== tabId);
        const activeTabId = item.activeTabId === tabId
          ? (openTabs[openTabs.length - 1]?.id ?? "")
          : item.activeTabId;
        return { ...item, openTabs, activeTabId };
      }));
    },

    setActiveWorkspaceTab: (workspaceId, tabId) => {
      commit((workspaces) => updateWorkspace(workspaces, workspaceId, (item) => ({ ...item, activeTabId: tabId })));
    },

    setLeftToolWindow: (workspaceId, tool) => {
      commit((workspaces) => updateWorkspace(workspaces, workspaceId, (item) => ({
        ...item,
        activeLeftToolWindow: tool,
      })));
    },

    togglePinSession: (workspaceId, sessionId) => {
      commit((workspaces) => updateWorkspace(workspaces, workspaceId, (item) => ({
        ...item,
        pinnedSessionIds: item.pinnedSessionIds.includes(sessionId)
          ? item.pinnedSessionIds.filter((id) => id !== sessionId)
          : [...item.pinnedSessionIds, sessionId],
      })));
    },

    resetForTests: () => {
      const fresh = [createDefaultWorkspace()];
      persist(fresh);
      set({ workspaces: fresh, activeWorkspaceId: DEFAULT_WORKSPACE_ID });
    },
  };
});

export function selectActiveWorkspace(state: WorkspacePlatformState): PlatformWorkspace | null {
  return state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ?? null;
}
