import type { WorkspaceActionHost, ActionSnapshotItem } from "./workspaceActionHost";
import type { WorkspaceCommandMenuItem, WorkspaceCommandRegistration } from "./workspaceCommands";

export interface WorkspaceActionProjectionSnapshot {
  snapshot: ActionSnapshotItem[];
  menuItems: WorkspaceCommandMenuItem[];
  commandRegistration: WorkspaceCommandRegistration;
}

export interface WorkspaceActionProjection {
  getSnapshot: () => WorkspaceActionProjectionSnapshot;
  subscribe: (listener: () => void) => () => void;
  publish: () => void;
}

/** One frozen evaluation shared by the menu surfaces, independent of editor renders. */
export function createWorkspaceActionProjection(
  input: () => { host: WorkspaceActionHost; contextKey: object },
  executeAction: NonNullable<WorkspaceCommandRegistration["executeAction"]>,
  execute: WorkspaceCommandRegistration["execute"],
): WorkspaceActionProjection {
  const listeners = new Set<() => void>();
  let cached: {
    host: WorkspaceActionHost; generation: number; contextKey: object;
    value: WorkspaceActionProjectionSnapshot;
  } | null = null;
  return {
    getSnapshot: () => {
      const { host, contextKey } = input();
      const generation = host.getGeneration();
      if (cached?.host === host && cached.generation === generation && cached.contextKey === contextKey) return cached.value;
      const snapshot = host.getSnapshot();
      const menuItems = snapshot.map((entry): WorkspaceCommandMenuItem => ({
        id: entry.id, title: entry.title, category: entry.category,
        keybinding: entry.keybinding, enabled: entry.state.availability === "available",
        provenance: entry.state.source,
      }));
      const commandRegistration: WorkspaceCommandRegistration = { items: menuItems, snapshot, executeAction, execute };
      const value = { snapshot, menuItems, commandRegistration };
      cached = { host, generation, contextKey, value };
      return value;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    publish: () => {
      cached = null;
      for (const listener of listeners) listener();
    },
  };
}
