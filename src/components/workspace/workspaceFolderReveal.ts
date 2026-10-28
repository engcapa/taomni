import { useAppStore } from "../../stores/appStore";
import { useCodeWorkspaceStore } from "../../stores/codeWorkspaceStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { workspaceEditorRuntimeId } from "../../lib/workspaceRuntimeIdentity";
import { rootDirKey } from "../editor/workspace/codeWorkspaceModel";

/** Only an explicit successful folder selection reveals the active explorer. */
export function revealWorkspaceFolder(workspaceId: string, rootId: string): void {
  const app = useAppStore.getState();
  const platform = useWorkspacePlatformStore.getState();
  if (app.activeSideTab !== "workspaces" || platform.activeWorkspaceId !== workspaceId) return;
  const instanceId = workspaceEditorRuntimeId({ id: workspaceId });
  const editor = useCodeWorkspaceStore.getState();
  editor.updateExpandedRootIds(instanceId, (ids) => ids.includes(rootId) ? ids : [...ids, rootId]);
  const directoryKey = rootDirKey(rootId, "");
  editor.updateExpandedDirKeys(instanceId, (keys) => keys.includes(directoryKey) ? keys : [...keys, directoryKey]);
  editor.patchInstance(instanceId, { languagePanelOpen: true });
  platform.setActiveLeftToolWindow(workspaceId, "project");
  app.setSidebarCollapsed(false);
}
