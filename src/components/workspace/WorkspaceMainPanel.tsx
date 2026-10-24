import { useEffect } from "react";
import { CodeWorkspaceTab } from "../editor/CodeWorkspaceTab";
import { WorkspaceGitManager } from "../git/WorkspaceGitManager";
import { useT } from "../../lib/i18n";
import type { CodeWorkspaceRootInfo, CodeWorkspaceTabInfo, GitWorkspaceRootInfo } from "../../types";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { useWorkspaceToolBridgeStore } from "../../stores/workspaceToolBridgeStore";
import { WorkspaceSessionPane } from "./WorkspaceSessionPanes";
import { useWorkspaceGitSummaryReporter } from "./useWorkspaceGitSummaryReporter";

function isSessionTabKind(kind: string): boolean {
  return kind !== "file" && kind !== "git";
}

function absoluteRepoPath(repoRoot: string, path: string): string {
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  return `${repoRoot.replace(/[\\/]+$/, "")}/${path.replace(/^[\\/]+/, "")}`;
}

/**
 * Workspaces-mode main canvas (v6.1 TASK-06/07): routes the active platform
 * workspace tab. The editor surface reuses the full CodeWorkspace machinery
 * (tree, tool windows, Monaco) under a stable per-workspace instance; the Git
 * tab reuses the multi-repo WorkspaceGitManager; session tabs render isolated
 * panes that never share runtime with Sessions-mode tabs.
 *
 * Every session pane of every workspace stays mounted (hidden when inactive)
 * so switching workspace or mode does not tear down live terminal/SFTP/DB
 * connections (v6.1 review H1/H8).
 */
export function WorkspaceMainPanel({ visible }: { visible: boolean }) {
  const t = useT();
  const workspaces = useWorkspacePlatformStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspacePlatformStore((s) => s.activeWorkspaceId);
  const workspace = workspaces.find((ws) => ws.id === activeWorkspaceId) ?? workspaces[0];
  const controller = useWorkspaceToolBridgeStore((s) => s.controller);
  useWorkspaceGitSummaryReporter(workspace?.rootFolders ?? []);

  const activeTab = workspace?.openTabs.find((tab) => tab.id === workspace.activeTabId);
  const gitTab = workspace?.openTabs.find((tab) => tab.kind === "git");
  const activeIsSession = !!activeTab && isSessionTabKind(activeTab.kind);
  const activeFileTab = activeTab?.kind === "file" ? activeTab : null;
  const sessionTabs = workspaces.flatMap((entry) => entry.openTabs
    .filter((tab) => isSessionTabKind(tab.kind))
    .map((tab) => ({ workspaceId: entry.id, tab })));

  // Platform file tabs only mark the active tab; the mounted editor instance
  // performs the actual open through the workspace tool bridge.
  const activeFilePath = activeFileTab?.filePath;
  const activeFileRootId = activeFileTab?.rootFolderId;
  useEffect(() => {
    if (!controller?.openFile || !activeFilePath) return;
    void controller.openFile(activeFilePath, activeFileRootId);
  }, [controller, activeFilePath, activeFileRootId]);

  if (!workspace) return null;

  const openFileFromGit = (repoRoot: string, path?: string | null) => {
    if (!path || !controller?.openFile) return;
    void controller.openFile(absoluteRepoPath(repoRoot, path));
  };

  return (
    <div data-testid="workspace-main-panel" className="relative h-full min-h-0 w-full">
      {/* The workspace editor and its Git panel stay mounted across tab
          switches; session tabs only hide them. */}
      <div className="absolute inset-0" style={{ display: activeIsSession ? "none" : "block" }}>
        <div className="absolute inset-0" style={{ display: activeTab?.kind === "git" ? "none" : "block" }}>
          <CodeWorkspaceTab
            tabId={`platform-ws-${workspace.id}`}
            workspace={editorInfoFor(workspace)}
            visible={visible && !activeIsSession && activeTab?.kind !== "git"}
            onOpenGitManager={() => useWorkspacePlatformStore.getState().openGitPanel(workspace.id)}
          />
        </div>
        {gitTab && (
          <div className="absolute inset-0" style={{ display: activeTab?.kind === "git" ? "block" : "none" }}>
            <WorkspaceGitManager
              workspaceName={workspace.name}
              roots={gitRootsFor(workspace.rootFolders)}
              activeRepoRoot={workspace.rootFolders[0]?.path}
              visible={visible && activeTab?.kind === "git"}
              initialChangePath={gitTab.focusPath}
              onOpenWorkspace={openFileFromGit}
            />
          </div>
        )}
        {/* Path C into the Git panel: the editor-corner "compare in Git panel"
            action (v6.1 AC-06). It lives inside the editor surface, so it is
            hidden while a session pane or the Git panel itself is active. */}
        {!activeIsSession && activeTab?.kind !== "git" && (
          <button
            type="button"
            data-testid="editor-open-git-diff"
            title={t("workspace.gitBarOpen")}
            className="absolute right-3 top-9 z-20 flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] shadow-sm"
            style={{ background: "var(--taomni-panel-bg)", borderColor: "var(--taomni-divider)", color: "var(--taomni-text)" }}
            onClick={() => useWorkspacePlatformStore.getState().openGitPanel(workspace.id, activeFileTab?.filePath)}
          >
            <span aria-hidden="true">🌿</span>
            {t("workspace.gitBarOpen")}
          </button>
        )}
      </div>
      {sessionTabs.map(({ workspaceId, tab }) => {
        const active = workspaceId === workspace.id && activeTab?.id === tab.id;
        return (
          <div key={tab.id} className="absolute inset-0" style={{ display: active ? "block" : "none" }}>
            <WorkspaceSessionPane tab={tab} visible={active && visible} />
          </div>
        );
      })}
      {workspace.openTabs.length === 0 && workspace.rootFolders.length === 0 && (
        <div
          data-testid="workspace-empty-hint"
          aria-hidden="true"
          className="pointer-events-none absolute bottom-2 right-3 text-[11px]"
          style={{ color: "var(--taomni-text-muted)" }}
        >
          {t("workspace.noRoots")}
        </div>
      )}
    </div>
  );
}

type PlatformRootFolder = { id: string; name: string; path: string };

function editorInfoFor(workspace: { id: string; name: string; rootFolders: PlatformRootFolder[] }): CodeWorkspaceTabInfo {
  if (workspace.rootFolders.length === 0) {
    return {
      repoRoot: "",
      workspaceId: `platform-${workspace.id}`,
      workspaceInstanceId: `platform-${workspace.id}`,
      name: workspace.name,
      roots: [],
      looseFiles: [],
      initialFile: null,
    };
  }
  const roots: CodeWorkspaceRootInfo[] = workspace.rootFolders.map((root) => ({
    id: root.id,
    name: root.name,
    path: root.path,
    kind: "folder",
  }));
  return {
    repoRoot: workspace.rootFolders[0].path,
    workspaceId: `platform-${workspace.id}`,
    workspaceInstanceId: `platform-${workspace.id}`,
    name: workspace.name,
    roots,
    looseFiles: [],
    initialFile: null,
  };
}

function gitRootsFor(folders: PlatformRootFolder[]): GitWorkspaceRootInfo[] {
  return folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    path: folder.path,
    repoRoot: folder.path,
    rootIds: [folder.id],
  }));
}
