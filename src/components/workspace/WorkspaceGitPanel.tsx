import { FolderPlus } from "lucide-react";
import { WorkspaceGitManager } from "../git/WorkspaceGitManager";
import { useT } from "../../lib/i18n";
import type { GitWorkspaceRootInfo } from "../../types";
import { useWorkspaceUiStore } from "../../stores/workspaceUiStore";
import type { PlatformWorkspace } from "../../stores/workspacePlatformStore";
import { useWorkspaceGitContextStore } from "../../stores/workspaceGitContextStore";

export interface WorkspaceGitPanelProps {
  workspace: PlatformWorkspace;
  visible: boolean;
  focusPath?: string;
  onOpenFile?: (rootId: string, path: string) => void;
}

/**
 * Workspaces built-in Git surface (AC-06).
 *
 * Reuses `WorkspaceGitManager` unchanged so the workspace keeps every main
 * capability: repository selector, branch badge, fetch/pull/push, conflict
 * banner, Changes/Log/Branches/Tags/Stash/Settings tabs, tree/flat changes,
 * amend, commit + push and side-by-side/unified diffs.
 */
export function WorkspaceGitPanel({ workspace, visible, focusPath, onOpenFile }: WorkspaceGitPanelProps) {
  const t = useT();
  const openFsModal = useWorkspaceUiStore((s) => s.openFsModal);
  const context = useWorkspaceGitContextStore((state) => state.byWorkspace[workspace.id]);
  const roots: GitWorkspaceRootInfo[] = context?.roots ?? workspace.rootFolders.map((root) => ({
    id: root.id,
    name: root.name,
    path: root.path,
    repoRoot: root.path,
    rootIds: [root.id],
  }));

  if (roots.length === 0) {
    return (
      <div data-testid="workspace-git-panel" data-empty="true" className="flex h-full flex-col items-center justify-center gap-3 p-6">
        <div className="text-[13px] font-semibold">{t("platform.gitRepo")}</div>
        <div className="text-[11.5px]" style={{ color: "var(--taomni-text-muted)" }}>{t("platform.noWorkspaceRoot")}</div>
        <button
          type="button"
          data-testid="workspace-git-add-folder"
          className="taomni-btn h-7 px-2 inline-flex items-center gap-1"
          onClick={() => openFsModal({ kind: "root", directory: "" })}
        >
          <FolderPlus className="h-3.5 w-3.5" />
          {t("platform.addRootFolder")}
        </button>
      </div>
    );
  }

  return (
    <div data-testid="workspace-git-panel" data-focus-path={focusPath ?? undefined} className="h-full min-h-0 w-full">
      <WorkspaceGitManager
        workspaceName={workspace.name}
        roots={roots}
        activeRepoRoot={context?.activeRepoRoot ?? roots[0]?.repoRoot ?? null}
        visible={visible}
        onOpenWorkspace={(repoRoot, path) => {
          if (!path) return;
          const absolute = `${repoRoot.replace(/\\/g, "/").replace(/\/$/, "")}/${path}`;
          const root = workspace.rootFolders.find((folder) => absolute.startsWith(`${folder.path.replace(/\\/g, "/").replace(/\/$/, "")}/`));
          if (root) onOpenFile?.(root.id, absolute.slice(root.path.replace(/[\\/]$/, "").length + 1));
        }}
      />
    </div>
  );
}
