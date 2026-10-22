import { Braces, Download, Ellipsis, GitCommitHorizontal, GitFork, GitMerge, Plus, RefreshCcw, RefreshCw, Upload } from "lucide-react";
import { type MouseEvent as ReactMouseEvent } from "react";
import { type GitBlobPair } from "../../../lib/git";
import { ContextMenu } from "../../ContextMenu";
import { GitPanel } from "../GitPanel";
import { WorkspaceChangesView } from "../WorkspaceChangesView";
import { WorkspaceCommitLog } from "../WorkspaceCommitLog";
import { WorkspaceBranchesView } from "./BranchesView";
import { RepoSelector } from "./RepoSelector";
import { WorkspaceSettingsAggregateView } from "./SettingsAggregateView";
import { WorkspaceTagsView } from "./TagsView";
import { workspaceChangeMenuItems } from "./changeMenu";
import { EmptyState, ToolbarButton } from "./controls";
import { useWorkspaceGitBatch } from "./useWorkspaceGitBatch";
import { useWorkspaceGitChanges } from "./useWorkspaceGitChanges";
import { useWorkspaceGitRepositories } from "./useWorkspaceGitRepositories";

export interface WorkspaceGitManagerViewProps {
  repositories: ReturnType<typeof useWorkspaceGitRepositories>;
  visible: boolean;
  onOpenWorkspace: ((repoRoot: string, path?: string | null) => void) | undefined;
  totalChangedFiles: number;
  panelVersion: number;
  title: string;
  scopeSummary: string;
  scopeRepoCount: number;
  aggregate: { ahead: number; behind: number; };
  currentRemoteName: string;
  setRepoRemoteNames: import("react").Dispatch<import("react").SetStateAction<Record<string, string>>>;
  currentSnapshot: import("../../../lib/git").GitSnapshot | null;
  operationDisabled: boolean;
  batch: ReturnType<typeof useWorkspaceGitBatch>;
  setHeaderMenu: import("react").Dispatch<import("react").SetStateAction<{ x: number; y: number; } | null>>;
  busyLabel: string | null;
  refreshOperationRoots: () => Promise<void>;
  busy: boolean;
  treeMode: boolean;
  setTreeMode: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  checkedChangeKeys: Set<string>;
  checkedRepoCount: number;
  selectedChangeKeys: Set<string>;
  focusedChangeKey: string | null;
  pair: GitBlobPair | null;
  pairLoading: boolean;
  commitMessage: string;
  setCommitMessage: import("react").Dispatch<import("react").SetStateAction<string>>;
  canPushCheckedChanges: boolean;
  targetBranch: string;
  setTargetBranch: import("react").Dispatch<import("react").SetStateAction<string>>;
  commitBranchOptions: string[];
  changes: ReturnType<typeof useWorkspaceGitChanges>;
  commitWorkspaceChanges: (push: boolean) => void;
  toggleChangeChecked: (repoRoot: string, paths: string[], checked: boolean) => void;
  selectWorkspaceChange: (repoRoot: string, path: string, mods: { ctrl: boolean; shift: boolean; }) => void;
  openWorkspaceChangeMenu: (repoRoot: string, path: string, event: ReactMouseEvent) => void;
  focusedChange: { key: string; repoRoot: string; repoName: string; change: import("../../../lib/git").GitChange; } | null;
  headerMenu: { x: number; y: number; } | null;
  changeMenu: { x: number; y: number; } | null;
  setChangeMenu: import("react").Dispatch<import("react").SetStateAction<{ x: number; y: number; } | null>>;
  selectedOperationEntries: { key: string; repoRoot: string; repoName: string; change: import("../../../lib/git").GitChange; }[];
}

