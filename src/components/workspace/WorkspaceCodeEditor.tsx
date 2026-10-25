import { useCallback, useEffect, useMemo, useRef } from "react";
import { CodeWorkspaceTab, type CodeWorkspaceGitManagerPayload } from "../editor/CodeWorkspaceTab";
import type { WorkspaceCommandRegistration } from "../editor/workspace/workspaceCommands";
import { useAppStore } from "../../stores/appStore";
import { fileRefFromContext, recentWorkspaceFromTab } from "../../stores/app/recentWorkspaces";
import { useWorkspacePlatformStore, type PlatformWorkspace } from "../../stores/workspacePlatformStore";
import type { CodeWorkspaceTabInfo } from "../../types";
import { useWorkspaceGitContextStore } from "../../stores/workspaceGitContextStore";
import { useWorkspaceCodeHost } from "./useWorkspaceCodeHost";

export interface WorkspaceCodeEditorProps {
  workspace: PlatformWorkspace;
  tabId: string;
  visible: boolean;
  onCommandsChange?: (tabId: string, registration: WorkspaceCommandRegistration | null) => void;
  sharedFiles?: boolean;
}

/** Preserve the full editor's publication, recents and command ownership. */
export function WorkspaceCodeEditor({ workspace, tabId, visible, onCommandsChange, sharedFiles = false }: WorkspaceCodeEditorProps) {
  const hostIntegration = useWorkspaceCodeHost(workspace, visible, sharedFiles);
  const context = useAppStore((state) => state.codeWorkspaceByTab[tabId]);
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
  const info = useMemo<CodeWorkspaceTabInfo>(() => ({
    ...workspace.codeWorkspace,
    repoRoot: workspace.rootFolders[0]?.path ?? "",
    workspaceId: workspace.codeWorkspace?.workspaceId ?? workspace.id,
    workspaceInstanceId: workspace.codeWorkspace?.workspaceInstanceId ?? `platform:${workspace.id}`,
    name: workspace.name,
    roots: workspace.rootFolders.map((root) => ({
      id: root.id, name: root.name, path: root.path,
      kind: workspace.codeWorkspace?.roots?.find((candidate) => candidate.id === root.id)?.kind ?? "folder",
    })),
    looseFiles: workspace.codeWorkspace?.looseFiles ?? [],
  }), [workspace.codeWorkspace, workspace.id, workspace.name, workspace.rootFolders]);
  const infoRef = useRef(info);
  infoRef.current = info;
  const hadActiveFile = useRef(false);

  useEffect(() => {
    if (!context) return;
    const current = infoRef.current;
    if (context.activeFile) hadActiveFile.current = true;
    const next: CodeWorkspaceTabInfo = {
      ...current,
      repoRoot: context.repoRoot,
      roots: context.roots ?? current.roots,
      looseFiles: context.looseFiles ?? current.looseFiles,
      initialFile: hadActiveFile.current ? fileRefFromContext(context.activeFile) : current.initialFile,
    };
    useWorkspacePlatformStore.getState().updateCodeWorkspace(workspace.id, next);
    const recent = recentWorkspaceFromTab({ id: tabId, type: "code-workspace", title: workspace.name, closable: true, codeWorkspace: next }, context, Date.now());
    if (recent) useAppStore.getState().upsertRecentWorkspace(recent);
    // Input definitions must not republish a previous context while the editor
    // is applying them. Its next context publication owns the result.
  }, [context, tabId, workspace.id, workspace.name]);

  return <CodeWorkspaceTab
    tabId={tabId}
    workspace={info}
    visible={visible}
    onOpenGitManager={openGitManager}
    onSyncGitManager={syncGitManager}
    onCommandsChange={onCommandsChange}
    hostIntegration={hostIntegration}
  />;
}
