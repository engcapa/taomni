/**
 * Workspace-first platform state (v6.1 TASK-01).
 *
 * A platform workspace is the top-level project container of the Workspaces
 * mode: it owns several local root folders (multi-root), the global sessions a
 * user pinned as "★ frequently used in this workspace", and its own isolated
 * tab list. Workspace tabs never touch `appStore.tabs`; the same saved session
 * can therefore run in Workspaces mode and in Sessions mode at the same time
 * with independent runtime instances.
 */
import { create } from "zustand";
import type { SessionConfig } from "../lib/ipc/session";
import { createWorkspaceTabActions } from "./workspacePlatformTabActions";
import { createWorkspaceCodeActions } from "./workspacePlatformCodeActions";
import type { CodeWorkspaceTabInfo } from "../types";
import { cancelWorkspacePlatformPersistence, observeWorkspacePlatformStorage, persistWorkspacePlatformMetadata as persist, PLATFORM_WORKSPACES_STORAGE_KEY } from "./workspacePlatformPersistence";

export { PLATFORM_WORKSPACES_STORAGE_KEY };
export const DEFAULT_WORKSPACE_ID = "default-workspace";
export const DEFAULT_WORKSPACE_NAME = "Default Workspace (默认工作区)";

export interface WorkspaceRootFolder {
  id: string;
  name: string;
  path: string;
  addedAt: number;
}

export type WorkspaceTabKind =
  | "file"
  | "git"
  | "code"
  | "terminal"
  | "sftp"
  | "database"
  | "rdp"
  | "vnc"
  | "session";

export interface WorkspaceIsolatedTab {
  /** Runtime instance id: `ws:${workspaceId}:${kind}:${uuid}`. */
  id: string;
  workspaceId: string;
  kind: WorkspaceTabKind;
  title: string;
  closable: boolean;
  /** `kind === "file"` payload. */
  filePath?: string;
  rootFolderId?: string;
  /** Source `SessionConfig` id for session kinds (any global session). */
  sessionId?: string;
  protocol?: string;
  /** Runtime connection facts kept per workspace tab (never shared with app tabs). */
  host?: string;
  port?: number;
  username?: string | null;
  sessionType?: string;
  /** Git tab: path to focus when opened from the editor. */
  focusPath?: string;
  createdAt: number;
  /** One-shot working directory for an independent duplicate terminal. */
  terminalInitialCwd?: string;
}

export type WorkspaceToolWindow = "project" | "sessions" | "structure";

export type WorkspaceBottomTool =
  | "terminal"
  | "problems"
  | "run"
  | "find"
  | "bookmarks"
  | "todo"
  | "services"
  | "database";

export interface WorkspaceBottomDock {
  open: boolean;
  activeTool: WorkspaceBottomTool;
  heightPx: number;
}

export interface PlatformWorkspace {
  id: string;
  name: string;
  description: string;
  /** The default workspace always exists and cannot be deleted. */
  isDefault: boolean;
  rootFolders: WorkspaceRootFolder[];
  /** "★ frequently used in this workspace" global session ids (shortcut only). */
  pinnedSessionIds: string[];
  activeLeftToolWindow: WorkspaceToolWindow;
  bottomDock: WorkspaceBottomDock;
  openTabs: WorkspaceIsolatedTab[];
  activeTabId: string;
  /** IDEA project definition and stable recovery identity, including loose files. */
  codeWorkspace?: CodeWorkspaceTabInfo;
}

export type WorkspaceTreeNodeKind = "file" | "folder";

/** Node created from the app itself; merged into the live directory listing. */
export interface WorkspaceTreeNode {
  id: string;
  workspaceId: string;
  rootFolderId: string;
  path: string;
  name: string;
  kind: WorkspaceTreeNodeKind;
  addedAt: number;
}

export interface CreateWorkspaceOptions {
  name: string;
  description?: string;
  rootPath?: string;
  codeWorkspace?: CodeWorkspaceTabInfo;
}

export interface OpenWorkspaceSessionOptions {
  pinToWorkspace?: boolean;
  activate?: boolean;
}

