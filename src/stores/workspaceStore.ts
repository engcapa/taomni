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
  create: (name: string, recent?: RecentWorkspace) => Promise<Workspace>;
  patch: (id: string, patch: Partial<Pick<Workspace, "name" | "description" | "roots" | "looseFiles" | "pinned" | "navigation" | "lastOpenedAt">>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  addMembership: (id: string, sessionId: string, role?: WorkspaceMembership["role"]) => Promise<void>;
  removeMembership: (id: string, sessionId: string) => Promise<void>;
  selectWorkspace: (id: string) => void;
  selectView: (view: WorkspaceView) => void;
}

// Serialize local mutations; re-read and reapply only the requested patch on conflict.
let writeQueue: Promise<unknown> = Promise.resolve();
function mutate(id: string, update: (workspace: Workspace) => Workspace) {
  const operation = writeQueue.catch(() => {}).then(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = useWorkspaceStore.getState().workspaces.find((w) => w.id === id);
      if (!current) throw new Error("Workspace unavailable");
      try {
        const saved = await persistence.saveWorkspace({ ...update(current), updatedAt: Date.now() });
        useWorkspaceStore.setState((state) => ({ error: null, workspaces: state.workspaces.map((w) => w.id === id ? saved : w) }));
        return;
      } catch (error) {
        if (!String(error).includes("conflict") || attempt === 2) throw error;
        await useWorkspaceStore.getState().load();
      }
    }
  }).catch((error: unknown) => {
    useWorkspaceStore.setState({ error: String(error) });
    throw error;
  });
  writeQueue = operation;
  return operation;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [], hydrated: false, error: null, section: "work", activeWorkspaceId: null,
  canvas: "workspace", createDialogOpen: false, commandCenterOpen: false, sessionKindFilter: "All",
  load: async () => {
    try {
      const workspaces = await persistence.listWorkspaces();
      set((s) => ({ workspaces, hydrated: true, error: null, activeWorkspaceId:
        workspaces.some((w) => w.id === s.activeWorkspaceId) ? s.activeWorkspaceId
          : [...workspaces].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0]?.id ?? null }));
    } catch (error) { set({ error: String(error) }); }
  },
  create: async (name, recent) => {
    const existing = recent && get().workspaces.find((w) => w.legacyRecentId === recent.id);
    if (existing) return existing;
    const now = Date.now();
    const workspace = await persistence.saveWorkspace({
      id: crypto.randomUUID(), name: name.trim(), description: "", roots: recent?.roots ?? [], looseFiles: recent?.looseFiles ?? [],
      legacyRecentId: recent?.id, pinned: false, order: get().workspaces.length, revision: 0,
      createdAt: now, updatedAt: now, lastOpenedAt: now,
      navigation: { activeSurface: "overview", navigatorCollapsed: false, rightPaneOpen: false }, memberships: [],
    });
    set((s) => ({ workspaces: [...s.workspaces, workspace], activeWorkspaceId: workspace.id, canvas: "workspace", section: "work", error: null }));
    return workspace;
  },
  patch: (id, patch) => mutate(id, (w) => ({ ...w, ...patch })),
  remove: async (id) => {
    await writeQueue.catch(() => {});
    const workspace = get().workspaces.find((w) => w.id === id);
    if (!workspace) return;
    await persistence.deleteWorkspace(workspace);
    await get().load();
  },
  addMembership: (id, sessionId, role = "reference") => {
    if (get().workspaces.find((w) => w.id === id)?.memberships.some((m) => m.sessionId === sessionId)) return Promise.resolve();
    return mutate(id, (w) => w.memberships.some((m) => m.sessionId === sessionId) ? w : ({ ...w, memberships: [...w.memberships, {
      workspaceId: id, sessionId, role, order: w.memberships.length, pinned: false,
    }] }));
  },
  removeMembership: (id, sessionId) => mutate(id, (w) => ({ ...w, memberships: w.memberships.filter((m) => m.sessionId !== sessionId) })),
  selectWorkspace: (id) => {
    if (!get().workspaces.some((w) => w.id === id)) return;
    set({ activeWorkspaceId: id, canvas: "workspace", section: "work" });
    void get().patch(id, { lastOpenedAt: Date.now() }).catch(() => {});
  },
  selectView: (view) => {
    const workspace = get().workspaces.find((w) => w.id === get().activeWorkspaceId);
    if (!workspace) return;
    set({ canvas: "workspace" });
    void get().patch(workspace.id, { navigation: { ...workspace.navigation, activeSurface: view } }).catch(() => {});
  },
}));

/** Install once per shell; only reload after canonical Sessions have hydrated. */
export async function subscribeWorkspaceChanges() {
  return listen<{ workspaceId: string; revision: number }>("workspace-state-changed", ({ payload }) => {
    const state = useWorkspaceStore.getState();
    const current = state.workspaces.find((w) => w.id === payload.workspaceId);
    if (state.hydrated && (!current || current.revision < payload.revision)) void state.load();
  });
}
