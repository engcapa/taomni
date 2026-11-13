import type { MenuItem } from "../../components/ContextMenu";
import type { CodeWorkspaceRootInfo } from "../../types";
import { useAppStore } from "../../stores/appStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { t } from "../i18n";
import { joinPath } from "../sftp";
import { workspaceEditorInstanceId } from "../workspaceRuntimeIdentity";
import { openExplorer } from "./openExplorer";

/** Resolve the actual project owner, never whichever workspace is active later
 * when the portal's context-menu item is clicked. */
export function projectExplorerMenu(
  instanceId: string,
  roots: readonly CodeWorkspaceRootInfo[],
  rootId: string,
  relativePath: string,
): MenuItem[] {
  const root = roots.find((item) => item.id === rootId);
  if (!root) return [];
  const path = relativePath ? joinPath(root.path, relativePath) : root.path;
  const workspace = useWorkspacePlatformStore.getState().workspaces.find((item) => workspaceEditorInstanceId(item) === instanceId);
  return [false, true].map((forceNew) => ({
    label: t(forceNew ? "explorerEntry.openNew" : "explorerEntry.openHere"),
    testId: `code-workspace-tree-open-explorer${forceNew ? "-new" : ""}`,
    onClick: () => {
      void openExplorer(path, { workspaceId: workspace?.id, forceNew })
        .catch((error) => useAppStore.getState().setStatusMessage(String(error)));
    },
  }));
}
