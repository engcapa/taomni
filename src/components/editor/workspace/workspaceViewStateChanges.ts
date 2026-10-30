/** View snapshots update refs; only the layout writer needs their notifications. */
export interface WorkspaceViewStateChanges {
  notify: () => void;
  subscribe: (listener: () => void) => () => void;
}

export function createWorkspaceViewStateChanges(): WorkspaceViewStateChanges {
  const listeners = new Set<() => void>();
  return {
    notify: () => { for (const listener of listeners) listener(); },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