export interface WorkspacePlatformState {
  workspaces: PlatformWorkspace[];
  activeWorkspaceId: string;
  /** Locally created file/folder nodes (merged with the live FS listing). */
  createdNodes: WorkspaceTreeNode[];
  /** Re-read persisted state (used by tests and cross-window updates). */
  reloadFromStorage: () => void;
  getWorkspace: (workspaceId?: string) => PlatformWorkspace | undefined;
  createWorkspace: (options: CreateWorkspaceOptions) => PlatformWorkspace;
  deleteWorkspace: (workspaceId: string) => boolean;
  setActiveWorkspace: (workspaceId: string) => void;
  renameWorkspace: (workspaceId: string, name: string) => void;
  addRootFolder: (workspaceId: string, folder: { path: string; name?: string }) => WorkspaceRootFolder | null;
  removeRootFolder: (workspaceId: string, rootId: string) => void;
  createFileInWorkspace: (workspaceId: string, rootId: string, path: string) => WorkspaceIsolatedTab | null;
  createFolderInWorkspace: (workspaceId: string, rootId: string, path: string) => WorkspaceTreeNode | null;
  addCreatedNode: (node: Omit<WorkspaceTreeNode, "id" | "addedAt">) => WorkspaceTreeNode;
  removeCreatedNode: (workspaceId: string, rootFolderId: string, path: string) => void;
  openFileInWorkspace: (workspaceId: string, file: { rootId: string; path: string; name?: string }) => WorkspaceIsolatedTab;
  openGitTab: (workspaceId: string, focusPath?: string) => WorkspaceIsolatedTab;
  openCodeWorkspaceTab: (workspaceId: string) => WorkspaceIsolatedTab;
  updateCodeWorkspace: (workspaceId: string, info: CodeWorkspaceTabInfo) => void;
  openLocalTerminalInWorkspace: (workspaceId: string) => WorkspaceIsolatedTab;
  openSessionInWorkspace: (
    workspaceId: string,
    session: SessionConfig,
    options?: OpenWorkspaceSessionOptions,
  ) => WorkspaceIsolatedTab;
  pinSession: (workspaceId: string, sessionId: string) => void;
  unpinSession: (workspaceId: string, sessionId: string) => void;
  togglePinSession: (workspaceId: string, sessionId: string) => void;
  closeWorkspaceTab: (workspaceId: string, tabId: string) => void;
  renameWorkspaceTab: (workspaceId: string, tabId: string, title: string) => void;
  moveWorkspaceTab: (workspaceId: string, tabId: string, index: number) => void;
  duplicateWorkspaceTab: (workspaceId: string, tabId: string, cwd?: string) => WorkspaceIsolatedTab | null;
  setActiveWorkspaceTab: (workspaceId: string, tabId: string) => void;
  syncWorkspaceFiles: (workspaceId: string, files: Array<{ rootId: string; path: string }>, active?: { rootId: string; path: string } | null) => void;
  setActiveLeftToolWindow: (workspaceId: string, toolWindow: WorkspaceToolWindow) => void;
  setBottomDockOpen: (workspaceId: string, open: boolean) => void;
  setBottomDockTool: (workspaceId: string, tool: WorkspaceBottomTool) => void;
  setBottomDockHeight: (workspaceId: string, heightPx: number) => void;
}

interface PersistedPlatformState {
  version: 1;
  workspaces: PlatformWorkspace[];
  activeWorkspaceId: string;
  createdNodes: WorkspaceTreeNode[];
}

let idCounter = 0;

function newId(prefix: string): string {
  idCounter += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}${idCounter.toString(36)}`;
}

function newRuntimeId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}:${Date.now().toString(36)}${random}`;
}

function emptyDock(): WorkspaceBottomDock {
  return { open: false, activeTool: "terminal", heightPx: 220 };
}

export function createDefaultWorkspace(): PlatformWorkspace {
  return {
    id: DEFAULT_WORKSPACE_ID,
    name: DEFAULT_WORKSPACE_NAME,
    description: "System default workspace",
    isDefault: true,
    rootFolders: [],
    pinnedSessionIds: [],
    activeLeftToolWindow: "project",
    bottomDock: emptyDock(),
    openTabs: [],
    activeTabId: "",
  };
}

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function baseName(path: string): string {
  const normalized = normalizePath(path);
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized;
}

function sessionTabKind(sessionType: string): WorkspaceTabKind {
  const type = sessionType.toUpperCase();
  if (type === "SFTP" || type === "FILE") return "sftp";
  if (type === "RDP") return "rdp";
  if (type === "VNC") return "vnc";
  if (["LOCAL", "LOCALSHELL", "SSH", "TELNET", "RLOGIN", "SERIAL", "MOSH", "FTP"].includes(type)) return "terminal";
  if (["MAIL", "BROWSER", "PROXY", "S3", "AZUREBLOB"].includes(type)) return "session";
  return "database";
}

