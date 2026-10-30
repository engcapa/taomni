import { useSyncExternalStore } from "react";
import type { WorkspaceActionProjection, WorkspaceActionProjectionSnapshot } from "../workspaceActionProjection";

const subscribeWhileClosed = () => () => {};
const closedSnapshot = () => null;

/** Subscribe at the menu surface instead of the editor's runtime owner. */
export function useWorkspaceActionProjection(projection: WorkspaceActionProjection): WorkspaceActionProjectionSnapshot;
export function useWorkspaceActionProjection(projection: WorkspaceActionProjection, enabled: boolean): WorkspaceActionProjectionSnapshot | null;
export function useWorkspaceActionProjection(projection: WorkspaceActionProjection, enabled = true) {
  // Closed surfaces must not force a new action evaluation. Reopening reads the
  // current owner synchronously, including publications made while unsubscribed.
  const getSnapshot = enabled ? projection.getSnapshot : closedSnapshot;
  return useSyncExternalStore<WorkspaceActionProjectionSnapshot | null>(
    enabled ? projection.subscribe : subscribeWhileClosed, getSnapshot, getSnapshot,
  );
}