export function WorkspaceGitManagerView(inputs: WorkspaceGitManagerViewProps) {
  const {
    repositories,
    visible,
    onOpenWorkspace,
    totalChangedFiles,
    panelVersion,
    title,
    scopeSummary,
    scopeRepoCount,
    aggregate,
    currentRemoteName,
    setRepoRemoteNames,
    currentSnapshot,
    operationDisabled,
    batch,
    setHeaderMenu,
    busyLabel,
    refreshOperationRoots,
    busy,
    treeMode,
    setTreeMode,
    checkedChangeKeys,
    checkedRepoCount,
    selectedChangeKeys,
    focusedChangeKey,
    pair,
    pairLoading,
    commitMessage,
    setCommitMessage,
    canPushCheckedChanges,
    targetBranch,
    setTargetBranch,
    commitBranchOptions,
    changes,
    commitWorkspaceChanges,
    toggleChangeChecked,
    selectWorkspaceChange,
    openWorkspaceChangeMenu,
    focusedChange,
    headerMenu,
    changeMenu,
    setChangeMenu,
    selectedOperationEntries,
  } = inputs;
  return ((
    <div
      data-testid="workspace-git-manager"
      className="h-full w-full min-h-0 flex bg-[var(--taomni-bg)] text-[var(--taomni-text)]"
    >
      <main className="flex-1 min-w-0 min-h-0">
        {repositories.selectedRoot ? (
          <GitPanel
            repoRoot={repositories.selectedRoot.repoRoot}
            visible={visible}
            onOpenWorkspace={onOpenWorkspace}
            changeCountOverride={totalChangedFiles}
            refreshToken={panelVersion}
            workspaceHeader={{
              title,
              summary: scopeSummary,
              selectedRepoName: repositories.selectedRoot.name,
              selectedRepoRoot: repositories.selectedRoot.repoRoot,
              repoSelector: (
                <RepoSelector
                  roots={repositories.normalizedRoots}
                  snapshots={repositories.snapshots}
                  scope={repositories.repoScope}
                  selectedRoot={repositories.selectedRoot}
                  scopedRoots={repositories.scopedRoots}
                  onScopeChange={(next) => {
                    repositories.setRepoScope(next);
                    if (next.mode === "single") repositories.setSelectedRepoRoot(next.repoRoot);
                    if (next.mode === "custom" && !next.repoRoots.includes(repositories.selectedRepoRoot)) {
                      repositories.setSelectedRepoRoot(next.repoRoots[0] ?? "");
                    }
                  }}
                />
              ),
              branchBadge: repositories.repoScopeIsMulti ? (
                <span className="inline-flex items-center gap-1 h-6 px-2 rounded bg-[var(--taomni-hover)] text-[12px]">
                  <GitCommitHorizontal className="w-3.5 h-3.5" />
                  {repositories.repoScopeIsAll ? "All Repositories" : `${scopeRepoCount} Repositories`}
                </span>
              ) : undefined,
              changeSummary: (
                <span className="text-[11px] text-[var(--taomni-text-muted)]">
                  {totalChangedFiles} changes
                  {aggregate.ahead || aggregate.behind ? ` · ↑${aggregate.ahead} ↓${aggregate.behind}` : ""}
                </span>
              ),
              actionControls: (
                <>
                  <select
                    className="taomni-input h-7 w-32"
                    value={repositories.repoScopeIsMulti ? "__default__" : currentRemoteName}
                    onChange={(event) => {
                      if (!repositories.selectedRoot) return;
                      setRepoRemoteNames((current) => ({
                        ...current,
                        [repositories.selectedRoot.repoRoot]: event.target.value,
                      }));
                    }}
                    disabled={repositories.repoScopeIsMulti || !currentSnapshot?.remotes.length}
                    title={repositories.repoScopeIsMulti ? "Multiple repositories use their default remotes" : undefined}
                  >
                    {repositories.repoScopeIsMulti ? (
                      <option value="__default__">Default remotes</option>
                    ) : currentSnapshot?.remotes.length ? currentSnapshot.remotes.map((remote) => (
                      <option key={remote.name} value={remote.name}>{remote.name}</option>
                    )) : (
                      <option value="">No remote</option>
                    )}
                  </select>
                  <ToolbarButton
                    label="Fetch"
                    icon={<Download className="w-3.5 h-3.5" />}
                    disabled={operationDisabled}
                    onClick={() => void batch.batchFetch()}
                  />
                  <ToolbarButton
                    label="Pull"
                    icon={<GitMerge className="w-3.5 h-3.5" />}
                    disabled={operationDisabled}
                    onClick={() => void batch.batchPull()}
                  />
                  <ToolbarButton
                    label="Push"
                    icon={<Upload className="w-3.5 h-3.5" />}
                    disabled={operationDisabled}
                    onClick={() => void batch.batchPush()}
                  />
                  <button
                    type="button"
                    className="taomni-btn h-7 w-7 inline-flex items-center justify-center"
                    title="More Git actions"
                    aria-label="More Git actions"
                    disabled={operationDisabled}
                    onClick={(event) => setHeaderMenu({ x: event.clientX, y: event.clientY })}
                  >
                    <Ellipsis className="w-3.5 h-3.5 text-[var(--taomni-text)]" />
                  </button>
                  <ToolbarButton
                    label="Refresh"
                    icon={<RefreshCw className={`w-3.5 h-3.5 ${busyLabel === "Refresh" ? "animate-spin" : ""}`} />}
                    disabled={operationDisabled}
                    onClick={() => void refreshOperationRoots()}
                  />
                </>
              ),
            }}
            workspaceLogView={(
              <WorkspaceCommitLog
                roots={repositories.scopedRoots}
                snapshots={repositories.snapshots}
                busy={busy}
              />
            )}
            workspaceBranchesView={repositories.repoScopeIsMulti ? (
              <WorkspaceBranchesView
                roots={repositories.scopedRoots}
                snapshots={repositories.snapshots}
              />
            ) : undefined}
            workspaceTagsView={repositories.repoScopeIsMulti ? (
              <WorkspaceTagsView
                roots={repositories.scopedRoots}
                snapshots={repositories.snapshots}
              />
            ) : undefined}
            workspaceSettingsAggregateView={repositories.scopedRoots.length > 1 ? ((showCurrent) => (
              <WorkspaceSettingsAggregateView
                roots={repositories.scopedRoots}
                snapshots={repositories.snapshots}
                onSelectRepo={(repoRoot) => {
                  repositories.setSelectedRepoRoot(repoRoot);
                  showCurrent();
                }}
              />
            )) : undefined}
            changesView={(
              <WorkspaceChangesView
                roots={repositories.scopedRoots}
                snapshots={repositories.snapshots}
                busy={busy}
                treeMode={treeMode}
                setTreeMode={setTreeMode}
                checkedKeys={checkedChangeKeys}
                checkedCount={checkedChangeKeys.size}
                checkedRepoCount={checkedRepoCount}
                selectedKeys={selectedChangeKeys}
                focusedKey={focusedChangeKey}
                pair={pair}
                pairLoading={pairLoading}
                commitMessage={commitMessage}
                setCommitMessage={setCommitMessage}
                canCommitAndPush={canPushCheckedChanges}
                scopeSummary={scopeSummary}
                targetBranch={targetBranch}
                setTargetBranch={setTargetBranch}
                branchOptions={commitBranchOptions}
                branchPlaceholder="Current branch (or type a new name)"
                stageVisible={changes.stageVisibleChanges}
                unstageVisible={changes.unstageVisibleChanges}
                stagePaths={changes.stagePathsInRepo}
                unstagePaths={changes.unstagePathsInRepo}
                stageSelected={changes.stageFocusedChange}
                unstageSelected={changes.unstageFocusedChange}
                discardSelected={changes.discardFocusedChange}
                commit={() => commitWorkspaceChanges(false)}
                commitAndPush={() => commitWorkspaceChanges(true)}
                onToggleChecked={toggleChangeChecked}
                onSelect={selectWorkspaceChange}
                onContextMenu={openWorkspaceChangeMenu}
                onNormalizeLineEndings={changes.normalizeFocusedLineEndings}
                normalizeLineEndingsBusy={busyLabel === "Normalize EOL"}
                onOpenInEditor={onOpenWorkspace ? changes.openFocusedInEditor : undefined}
                onSaveWorktree={changes.saveFocusedWorktree}
                worktreeEditable={!!focusedChange && focusedChange.change.status !== "deleted"}
              />
            )}
          />
        ) : (
          <EmptyState title="No Git repositories detected" />
        )}
      </main>
      {headerMenu && (
        <ContextMenu
          x={headerMenu.x}
          y={headerMenu.y}
          onClose={() => setHeaderMenu(null)}
          items={[
            {
              label: "Sync",
              icon: <RefreshCcw className="w-3.5 h-3.5" />,
              disabled: operationDisabled,
              onClick: () => void batch.batchSync(),
            },
            {
              label: "Checkout branch...",
              icon: <GitFork className="w-3.5 h-3.5" />,
              disabled: operationDisabled,
              onClick: () => batch.batchCheckout(),
            },
            {
              label: "New branch...",
              icon: <Plus className="w-3.5 h-3.5" />,
              disabled: operationDisabled,
              onClick: () => batch.batchCreateBranch(),
            },
            {
              label: "Open code workspace",
              icon: <Braces className="w-3.5 h-3.5" />,
              disabled: !onOpenWorkspace,
              onClick: () => {
                if (repositories.selectedRoot) onOpenWorkspace?.(repositories.selectedRoot.repoRoot);
              },
            },
            { label: "", separator: true },
            {
              label: "Force push with lease...",
              icon: <Upload className="w-3.5 h-3.5" />,
              disabled: operationDisabled,
              danger: true,
              onClick: batch.batchForcePush,
            },
          ]}
        />
      )}
      {changeMenu && (
        <ContextMenu
          x={changeMenu.x}
          y={changeMenu.y}
          onClose={() => setChangeMenu(null)}
          items={workspaceChangeMenuItems({
            entries: selectedOperationEntries,
            onStage: changes.stageSelectedChanges,
            onUnstage: changes.unstageSelectedChanges,
            onDiscard: changes.discardSelectedChanges,
          })}
        />
      )}
    </div>
  ));
}
