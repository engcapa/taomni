import { FilePlus2, FolderPlus, GitBranch, ListTree, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { gitProbePath, gitSnapshot } from "../../lib/git";
import { useAppStore } from "../../stores/appStore";
import {
  useWorkspacePlatformStore,
  type PlatformWorkspace,
  type WorkspaceRootFolder,
  type WorkspaceTreeNode,
} from "../../stores/workspacePlatformStore";
import { outlineSymbols, useWorkspaceEditorStore } from "../../stores/workspaceEditorStore";
import { useWorkspaceUiStore } from "../../stores/workspaceUiStore";
import { WorkspaceFileTree } from "./WorkspaceFileTree";
import { WorkspaceSessionsPanel } from "./WorkspaceSessionsPanel";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

export interface WorkspaceSidebarProps {
  onOpenSessionPicker: () => void;
}

interface GitBarState {
  branch: string | null;
  changeCount: number;
}

function useWorkspaceGitBar(workspace: PlatformWorkspace | undefined): GitBarState {
  const [state, setState] = useState<GitBarState>({ branch: null, changeCount: 0 });
  const rootsKey = workspace?.rootFolders.map((root) => root.path).join("|") ?? "";
  useEffect(() => {
    let cancelled = false;
    const first = workspace?.rootFolders[0];
    if (!first) {
      setState({ branch: null, changeCount: 0 });
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      try {
        const probe = await gitProbePath(first.path);
        if (cancelled) return;
        if (!probe?.isRepo || !probe.repoRoot) {
          setState({ branch: null, changeCount: 0 });
          return;
        }
        const snapshot = await gitSnapshot(probe.repoRoot);
        if (cancelled) return;
        setState({
          branch: snapshot?.currentBranch ?? null,
          changeCount: snapshot?.changes?.length ?? 0,
        });
      } catch {
        if (!cancelled) setState({ branch: null, changeCount: 0 });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rootsKey, workspace?.rootFolders]);
  return state;
}

/**
 * Workspaces mode left sidebar (AC-05/06/08): workspace switcher, the active
 * tool window (multi-root project tree / workspace sessions / structure), and
 * the permanent Git status bar. The removed `[Files | Git]` row is deliberately
 * absent; Git is reached from the rail, this bar, or the editor toolbar.
 */
export function WorkspaceSidebar({ onOpenSessionPicker }: WorkspaceSidebarProps) {
  const t = useT();
  const workspace = useWorkspacePlatformStore((s) => s.workspaces.find((candidate) => candidate.id === s.activeWorkspaceId));
  const createdNodes = useWorkspacePlatformStore((s) => s.createdNodes);
  const setActiveSideTab = useAppStore((s) => s.setActiveSideTab);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const store = useWorkspacePlatformStore.getState;
  const openFsModal = useWorkspaceUiStore((s) => s.openFsModal);
  const [refreshToken, setRefreshToken] = useState(0);
  const documents = useWorkspaceEditorStore((s) => s.documents);
  const gitBar = useWorkspaceGitBar(workspace);

  const lens = workspace?.activeLeftToolWindow ?? "project";
  const activeTab = workspace?.openTabs.find((tab) => tab.id === workspace.activeTabId);
  const activeDocument = activeTab ? documents[activeTab.id] : undefined;
  const workspaceNodes: WorkspaceTreeNode[] = createdNodes.filter((node) => node.workspaceId === workspace?.id);

  const openModal = useCallback((kind: "file" | "folder" | "root", root?: WorkspaceRootFolder, directory = "") => {
    openFsModal({ kind, directory, rootFolderId: root?.id });
  }, [openFsModal]);

  const openFile = (root: WorkspaceRootFolder, path: string) => {
    if (!workspace) return;
    store().openFileInWorkspace(workspace.id, { rootId: root.id, path, name: path.split("/").pop() });
  };

  const openGitForFile = (root: WorkspaceRootFolder, path: string) => {
    if (!workspace) return;
    void root;
    store().openGitTab(workspace.id, path || undefined);
  };

  if (!workspace) return null;

  const toolbar = lens === "project" ? (
    <div className="flex shrink-0 items-center gap-1 px-1.5 py-1" style={{ borderBottom: "1px solid var(--taomni-divider)" }}>
      <ToolbarButton testId="workspace-new-file" label={t("platform.newFile")} shortcut="Alt+Insert" onClick={() => openModal("file", workspace.rootFolders[0], "")}>
        <FilePlus2 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton testId="workspace-new-folder" label={t("platform.newFolder")} onClick={() => openModal("folder", workspace.rootFolders[0], "")}>
        <FolderPlus className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton testId="workspace-add-folder" label={t("platform.addRootFolder")} onClick={() => openModal("root")}>
        <FolderPlus className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton testId="workspace-refresh-tree" label={t("platform.refreshTree")} onClick={() => setRefreshToken((token) => token + 1)}>
        <RefreshCw className="h-3.5 w-3.5" />
      </ToolbarButton>
      <div className="flex-1" />
      <ToolbarButton testId="workspace-open-git" label={t("platform.openGitPanel")} onClick={() => store().openGitTab(workspace.id)}>
        <GitBranch className="h-3.5 w-3.5" />
      </ToolbarButton>
    </div>
  ) : lens === "sessions" ? null : (
    <div className="flex shrink-0 items-center gap-1 px-1.5 py-1" style={{ borderBottom: "1px solid var(--taomni-divider)" }}>
      <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-[var(--taomni-text-muted)]">
        <ListTree className="h-3.5 w-3.5" />
        {t("platform.structure")}
      </span>
    </div>
  );

  return (
    <div data-testid="workspace-sidebar-panel" className="flex min-h-0 flex-1 flex-col">
      <WorkspaceSwitcher onAddFolder={() => openModal("root")} />
      {toolbar}
      {lens === "project" && (
        <WorkspaceFileTree
          workspace={workspace}
          createdNodes={workspaceNodes}
          activeRootId={activeTab?.rootFolderId}
          activePath={activeTab?.kind === "file" ? activeTab.filePath : undefined}
          onOpenFile={openFile}
          onCreate={(kind, root, directory) => openModal(kind, root, directory)}
          onAddRoot={() => openModal("root")}
          onRemoveRoot={(rootId) => store().removeRootFolder(workspace.id, rootId)}
          onOpenGitForFile={openGitForFile}
          refreshToken={refreshToken}
        />
      )}
      {lens === "sessions" && (
        <WorkspaceSessionsPanel
          workspace={workspace}
          onOpenSessionPicker={onOpenSessionPicker}
          onOpenSession={(session) => {
            store().openSessionInWorkspace(workspace.id, session);
            setActiveSideTab("workspaces");
            setSidebarCollapsed(false);
          }}
        />
      )}
      {lens === "structure" && (
        <div data-testid="workspace-structure-panel" className="min-h-0 flex-1 overflow-auto py-1">
          {(!activeDocument || activeDocument.loading) && (
            <div className="px-2 py-2 text-[11px] text-[var(--taomni-text-muted)]">{t("platform.structureEmpty")}</div>
          )}
          {activeDocument && !activeDocument.loading && outlineSymbols(activeDocument.text).map((symbol) => (
            <div
              key={`${symbol.line}-${symbol.label}`}
              data-testid="workspace-structure-symbol"
              data-kind={symbol.kind}
              className="flex h-[22px] items-center gap-1.5 rounded px-2 hover:bg-[var(--taomni-hover)]"
              style={{ fontSize: "var(--taomni-ui-font-size)" }}
            >
              <span className="w-12 shrink-0 text-[9.5px] uppercase text-[var(--taomni-text-muted)]">{symbol.kind}</span>
              <span className="truncate">{symbol.label}</span>
              <span className="ml-auto text-[9.5px] text-[var(--taomni-text-muted)]">{symbol.line}</span>
            </div>
          ))}
          {activeDocument && !activeDocument.loading && outlineSymbols(activeDocument.text).length === 0 && (
            <div className="px-2 py-2 text-[11px] text-[var(--taomni-text-muted)]">{t("platform.structureEmpty")}</div>
          )}
        </div>
      )}
      <button
        type="button"
        data-testid="workspace-sidebar-git-bar"
        data-branch={gitBar.branch ?? ""}
        data-changes={gitBar.changeCount}
        className="mt-1 flex h-7 w-full shrink-0 items-center justify-between gap-1 border-t px-2 text-left hover:bg-[var(--taomni-hover)]"
        style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-card-bg)" }}
        title={t("platform.openGitPanel")}
        onClick={() => {
          store().openGitTab(workspace.id);
          setActiveSideTab("workspaces");
        }}
      >
        <span className="inline-flex min-w-0 items-center gap-1 text-[10.5px]">
          <GitBranch className="h-3 w-3 shrink-0" />
          <span className="truncate">{gitBar.branch ?? t("platform.noChanges")}</span>
          {gitBar.changeCount > 0 && (
            <span className="shrink-0 rounded px-1 text-[9.5px]" style={{ background: "var(--taomni-selected)", color: "var(--taomni-accent)" }}>
              {gitBar.changeCount}
            </span>
          )}
        </span>
        <span className="shrink-0 text-[10px]" style={{ color: "var(--taomni-accent)" }}>→</span>
      </button>
    </div>
  );
}

function ToolbarButton({
  testId,
  label,
  shortcut,
  onClick,
  children,
}: {
  testId: string;
  label: string;
  shortcut?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
