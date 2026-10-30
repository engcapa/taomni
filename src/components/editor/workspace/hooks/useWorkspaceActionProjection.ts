import { useSyncExternalStore } from "react";
import type { WorkspaceActionProjection } from "../workspaceActionProjection";

/** Subscribe at the menu surface instead of the editor's runtime owner. */
export function useWorkspaceActionProjection(projection: WorkspaceActionProjection) {
  return useSyncExternalStore(projection.subscribe, projection.getSnapshot, projection.getSnapshot);
}
