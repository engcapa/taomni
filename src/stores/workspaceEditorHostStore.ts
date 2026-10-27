import { create } from "zustand";
import type { WorkspaceFileMenu } from "../components/editor/workspace/workspaceHostIntegration";

/** DOM destinations only; buffers and project lifetimes remain in CodeWorkspace. */
export const useWorkspaceEditorHostStore = create<{
  hosts: Record<string, HTMLElement>;
  setHost: (workspaceId: string, element: HTMLElement | null) => void;
  fileMenus: Record<string, Record<string, WorkspaceFileMenu>>;
  setFileMenu: (workspaceId: string, groupId: string, menu: WorkspaceFileMenu | null) => void;
}>((set) => ({
  hosts: {},
  fileMenus: {},
  setFileMenu: (workspaceId, groupId, menu) => set((state) => {
    const current = state.fileMenus[workspaceId] ?? {};
    if (current[groupId] === menu || !menu && !current[groupId]) return state;
    const next = { ...current };
    if (menu) next[groupId] = menu;
    else delete next[groupId];
    return { fileMenus: { ...state.fileMenus, [workspaceId]: next } };
  }),
  setHost: (workspaceId, element) => set((state) => {
    if (state.hosts[workspaceId] === element || !element && !state.hosts[workspaceId]) return state;
    const hosts = { ...state.hosts };
    if (element) hosts[workspaceId] = element;
    else delete hosts[workspaceId];
    return { hosts };
  }),
}));