function isPlatformWorkspace(value: unknown): value is PlatformWorkspace {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PlatformWorkspace>;
  return typeof candidate.id === "string"
    && typeof candidate.name === "string"
    && Array.isArray(candidate.rootFolders)
    && Array.isArray(candidate.openTabs);
}

function normalizeWorkspace(workspace: PlatformWorkspace): PlatformWorkspace {
  const openTabs = (workspace.openTabs ?? []).filter((tab) => tab && typeof tab.id === "string")
    .map((tab) => tab.sessionId && tab.protocol ? { ...tab, kind: sessionTabKind(tab.protocol) } : tab);
  return {
    ...workspace,
    isDefault: workspace.id === DEFAULT_WORKSPACE_ID || workspace.isDefault === true,
    description: workspace.description ?? "",
    pinnedSessionIds: Array.isArray(workspace.pinnedSessionIds) ? workspace.pinnedSessionIds : [],
    activeLeftToolWindow: workspace.activeLeftToolWindow ?? "project",
    bottomDock: {
      ...emptyDock(),
      ...(workspace.bottomDock ?? {}),
    },
    openTabs,
    activeTabId: openTabs.some((tab) => tab.id === workspace.activeTabId) ? workspace.activeTabId : openTabs[0]?.id ?? "",
    rootFolders: (workspace.rootFolders ?? []).filter((folder) => typeof folder?.path === "string"),
  };
}

function ensureDefaultWorkspace(workspaces: PlatformWorkspace[]): PlatformWorkspace[] {
  const rest = workspaces.filter((workspace) => workspace.id !== DEFAULT_WORKSPACE_ID);
  const storedDefault = workspaces.find((workspace) => workspace.id === DEFAULT_WORKSPACE_ID);
  return [storedDefault ? normalizeWorkspace(storedDefault) : createDefaultWorkspace(), ...rest.map(normalizeWorkspace)];
}

export function readPersistedPlatformState(): Pick<PersistedPlatformState, "workspaces" | "activeWorkspaceId" | "createdNodes"> {
  const fallback = { workspaces: [createDefaultWorkspace()], activeWorkspaceId: DEFAULT_WORKSPACE_ID, createdNodes: [] };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(PLATFORM_WORKSPACES_STORAGE_KEY);
    observeWorkspacePlatformStorage(raw);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedPlatformState>;
    const workspaces = Array.isArray(parsed.workspaces) ? parsed.workspaces.filter(isPlatformWorkspace) : [];
    const ensured = ensureDefaultWorkspace(workspaces);
    const activeWorkspaceId = ensured.some((workspace) => workspace.id === parsed.activeWorkspaceId)
      ? String(parsed.activeWorkspaceId)
      : DEFAULT_WORKSPACE_ID;
    const createdNodes = Array.isArray(parsed.createdNodes)
      ? parsed.createdNodes.filter((node) => node && typeof node.path === "string" && typeof node.workspaceId === "string")
      : [];
    return { workspaces: ensured, activeWorkspaceId, createdNodes };
  } catch {
    return fallback;
  }
}

function updateWorkspace(
  workspaces: PlatformWorkspace[],
  workspaceId: string,
  update: (workspace: PlatformWorkspace) => PlatformWorkspace,
): PlatformWorkspace[] {
  return workspaces.map((workspace) => (workspace.id === workspaceId ? update(workspace) : workspace));
}

function upsertTab(workspace: PlatformWorkspace, tab: WorkspaceIsolatedTab, activate: boolean): PlatformWorkspace {
  const existingIndex = workspace.openTabs.findIndex((candidate) => candidate.id === tab.id);
  const openTabs = existingIndex >= 0
    ? workspace.openTabs.map((candidate) => (candidate.id === tab.id ? { ...candidate, ...tab } : candidate))
    : [...workspace.openTabs, tab];
  return {
    ...workspace,
    openTabs,
    activeTabId: activate || !workspace.activeTabId ? tab.id : workspace.activeTabId,
  };
}

function fallbackActiveTabId(tabs: WorkspaceIsolatedTab[]): string {
  return tabs[0]?.id ?? "";
}

const initial = readPersistedPlatformState();

