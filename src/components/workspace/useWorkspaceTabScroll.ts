import type { WorkspaceIsolatedTab } from "../../stores/workspacePlatformStore";
import { useTabStripScroll } from "../tabbar/tabs/useTabStripScroll";

/** Workspace strips keep their public contract; measurement lives in the shared hook. */
export function useWorkspaceTabScroll(workspaceId: string | undefined, tabs: readonly WorkspaceIsolatedTab[] | undefined, activeTabId: string | null | undefined) {
  return useTabStripScroll(workspaceId, tabs, activeTabId);
}
