import type { PlatformWorkspace } from "../stores/workspacePlatformStore";

/** Every file tab in a platform workspace shares one editor runtime. */
export const workspaceEditorRuntimeId = (workspace: Pick<PlatformWorkspace, "id">) =>
  `ws:${workspace.id}:editor`;

export function activeWorkspaceRuntimeTabId(workspace: PlatformWorkspace | undefined): string | undefined {
  const tab = workspace?.openTabs.find((item) => item.id === workspace.activeTabId);
  return workspace && (tab?.kind === "file" || tab?.kind === "code")
    ? workspaceEditorRuntimeId(workspace) : tab?.id;
}