export const useWorkspacePlatformStore = create<WorkspacePlatformState>((set, get) => ({
  workspaces: initial.workspaces,
  activeWorkspaceId: initial.activeWorkspaceId,
  createdNodes: initial.createdNodes,

  reloadFromStorage: () => {
    cancelWorkspacePlatformPersistence();
    const next = readPersistedPlatformState();
    set({ ...next });
  },

  getWorkspace: (workspaceId) => {
    const state = get();
    return state.workspaces.find((workspace) => workspace.id === (workspaceId ?? state.activeWorkspaceId));
  },

  createWorkspace: (options) => {
    const name = options.name.trim() || "Workspace";
    const workspace: PlatformWorkspace = {
      id: newId("ws"),
      name,
      description: options.description ?? "",
      isDefault: false,
      rootFolders: options.codeWorkspace?.roots?.map((root) => ({ ...root, addedAt: Date.now() })) ?? [],
      codeWorkspace: options.codeWorkspace,
      pinnedSessionIds: [],
      activeLeftToolWindow: "project",
      bottomDock: emptyDock(),
      openTabs: [],
      activeTabId: "",
    };
    if (options.rootPath?.trim() && !workspace.rootFolders.length) {
      workspace.rootFolders.push({
        id: newId("root"),
        name: baseName(options.rootPath),
        path: normalizePath(options.rootPath),
        addedAt: Date.now(),
      });
    }
    set((state) => {
      const workspaces = [...state.workspaces, workspace];
      const next = { workspaces, activeWorkspaceId: workspace.id };
      persist({ ...state, ...next });
      return next;
    });
    return workspace;
  },

  deleteWorkspace: (workspaceId) => {
    const state = get();
    const target = state.workspaces.find((workspace) => workspace.id === workspaceId);
    if (!target || target.isDefault || target.id === DEFAULT_WORKSPACE_ID) return false;
    const workspaces = state.workspaces.filter((workspace) => workspace.id !== workspaceId);
    const activeWorkspaceId = state.activeWorkspaceId === workspaceId ? DEFAULT_WORKSPACE_ID : state.activeWorkspaceId;
    const createdNodes = state.createdNodes.filter((node) => node.workspaceId !== workspaceId);
    const next = { workspaces, activeWorkspaceId, createdNodes };
    persist({ ...state, ...next });
    set(next);
    return true;
  },

  setActiveWorkspace: (workspaceId) => {
    if (!get().workspaces.some((workspace) => workspace.id === workspaceId)) return;
    set((state) => {
      const next = { activeWorkspaceId: workspaceId };
      persist({ ...state, ...next });
      return next;
    });
  },

  renameWorkspace: (workspaceId, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    set((state) => {
      const workspaces = updateWorkspace(state.workspaces, workspaceId, (workspace) => ({ ...workspace, name: trimmed }));
      const next = { workspaces };
      persist({ ...state, ...next });
      return next;
    });
  },

  addRootFolder: (workspaceId, folder) => {
    const path = normalizePath(folder.path);
    if (!path) return null;
    const workspace = get().workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) return null;
    const existing = workspace.rootFolders.find((candidate) => normalizePath(candidate.path) === path);
    if (existing) return existing;
    const rootFolder: WorkspaceRootFolder = {
      id: newId("root"),
      name: folder.name?.trim() || baseName(path),
      path,
      addedAt: Date.now(),
    };
    set((state) => {
      const workspaces = updateWorkspace(state.workspaces, workspaceId, (candidate) => ({
        ...candidate,
        rootFolders: [...candidate.rootFolders, rootFolder],
      }));
      const next = { workspaces };
      persist({ ...state, ...next });
      return next;
    });
    return rootFolder;
  },

  removeRootFolder: (workspaceId, rootId) => {
    set((state) => {
      const removedPaths = new Set(
        state.workspaces
          .find((workspace) => workspace.id === workspaceId)
          ?.rootFolders.filter((folder) => folder.id === rootId)
          .map((folder) => `${folder.id}:${normalizePath(folder.path)}`) ?? [],
      );
      const workspaces = updateWorkspace(state.workspaces, workspaceId, (workspace) => {
        const openTabs = workspace.openTabs.filter((tab) => tab.rootFolderId !== rootId);
        return {
          ...workspace,
          rootFolders: workspace.rootFolders.filter((folder) => folder.id !== rootId),
          openTabs,
          activeTabId: openTabs.some((tab) => tab.id === workspace.activeTabId)
            ? workspace.activeTabId
            : fallbackActiveTabId(openTabs),
        };
      });
      const createdNodes = state.createdNodes.filter(
        (node) => node.workspaceId !== workspaceId || !removedPaths.has(`${node.rootFolderId}:${normalizePath(node.path)}`),
      );
      const next = { workspaces, createdNodes };
      persist({ ...state, ...next });
      return next;
    });
  },

  addCreatedNode: (node) => {
    const created: WorkspaceTreeNode = { ...node, id: newId("node"), addedAt: Date.now() };
    set((state) => {
      const createdNodes = [...state.createdNodes, created];
      const next = { createdNodes };
      persist({ ...state, ...next });
      return next;
    });
    return created;
  },

  removeCreatedNode: (workspaceId, rootFolderId, path) => {
    const target = normalizePath(path);
    set((state) => {
      const createdNodes = state.createdNodes.filter((node) => !(
        node.workspaceId === workspaceId
        && node.rootFolderId === rootFolderId
        && normalizePath(node.path) === target
      ));
      const next = { createdNodes };
      persist({ ...state, ...next });
      return next;
    });
  },

  createFileInWorkspace: (workspaceId, rootId, path) => {
    const trimmed = normalizePath(path);
    if (!trimmed) return null;
    const workspace = get().workspaces.find((candidate) => candidate.id === workspaceId);
    const root = workspace?.rootFolders.find((folder) => folder.id === rootId);
    if (!workspace || !root) return null;
    get().addCreatedNode({
      workspaceId,
      rootFolderId: rootId,
      path: trimmed,
      name: baseName(trimmed),
      kind: "file",
    });
    return get().openFileInWorkspace(workspaceId, { rootId, path: trimmed, name: baseName(trimmed) });
  },

  createFolderInWorkspace: (workspaceId, rootId, path) => {
    const trimmed = normalizePath(path);
    if (!trimmed) return null;
    const workspace = get().workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace?.rootFolders.some((folder) => folder.id === rootId)) return null;
    return get().addCreatedNode({
      workspaceId,
      rootFolderId: rootId,
      path: trimmed,
      name: baseName(trimmed),
      kind: "folder",
    });
  },

  openFileInWorkspace: (workspaceId, file) => {
    const tab: WorkspaceIsolatedTab = {
      id: `ws:${workspaceId}:file:${file.rootId}:${normalizePath(file.path)}`,
      workspaceId,
      kind: "file",
      title: file.name || baseName(file.path),
      closable: true,
      filePath: normalizePath(file.path),
      rootFolderId: file.rootId,
      createdAt: Date.now(),
    };
    set((state) => {
      const workspaces = updateWorkspace(state.workspaces, workspaceId, (workspace) => upsertTab(workspace, tab, true));
      const next = { workspaces };
      persist({ ...state, ...next });
      return next;
    });
    return tab;
  },

  openGitTab: (workspaceId, focusPath) => {
    const tab: WorkspaceIsolatedTab = {
      id: `ws:${workspaceId}:git`,
      workspaceId,
      kind: "git",
      title: "GIT",
      closable: true,
      focusPath,
      createdAt: Date.now(),
    };
    set((state) => {
      const workspaces = updateWorkspace(state.workspaces, workspaceId, (workspace) => upsertTab(workspace, tab, true));
      const next = { workspaces };
      persist({ ...state, ...next });
      return next;
    });
    return tab;
  },

  openCodeWorkspaceTab: (workspaceId) => {
    const existing = get().getWorkspace(workspaceId)?.openTabs.find((tab) => tab.kind === "code");
    if (existing) {
      get().setActiveWorkspaceTab(workspaceId, existing.id);
      return existing;
    }
    const tab: WorkspaceIsolatedTab = {
      id: `ws:${workspaceId}:code`,
      workspaceId,
      kind: "code",
      title: "Code Workspace",
      closable: true,
      createdAt: Date.now(),
    };
    set((state) => {
      const workspaces = updateWorkspace(state.workspaces, workspaceId, (workspace) => upsertTab(workspace, tab, true));
      const next = { workspaces };
      persist({ ...state, ...next });
      return next;
    });
    return tab;
  },

  ...createWorkspaceCodeActions(set, persist),

  openLocalTerminalInWorkspace: (workspaceId) => {
    const tab: WorkspaceIsolatedTab = {
      id: newRuntimeId(`ws:${workspaceId}:local`),
      workspaceId,
      kind: "terminal",
      title: "Local Terminal",
      closable: true,
      protocol: "Local",
      createdAt: Date.now(),
    };
    set((state) => {
      const workspaces = updateWorkspace(state.workspaces, workspaceId, (workspace) => upsertTab(workspace, tab, true));
      const next = { workspaces };
      persist({ ...state, ...next });
      return next;
    });
    return tab;
  },

  openSessionInWorkspace: (workspaceId, session, options = {}) => {
    const kind = sessionTabKind(session.session_type);
    const tab: WorkspaceIsolatedTab = {
      id: newRuntimeId(`ws:${workspaceId}:sess:${session.id}`),
      workspaceId,
      kind,
      title: session.name || `${session.username ?? "root"}@${session.host}`,
      closable: true,
      sessionId: session.id,
      protocol: session.session_type,
      sessionType: session.session_type,
      host: session.host,
      port: session.port,
      username: session.username,
      createdAt: Date.now(),
    };
    set((state) => {
      const workspaces = updateWorkspace(state.workspaces, workspaceId, (workspace) => {
        const withTab = upsertTab(workspace, tab, options.activate !== false);
        if (!options.pinToWorkspace) return withTab;
        return {
          ...withTab,
          pinnedSessionIds: withTab.pinnedSessionIds.includes(session.id)
            ? withTab.pinnedSessionIds
            : [...withTab.pinnedSessionIds, session.id],
        };
      });
      const next = { workspaces };
      persist({ ...state, ...next });
      return next;
    });
    return tab;
  },

  pinSession: (workspaceId, sessionId) => {
    set((state) => {
      const workspaces = updateWorkspace(state.workspaces, workspaceId, (workspace) => (
        workspace.pinnedSessionIds.includes(sessionId)
          ? workspace
          : { ...workspace, pinnedSessionIds: [...workspace.pinnedSessionIds, sessionId] }
      ));
      const next = { workspaces };
      persist({ ...state, ...next });
      return next;
    });
  },

  unpinSession: (workspaceId, sessionId) => {
    set((state) => {
      const workspaces = updateWorkspace(state.workspaces, workspaceId, (workspace) => ({
        ...workspace,
        pinnedSessionIds: workspace.pinnedSessionIds.filter((id) => id !== sessionId),
      }));
      const next = { workspaces };
      persist({ ...state, ...next });
      return next;
    });
  },

  togglePinSession: (workspaceId, sessionId) => {
    const workspace = get().workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) return;
    if (workspace.pinnedSessionIds.includes(sessionId)) get().unpinSession(workspaceId, sessionId);
    else get().pinSession(workspaceId, sessionId);
  },

  ...createWorkspaceTabActions(set, get, persist),

  setActiveLeftToolWindow: (workspaceId, toolWindow) => {
    set((state) => {
      const workspaces = updateWorkspace(state.workspaces, workspaceId, (workspace) => ({
        ...workspace,
        activeLeftToolWindow: toolWindow,
      }));
      const next = { workspaces };
      persist({ ...state, ...next });
      return next;
    });
  },

  setBottomDockOpen: (workspaceId, open) => {
    set((state) => {
      const workspaces = updateWorkspace(state.workspaces, workspaceId, (workspace) => ({
        ...workspace,
        bottomDock: { ...workspace.bottomDock, open },
      }));
      const next = { workspaces };
      persist({ ...state, ...next });
      return next;
    });
  },

  setBottomDockTool: (workspaceId, tool) => {
    set((state) => {
      const workspaces = updateWorkspace(state.workspaces, workspaceId, (workspace) => ({
        ...workspace,
        bottomDock: { ...workspace.bottomDock, open: true, activeTool: tool },
      }));
      const next = { workspaces };
      persist({ ...state, ...next });
      return next;
    });
  },

  setBottomDockHeight: (workspaceId, heightPx) => {
    const height = Math.min(Math.max(120, Math.round(heightPx)), 640);
    set((state) => {
      const workspaces = updateWorkspace(state.workspaces, workspaceId, (workspace) => ({
        ...workspace,
        bottomDock: { ...workspace.bottomDock, heightPx: height },
      }));
      const next = { workspaces };
      persist({ ...state, ...next });
      return next;
    });
  },
}));
