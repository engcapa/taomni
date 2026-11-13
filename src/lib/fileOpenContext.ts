import { useWorkspacePlatformStore } from "../stores/workspacePlatformStore";
import { workspaceEditorInstanceId } from "./workspaceRuntimeIdentity";

/** Editor recovery identities are not platform workspace ids. */
export function fileOpenWorkspaceId(instanceId: string): string | undefined {
  return useWorkspacePlatformStore.getState().workspaces.find((workspace) => workspaceEditorInstanceId(workspace) === instanceId)?.id;
}

export function fileOpenWorkspaceForTab(tabId: string | undefined): string | undefined {
  if (!tabId) return;
  return useWorkspacePlatformStore.getState().workspaces.find((workspace) =>
    workspace.openTabs.some((tab) => tab.id === tabId) || `ws:${workspace.id}:editor` === tabId
      || tabId.startsWith(`workspace-terminal-${workspaceEditorInstanceId(workspace)}-`),
  )?.id;
}
