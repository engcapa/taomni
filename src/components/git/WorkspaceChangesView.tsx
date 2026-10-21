import { GitBranch } from "lucide-react";
import { useMemo, useState } from "react";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { useT } from "../../lib/i18n";
import { buildWorkspaceFlatGroups } from "../../lib/workspaceGitFlatList";
import { WorkspaceFlatChangesList } from "./changes/flat";
import { RepoChangeGroup } from "./changes/group";
import { type WorkspaceChangesViewProps } from "./changes/model";
import { workspaceChangeMatchesSearch } from "./changes/presentation";
import { pathsByRepoFromGroups, toggleSetValue } from "./changes/selection";
import {
  ChangesListToolbar,
  emptyGitChangeFilters,
  gitChangeMatchesFilters,
  hasActiveGitChangeFilters,
  type GitChangeFilters,
  type GitStageFilter,
  type GitStatusFilter,
} from "./shared/ChangesListToolbar";
import { CommitBar } from "./shared/CommitBar";
import { DiffPane } from "./shared/DiffPane";
import { parseWorkspaceChangeKey, workspaceChangeKey } from "./workspaceGitKeys";

export function WorkspaceChangesView({
  roots,
  snapshots,
  busy,
  treeMode,
  setTreeMode,
  checkedKeys,
  checkedCount,
  checkedRepoCount,
  selectedKeys,
  focusedKey,
  pair,
  pairLoading,
  commitMessage,
  setCommitMessage,
  canCommitAndPush,
  scopeSummary,
  targetBranch,
  setTargetBranch,
  branchOptions,
  branchPlaceholder,
  stageVisible,
  unstageVisible,
  stagePaths,
  unstagePaths,
  stageSelected,
  unstageSelected,
  discardSelected,
  commit,
  commitAndPush,
  onToggleChecked,
  onSelect,
  onContextMenu,
  onNormalizeLineEndings,
  normalizeLineEndingsBusy,
  onOpenInEditor,
  onSaveWorktree,
  worktreeEditable,
}: WorkspaceChangesViewProps) {
  const t = useT();
  const [filter, setFilter] = useState("");
  const [changeFilters, setChangeFilters] = useState<GitChangeFilters>(() => emptyGitChangeFilters());
  const normalizedFilter = filter.trim().toLowerCase();
  const groups = roots.map((root) => {
    const state = snapshots[root.repoRoot];
    const snapshot = state?.snapshot ?? null;
    return {
      root,
      state,
      snapshot,
      visibleChanges: (snapshot?.changes ?? []).filter((change) => {
        return gitChangeMatchesFilters(change, changeFilters)
          && workspaceChangeMatchesSearch(root, change, normalizedFilter);
      }),
    };
  });
  const totalChanges = groups.reduce((total, group) => total + (group.snapshot?.changes.length ?? 0), 0);
  const visibleChangeCount = groups.reduce((total, group) => total + group.visibleChanges.length, 0);
  const visibleStagedChangeCount = groups.reduce(
    (total, group) => total + group.visibleChanges.filter((change) => change.staged).length,
    0,
  );
  const visiblePathsByRepo = useMemo(() => pathsByRepoFromGroups(groups), [groups]);
  const visibleStagedPathsByRepo = useMemo(() => pathsByRepoFromGroups(groups, (change) => change.staged), [groups]);
  const hasVisibleGroups = groups.some((group) => (
    group.visibleChanges.length > 0 || group.state?.loading || group.state?.error
  ));
  const hasActiveFilters = hasActiveGitChangeFilters(changeFilters);
  const active = useMemo(() => {
    const parsed = focusedKey ? parseWorkspaceChangeKey(focusedKey) : null;
    if (!parsed) return null;
    const root = roots.find((entry) => entry.repoRoot === parsed.repoRoot) ?? null;
    const change = snapshots[parsed.repoRoot]?.snapshot?.changes.find((entry) => entry.path === parsed.path) ?? null;
    if (!root || !change) return null;
    return { root, change };
  }, [focusedKey, roots, snapshots]);
  // Same order as the flat list (repository name, then path) so previous/next
  // file navigation walks exactly the rows the user sees (ED-PARITY-008).
  const navigableChanges = useMemo(() => buildWorkspaceFlatGroups(
    groups.map((group) => group.root),
    new Map(groups.map((group) => [group.root.repoRoot, group.visibleChanges] as const)),
  ).flatMap((group) => group.changes.map((change) => ({ repoRoot: group.root.repoRoot, path: change.path }))), [groups]);
  const focusedNavIndex = focusedKey
    ? navigableChanges.findIndex((entry) => workspaceChangeKey(entry.repoRoot, entry.path) === focusedKey)
    : -1;
  const selectNavigable = (index: number) => {
    const entry = navigableChanges[index];
    if (entry) onSelect(entry.repoRoot, entry.path, { ctrl: false, shift: false });
  };
  const activeHeadOid = active ? snapshots[active.root.repoRoot]?.snapshot?.headOid ?? null : null;
  const sideLabels = active ? {
    old: activeHeadOid ? `HEAD ${activeHeadOid.slice(0, 8)} · ${active.change.oldPath ?? active.change.path}` : "HEAD",
    new: `Working tree · ${active.change.path}`,
  } : null;
  const canCommit = !busy && checkedCount > 0 && commitMessage.trim().length > 0;
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(() => new Set());
  const toggleStageFilter = (filterKey: GitStageFilter) => {
    setChangeFilters((current) => ({
      ...current,
      stage: toggleSetValue(current.stage, filterKey),
    }));
  };
  const toggleStatusFilter = (filterKey: GitStatusFilter) => {
    setChangeFilters((current) => ({
      ...current,
      status: toggleSetValue(current.status, filterKey),
    }));
  };
  const clearChangeFilters = () => {
    setChangeFilters(emptyGitChangeFilters());
  };
  const selectVisible = (value: boolean) => {
    for (const group of groups) {
      const paths = group.visibleChanges.map((change) => change.path);
      if (paths.length > 0) onToggleChecked(group.root.repoRoot, paths, value);
    }
  };
  const toggleRepoCollapsed = (repoRoot: string) => {
    setCollapsedRepos((current) => {
      const next = new Set(current);
      if (next.has(repoRoot)) next.delete(repoRoot);
      else next.add(repoRoot);
      return next;
    });
  };

  return (
    <PanelGroup orientation="horizontal" id="workspace-git-changes-layout">
      <Panel id="workspace-changes-list" defaultSize="38%" minSize="26%" className="min-w-0 min-h-0 flex flex-col border-r border-[var(--taomni-divider)]">
        <div className="h-8 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)]">
          <GitBranch className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-accent)]" />
          <span className="font-semibold text-[12px]">{t("git.workspaceChanges.title")}</span>
          <span className="min-w-0 truncate text-[11px] text-[var(--taomni-text-muted)]">{scopeSummary}</span>
        </div>
        <ChangesListToolbar
          busy={busy}
          filter={filter}
          onFilterChange={setFilter}
          filters={changeFilters}
          onToggleStageFilter={toggleStageFilter}
          onToggleStatusFilter={toggleStatusFilter}
          onClearFilters={clearChangeFilters}
          checkedCount={checkedCount}
          totalCount={totalChanges}
          visibleCount={visibleChangeCount}
          visibleStagedCount={visibleStagedChangeCount}
          treeMode={treeMode}
          onCheckVisible={() => selectVisible(true)}
          onUncheckVisible={() => selectVisible(false)}
          onStageVisible={() => stageVisible(visiblePathsByRepo)}
          onUnstageVisible={() => unstageVisible(visibleStagedPathsByRepo)}
          onToggleTreeMode={() => setTreeMode(!treeMode)}
        />

        <div className="flex-1 min-h-0 overflow-auto">
          {!hasVisibleGroups ? (
            <div className="h-full min-h-24 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
              {normalizedFilter || hasActiveFilters
                ? t("git.workspaceChanges.noMatchingChanges")
                : t("git.workspaceChanges.noLocalChanges")}
            </div>
          ) : treeMode ? (
            groups.map(({ root, state, snapshot, visibleChanges }) => (
              <RepoChangeGroup
                key={root.repoRoot}
                root={root}
                snapshot={snapshot}
                changes={visibleChanges}
                loading={!!state?.loading}
                error={state?.error ?? null}
                treeMode={treeMode}
                checkedKeys={checkedKeys}
                selectedKeys={selectedKeys}
                focusedKey={focusedKey}
                collapsed={collapsedRepos.has(root.repoRoot)}
                onToggleCollapsed={() => toggleRepoCollapsed(root.repoRoot)}
                busy={busy}
                onToggleChecked={onToggleChecked}
                onStagePaths={stagePaths}
                onUnstagePaths={unstagePaths}
                onSelect={onSelect}
                onContextMenu={onContextMenu}
              />
            ))
          ) : (
            <WorkspaceFlatChangesList
              groups={groups}
              checkedKeys={checkedKeys}
              selectedKeys={selectedKeys}
              focusedKey={focusedKey}
              collapsedRepos={collapsedRepos}
              onToggleCollapsed={toggleRepoCollapsed}
              onToggleChecked={onToggleChecked}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
            />
          )}
        </div>

        <CommitBar
          message={commitMessage}
          onMessageChange={setCommitMessage}
          canCommit={canCommit}
          canCommitAndPush={canCommit && canCommitAndPush}
          onCommit={commit}
          onCommitAndPush={commitAndPush}
          summary={`${checkedCount} files in ${checkedRepoCount} repos`}
          targetBranch={targetBranch}
          onTargetBranchChange={setTargetBranch}
          branchOptions={branchOptions}
          branchPlaceholder={branchPlaceholder}
        />
      </Panel>

      <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] cursor-col-resize" />

      <Panel id="workspace-changes-diff" defaultSize="62%" minSize="35%" className="min-w-0 min-h-0 flex flex-col">
        <DiffPane
          title={active ? `${active.root.name} / ${active.change.path}` : t("git.workspaceChanges.diffTitle")}
          busy={busy}
          selectedCount={active ? 1 : 0}
          pair={pair}
          pairLoading={pairLoading}
          repoRoot={active?.root.repoRoot ?? null}
          sideLabels={sideLabels}
          fileNavigation={{
            index: focusedNavIndex,
            count: navigableChanges.length,
            onPrevious: () => selectNavigable(focusedNavIndex - 1),
            onNext: () => selectNavigable(focusedNavIndex + 1),
          }}
          onStage={stageSelected}
          onUnstage={unstageSelected}
          onDiscard={discardSelected}
          onNormalizeLineEndings={onNormalizeLineEndings}
          normalizeLineEndingsBusy={normalizeLineEndingsBusy}
          onOpenInEditor={onOpenInEditor}
          onSaveWorktree={onSaveWorktree}
          worktreeEditable={worktreeEditable}
        />
      </Panel>
    </PanelGroup>
  );
}

export { type WorkspaceChangesViewProps } from "./changes/model";
