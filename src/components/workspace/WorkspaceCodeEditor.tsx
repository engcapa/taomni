import { memo, useCallback, useDeferredValue, useEffect } from "react";
import { CodeWorkspaceTab, type CodeWorkspaceGitManagerPayload } from "../editor/CodeWorkspaceTab";
import type { WorkspaceCommandRegistration } from "../editor/workspace/workspaceCommands";
import { useWorkspacePlatformStore, type PlatformWorkspace } from "../../stores/workspacePlatformStore";
import { useWorkspaceGitContextStore } from "../../stores/workspaceGitContextStore";
import { useWorkspaceCodeHost } from "./useWorkspaceCodeHost";
import { useWorkspaceCodeDefinition } from "./useWorkspaceCodeDefinition";

export interface WorkspaceCodeEditorProps {
  workspace: PlatformWorkspace;
  tabId: string;
  visible: boolean;
  onCommandsChange?: (tabId: string, registration: WorkspaceCommandRegistration | null) => void;
  sharedFiles?: boolean;
}

/** Preserve the full editor's publication, recents and command ownership. */
export const WorkspaceCodeEditor = memo(function WorkspaceCodeEditor({ workspace, tabId, visible, onCommandsChange, sharedFiles = false }: WorkspaceCodeEditorProps) {
  const hostIntegration = useWorkspaceCodeHost(workspace, visible, sharedFiles);
  const editorVisible = useDeferredValue(visible);
  const info = useWorkspaceCodeDefinition(workspace, tabId);
  const syncGitManager = useCallback((payload: CodeWorkspaceGitManagerPayload) => {
    const git = useWorkspaceGitContextStore.getState();
    const previous = git.byWorkspace[workspace.id];
    git.publish(workspace.id, {
      roots: payload.roots,
      activeRepoRoot: payload.activeRepoRoot,
    });
    if (previous?.roots.length && !payload.roots.length) {
      const platform = useWorkspacePlatformStore.getState();
      const linked = platform.getWorkspace(workspace.id)?.openTabs.find((tab) => tab.kind === "git");
      if (linked) platform.closeWorkspaceTab(workspace.id, linked.id);
    }
  }, [workspace.id]);
  const openGitManager = useCallback((payload: CodeWorkspaceGitManagerPayload) => {
    syncGitManager(payload);
    useWorkspacePlatformStore.getState().openGitTab(workspace.id);
  }, [syncGitManager, workspace.id]);
  useEffect(() => () => useWorkspaceGitContextStore.getState().clear(workspace.id), [workspace.id]);
  return <CodeWorkspaceTab
    tabId={tabId}
    workspace={info}
    visible={editorVisible}
    onOpenGitManager={openGitManager}
    onSyncGitManager={syncGitManager}
    onCommandsChange={onCommandsChange}
    hostIntegration={hostIntegration}
  />;
});
