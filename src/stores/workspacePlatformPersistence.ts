import type { WorkspacePlatformState } from "./workspacePlatformStore";

export const PLATFORM_WORKSPACES_STORAGE_KEY = "taomni.platformWorkspaces.v1";
type Metadata = Pick<WorkspacePlatformState, "workspaces" | "activeWorkspaceId" | "createdNodes">;

let pending: Metadata | null = null;
let timer: number | null = null;
let observedStorage: string | null = null;

export function observeWorkspacePlatformStorage(raw: string | null): void {
  observedStorage = raw;
}

/** Explicit reloads replace local state, including any queued older snapshot. */
export function cancelWorkspacePlatformPersistence(): void {
  if (typeof window === "undefined") return;
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  pending = null;
  window.removeEventListener("beforeunload", flushWorkspacePlatformPersistence);
  window.removeEventListener("pagehide", flushWorkspacePlatformPersistence);
}

function flushWorkspacePlatformPersistence(): void {
  const snapshot = pending;
  cancelWorkspacePlatformPersistence();
  if (!snapshot) return;
  try {
    // Another window/import may have replaced storage since our last read.
    // Never overwrite it with an older queued snapshot during page teardown.
    if (window.localStorage.getItem(PLATFORM_WORKSPACES_STORAGE_KEY) !== observedStorage) return;
    const serialized = JSON.stringify({
      version: 1,
      workspaces: snapshot.workspaces,
      activeWorkspaceId: snapshot.activeWorkspaceId,
      createdNodes: snapshot.createdNodes,
    });
    window.localStorage.setItem(PLATFORM_WORKSPACES_STORAGE_KEY, serialized);
    observedStorage = serialized;
  } catch {
    // Match the existing metadata contract: retain memory state; a later
    // mutation retries storage. Dirty text has its own synchronous journal.
  }
}

/**
 * Tabs/roots are immutable metadata; keep serialization and WebView storage
 * off the activation stack. Coalesce bursts without postponing indefinitely
 * during continuous input. Window teardown flushes even the last action.
 */
export function persistWorkspacePlatformMetadata(state: Metadata): void {
  if (typeof window === "undefined") return;
  pending = { workspaces: state.workspaces, activeWorkspaceId: state.activeWorkspaceId, createdNodes: state.createdNodes };
  if (timer !== null) return;
  window.addEventListener("beforeunload", flushWorkspacePlatformPersistence);
  window.addEventListener("pagehide", flushWorkspacePlatformPersistence);
  timer = window.setTimeout(flushWorkspacePlatformPersistence, 300);
}
