import { CodeWorkspaceTab } from "../editor/CodeWorkspaceTab";
import { WorkspaceGitManager } from "../git/WorkspaceGitManager";
import { useT } from "../../lib/i18n";
import type { CodeWorkspaceRootInfo, CodeWorkspaceTabInfo, GitWorkspaceRootInfo } from "../../types";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { WorkspaceSessionPane } from "./WorkspaceSessionPanes";

/**
 * Workspaces-mode main canvas (v6.1 TASK-06/07): routes the active platform
 * workspace tab. The editor surface reuses the full CodeWorkspace machinery
 * (tree, tool windows, Monaco) under a stable per-workspace instance; the Git
 * tab reuses the multi-repo WorkspaceGitManager; session tabs render isolated
 * panes that never share runtime with Sessions-mode tabs.
 */
export function WorkspaceMainPanel({ visible }: { visible: boolean }) {
  const t = useT();
  const workspaces = useWorkspacePlatformStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspacePlatformStore((s) => s.activeWorkspaceId);
  const workspace = workspaces.find((ws) => ws.id === activeWorkspaceId) ?? workspaces[0];
  if (!workspace) return null;

  const activeTab = workspace.openTabs.find((tab) => tab.id === workspace.activeTabId);
  const isSessionTab = !!activeTab && activeTab.kind !== "git" && activeTab.kind !== "file";

  return (
    <div data-testid="workspace-main-panel" className="relative h-full min-h-0 w-full">
      {/* The workspace editor stays mounted across Git / session tab switches. */}
      <div
        className="absolute inset-0"
        style={{ display: isSessionTab ? "none" : "block" }}
      >
        {activeTab?.kind === "git" ? (
          <WorkspaceGitManager
            workspaceName={workspace.name}
            roots={gitRootsFor(workspace.rootFolders)}
            activeRepoRoot={workspace.rootFolders[0]?.path}
            visible={visible && activeTab?.kind === "git"}
          />
        ) : (
          <CodeWorkspaceTab
            tabId={`platform-ws-${workspace.id}`}
            workspace={editorInfoFor(workspace)}
            visible={visible && !isSessionTab}
          />
        )}
      </div>
      {workspace.openTabs
        .filter((tab) => tab.kind !== "git" && tab.kind !== "file")
        .map((tab) => (
          <div
            key={tab.id}
            className="absolute inset-0"
            style={{ display: activeTab?.id === tab.id ? "block" : "none" }}
          >
            <WorkspaceSessionPane tab={tab} visible={activeTab?.id === tab.id && visible} />
          </div>
        ))}
      {/* Path C into the Git panel: the editor-corner "compare in Git panel"
          action (v6.1 AC-06); hidden while the Git panel itself is active. */}
      {activeTab?.kind !== "git" && (
      <button
        type="button"
        data-testid="editor-open-git-diff"
        title={t("workspace.gitBarOpen")}
        className="absolute right-3 top-[46px] z-20 flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] shadow-sm"
        style={{ background: "var(--taomni-panel-bg)", borderColor: "var(--taomni-divider)", color: "var(--taomni-text)" }}
        onClick={() => useWorkspacePlatformStore.getState().openGitPanel(workspace.id)}
      >
        <span aria-hidden="true">🌿</span>
        {t("workspace.gitBarOpen")}
      </button>
      )}
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
