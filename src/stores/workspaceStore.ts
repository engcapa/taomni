import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import * as persistence from "../lib/workspacePersistence";
import type { RecentWorkspace } from "../types";
import type { Workspace, WorkspaceMembership, WorkspaceView } from "../types/workspace";

export type NavigationSection = "work" | "sessions" | "tools" | "alerts";
interface WorkspaceState {
  workspaces: Workspace[];
  hydrated: boolean;
  error: string | null;
  section: NavigationSection;
  activeWorkspaceId: string | null;
  canvas: "workspace" | "runtime";
  createDialogOpen: boolean;
  commandCenterOpen: boolean;
  sessionKindFilter: string;
  load: () => Promise<void>;
  create: (name: string, recent?: RecentWorkspace, activate?: boolean) => Promise<Workspace>;
  patch: (id: string, patch: Partial<Pick<Workspace, "name" | "description" | "roots" | "looseFiles" | "pinned" | "lastOpenedAt">> & { navigation?: Partial<Workspace["navigation"]> }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  addMembership: (id: string, sessionId: string, role?: WorkspaceMembership["role"]) => Promise<void>;
  removeMembership: (id: string, sessionId: string) => Promise<void>;
  patchMembership: (id: string, sessionId: string, patch: Partial<Pick<WorkspaceMembership, "role" | "order" | "pinned" | "defaultSurface">>) => Promise<void>;
  selectWorkspace: (id: string) => void;
  selectView: (view: WorkspaceView) => void;
}

// Serialize local mutations; re-read and reapply only the requested patch on conflict.
let writeQueue: Promise<unknown> = Promise.resolve();
const pendingViews = new Map<string, { view: WorkspaceView; token: symbol }>();
function projectPendingView(workspace: Workspace): Workspace {
  const pending = pendingViews.get(workspace.id);
  return pending ? { ...workspace, navigation: { ...workspace.navigation, activeSurface: pending.view } } : workspace;
}
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeQueue.catch(() => {}).then(operation).catch((error: unknown) => {
    useWorkspaceStore.setState({ error: String(error) });
    throw error;
  });
  writeQueue = result;
  return result;
}

async function reload() {
  const workspaces = (await persistence.listWorkspaces()).map(projectPendingView);
  useWorkspaceStore.setState((state) => ({
    workspaces, hydrated: true, error: null,
    activeWorkspaceId: workspaces.some((w) => w.id === state.activeWorkspaceId)
      ? state.activeWorkspaceId
      : [...workspaces].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0]?.id ?? null,
  }));
}

function mutate(id: string, update: (workspace: Workspace) => Workspace) {
  return enqueue(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = useWorkspaceStore.getState().workspaces.find((w) => w.id === id);
      if (!current) throw new Error("Workspace unavailable");
      try {
        const saved = await persistence.saveWorkspace({ ...update(current), updatedAt: Date.now() });
        useWorkspaceStore.setState((state) => ({ error: null, workspaces: state.workspaces.map((w) => w.id === id ? projectPendingView(saved) : w) }));
        return;
      } catch (error) {
        if (!String(error).includes("conflict") || attempt === 2) throw error;
        await reload();
      }
    }
  });
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [], hydrated: false, error: null, section: "work", activeWorkspaceId: null,
  canvas: "workspace", createDialogOpen: false, commandCenterOpen: false, sessionKindFilter: "All",
  load: () => enqueue(reload).catch(() => {}),
  create: (name, recent, activate = true) => enqueue(async () => {
    const existing = recent && get().workspaces.find((w) => w.legacyRecentId === recent.id);
    if (existing) {
      if (activate) set({ activeWorkspaceId: existing.id, canvas: "workspace", section: "work" });
      return existing;
    }
    const now = Date.now();
    const workspace = await persistence.saveWorkspace({
      id: crypto.randomUUID(), name: name.trim(), description: "", roots: recent?.roots ?? [], looseFiles: recent?.looseFiles ?? [],
      legacyRecentId: recent?.id, pinned: false, order: get().workspaces.length, revision: 0,
      createdAt: now, updatedAt: now, lastOpenedAt: now,
      navigation: { activeSurface: "overview", navigatorCollapsed: false, rightPaneOpen: false }, memberships: [],
    });
    set((s) => ({ workspaces: [...s.workspaces.filter((w) => w.id !== workspace.id), workspace],
      ...(activate ? { activeWorkspaceId: workspace.id, canvas: "workspace" as const, section: "work" as const } : {}), error: null }));
    return workspace;
  }),
  patch: (id, patch) => mutate(id, (w) => ({ ...w, ...patch, navigation: { ...w.navigation, ...patch.navigation } })),
  remove: (id) => enqueue(async () => {
    const workspace = get().workspaces.find((w) => w.id === id);
    if (!workspace) return;
    await persistence.deleteWorkspace(workspace);
    await reload();
  }),
  addMembership: (id, sessionId, role = "reference") => {
    if (get().workspaces.find((w) => w.id === id)?.memberships.some((m) => m.sessionId === sessionId)) return Promise.resolve();
    return mutate(id, (w) => w.memberships.some((m) => m.sessionId === sessionId) ? w : ({ ...w, memberships: [...w.memberships, {
      workspaceId: id, sessionId, role, order: w.memberships.length, pinned: false,
    }] }));
  },
  removeMembership: (id, sessionId) => mutate(id, (w) => ({ ...w, memberships: w.memberships.filter((m) => m.sessionId !== sessionId) })),
  patchMembership: (id, sessionId, patch) => mutate(id, (w) => ({ ...w, memberships: w.memberships.map((m) => m.sessionId === sessionId ? { ...m, ...patch } : m) })),
  selectWorkspace: (id) => {
    if (!get().workspaces.some((w) => w.id === id)) return;
    set({ activeWorkspaceId: id, canvas: "workspace", section: "work" });
    void get().patch(id, { lastOpenedAt: Date.now() }).catch(() => {});
  },
  selectView: (view) => {
    const workspace = get().workspaces.find((w) => w.id === get().activeWorkspaceId);
    if (!workspace) return;
    const token = Symbol();
    pendingViews.set(workspace.id, { view, token });
    set((state) => ({ canvas: "workspace", workspaces: state.workspaces.map((w) => w.id === workspace.id
      ? { ...w, navigation: { ...w.navigation, activeSurface: view } } : w) }));
    void get().patch(workspace.id, { navigation: { activeSurface: view } }).catch(() => {}).finally(() => {
      if (pendingViews.get(workspace.id)?.token === token) pendingViews.delete(workspace.id);
    });
  },
}));

/** Install once per shell; only reload after canonical Sessions have hydrated. */
export async function subscribeWorkspaceChanges() {
  return listen<{ workspaceId: string; revision: number }>("workspace-state-changed", ({ payload }) => {
    const state = useWorkspaceStore.getState();
    const current = state.workspaces.find((w) => w.id === payload.workspaceId);
    if (state.hydrated && (!current || current.revision < payload.revision)) {
      void import("./sessionStore").then(async ({ useSessionStore }) => {
        await useSessionStore.getState().loadSessions();
        await state.load();
      });
    }
  });
}
