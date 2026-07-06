import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CircleMinus,
  CirclePlus,
  FilePenLine,
  FileQuestion,
  FileSymlink,
  FileX,
  GitBranch,
  List,
  ListChecks,
  ListFilter,
  ListTree,
  ListX,
  Loader2,
  Search,
  SquareCheckBig,
  TriangleAlert,
} from "lucide-react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import { type GitBlobPair, type GitChange, type GitSnapshot } from "../../lib/git";
import { useT, type TranslateFn } from "../../lib/i18n";
import type { GitWorkspaceRootInfo } from "../../types";
import { ChangesTree } from "./ChangesTree";
import { CommitBar } from "./shared/CommitBar";
import { DiffPane } from "./shared/DiffPane";
import { parseWorkspaceChangeKey, workspaceChangeKey } from "./workspaceGitKeys";

type TriState = "all" | "none" | "some";
type WorkspaceStageFilter = "staged" | "unstaged";
type WorkspaceStatusFilter = "modified" | "untracked" | "deleted" | "renamed" | "conflict";

interface WorkspaceChangeRow {
  root: GitWorkspaceRootInfo;
  change: GitChange;
  key: string;
}

export interface WorkspaceChangesViewProps {
  roots: GitWorkspaceRootInfo[];
  snapshots: Record<string, {
    snapshot: GitSnapshot | null;
    loading: boolean;
    error: string | null;
  }>;
  busy: boolean;
  treeMode: boolean;
  setTreeMode: (value: boolean) => void;
  checkedKeys: Set<string>;
  checkedCount: number;
  checkedRepoCount: number;
  selectedKeys: Set<string>;
  focusedKey: string | null;
  pair: GitBlobPair | null;
  pairLoading: boolean;
  commitMessage: string;
  setCommitMessage: (message: string) => void;
  canCommitAndPush: boolean;
  scopeSummary: string;
  stageVisible: (pathsByRepo: Record<string, string[]>) => void;
  unstageVisible: (pathsByRepo: Record<string, string[]>) => void;
  stagePaths: (repoRoot: string, paths: string[]) => void;
  unstagePaths: (repoRoot: string, paths: string[]) => void;
  stageSelected: () => void;
  unstageSelected: () => void;
  discardSelected: () => void;
  commit: () => void;
  commitAndPush: () => void;
  onToggleChecked: (repoRoot: string, paths: string[], value: boolean) => void;
  onSelect: (repoRoot: string, path: string, mods: { ctrl: boolean; shift: boolean }) => void;
  onContextMenu: (repoRoot: string, path: string, event: ReactMouseEvent) => void;
}

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
}: WorkspaceChangesViewProps) {
  const t = useT();
  const [filter, setFilter] = useState("");
  const [checkedOnlyFilter, setCheckedOnlyFilter] = useState(false);
  const [stageFilters, setStageFilters] = useState<Set<WorkspaceStageFilter>>(() => new Set());
  const [statusFilters, setStatusFilters] = useState<Set<WorkspaceStatusFilter>>(() => new Set());
  const normalizedFilter = filter.trim().toLowerCase();
  const groups = roots.map((root) => {
    const state = snapshots[root.repoRoot];
    const snapshot = state?.snapshot ?? null;
    return {
      root,
      state,
      snapshot,
      visibleChanges: (snapshot?.changes ?? []).filter((change) => {
        const key = workspaceChangeKey(root.repoRoot, change.path);
        return workspaceChangeMatchesFilters({
          root,
          change,
          normalizedFilter,
          checked: checkedKeys.has(key),
          checkedOnlyFilter,
          stageFilters,
          statusFilters,
        });
      }),
    };
  });
  const flatRows = groups.flatMap((group) => (
    group.visibleChanges.map((change) => ({
      root: group.root,
      change,
      key: workspaceChangeKey(group.root.repoRoot, change.path),
    }))
  )).sort((a, b) => {
    const repoCompare = a.root.name.localeCompare(b.root.name);
    return repoCompare || a.change.path.localeCompare(b.change.path);
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
  const hasStagedVisible = groups.some((group) => group.visibleChanges.some((change) => change.staged));
  const hasButtonFilters = checkedOnlyFilter || stageFilters.size > 0 || statusFilters.size > 0;
  const active = useMemo(() => {
    const parsed = focusedKey ? parseWorkspaceChangeKey(focusedKey) : null;
    if (!parsed) return null;
    const root = roots.find((entry) => entry.repoRoot === parsed.repoRoot) ?? null;
    const change = snapshots[parsed.repoRoot]?.snapshot?.changes.find((entry) => entry.path === parsed.path) ?? null;
    if (!root || !change) return null;
    return { root, change };
  }, [focusedKey, roots, snapshots]);
  const canCommit = !busy && checkedCount > 0 && commitMessage.trim().length > 0;
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(() => new Set());
  const toggleStageFilter = (filterKey: WorkspaceStageFilter) => {
    setStageFilters((current) => toggleSetValue(current, filterKey));
  };
  const toggleStatusFilter = (filterKey: WorkspaceStatusFilter) => {
    setStatusFilters((current) => toggleSetValue(current, filterKey));
  };
  const clearChangeFilters = () => {
    setCheckedOnlyFilter(false);
    setStageFilters(new Set());
    setStatusFilters(new Set());
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
      <Panel id="workspace-changes-list" defaultSize={38} minSize={26} className="min-w-0 min-h-0 flex flex-col border-r border-[var(--taomni-divider)]">
        <div className="h-8 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)]">
          <GitBranch className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-accent)]" />
          <span className="font-semibold text-[12px]">{t("git.workspaceChanges.title")}</span>
          <span className="min-w-0 truncate text-[11px] text-[var(--taomni-text-muted)]">{scopeSummary}</span>
        </div>
        <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--taomni-divider)] overflow-x-auto">
          <div className="relative min-w-28 flex-1">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
            <input
              className="taomni-input h-7 w-full pl-7"
              value={filter}
              placeholder={t("git.workspaceChanges.filterPlaceholder")}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
          <div className="shrink-0 flex items-center gap-0.5 overflow-x-auto">
            <WorkspaceToolButton
              label={t("git.workspaceChanges.showAll")}
              active={!hasButtonFilters}
              disabled={!hasButtonFilters}
              onClick={clearChangeFilters}
              icon={<ListFilter className="w-3.5 h-3.5" />}
            />
            <WorkspaceToolButton
              label={t("git.workspaceChanges.showSelected")}
              active={checkedOnlyFilter}
              onClick={() => setCheckedOnlyFilter((current) => !current)}
              icon={<SquareCheckBig className="w-3.5 h-3.5" />}
            />
            <WorkspaceToolButton
              label={t("git.workspaceChanges.showUnstaged")}
              active={stageFilters.has("unstaged")}
              onClick={() => toggleStageFilter("unstaged")}
              icon={<CircleDashed className="w-3.5 h-3.5" />}
            />
            <WorkspaceToolButton
              label={t("git.workspaceChanges.showStaged")}
              active={stageFilters.has("staged")}
              onClick={() => toggleStageFilter("staged")}
              icon={<CheckCircle2 className="w-3.5 h-3.5" />}
            />
            <WorkspaceToolButton
              label={t("git.workspaceChanges.filterModified")}
              active={statusFilters.has("modified")}
              onClick={() => toggleStatusFilter("modified")}
              icon={<FilePenLine className="w-3.5 h-3.5" />}
            />
            <WorkspaceToolButton
              label={t("git.workspaceChanges.filterUntracked")}
              active={statusFilters.has("untracked")}
              onClick={() => toggleStatusFilter("untracked")}
              icon={<FileQuestion className="w-3.5 h-3.5" />}
            />
            <WorkspaceToolButton
              label={t("git.workspaceChanges.filterDeleted")}
              active={statusFilters.has("deleted")}
              onClick={() => toggleStatusFilter("deleted")}
              icon={<FileX className="w-3.5 h-3.5" />}
            />
            <WorkspaceToolButton
              label={t("git.workspaceChanges.filterRenamed")}
              active={statusFilters.has("renamed")}
              onClick={() => toggleStatusFilter("renamed")}
              icon={<FileSymlink className="w-3.5 h-3.5" />}
            />
            <WorkspaceToolButton
              label={t("git.workspaceChanges.filterConflicted")}
              active={statusFilters.has("conflict")}
              onClick={() => toggleStatusFilter("conflict")}
              icon={<TriangleAlert className="w-3.5 h-3.5" />}
            />
            <ToolbarDivider />
            <WorkspaceToolButton
              label={t("git.workspaceChanges.selectVisible", { count: visibleChangeCount })}
              disabled={visibleChangeCount === 0}
              onClick={() => selectVisible(true)}
              icon={<ListChecks className="w-3.5 h-3.5" />}
            />
            <WorkspaceToolButton
              label={t("git.workspaceChanges.unselectVisible", { count: visibleChangeCount })}
              disabled={visibleChangeCount === 0}
              onClick={() => selectVisible(false)}
              icon={<ListX className="w-3.5 h-3.5" />}
            />
            <ToolbarDivider />
            <WorkspaceToolButton
              label={t("git.workspaceChanges.stageVisible", { count: visibleChangeCount })}
              disabled={busy || visibleChangeCount === 0}
              onClick={() => stageVisible(visiblePathsByRepo)}
              icon={<CirclePlus className="w-3.5 h-3.5" />}
            />
            <WorkspaceToolButton
              label={t("git.workspaceChanges.unstageVisible", { count: visibleStagedChangeCount })}
              disabled={busy || !hasStagedVisible}
              onClick={() => unstageVisible(visibleStagedPathsByRepo)}
              icon={<CircleMinus className="w-3.5 h-3.5" />}
            />
            <ToolbarDivider />
            <span className="shrink-0 min-w-10 text-center text-[11px] text-[var(--taomni-text-muted)]">
              {checkedCount}/{totalChanges}
            </span>
            <WorkspaceToolButton
              label={treeMode ? t("git.workspaceChanges.switchToFlatList") : t("git.workspaceChanges.switchToDirectoryTree")}
              onClick={() => setTreeMode(!treeMode)}
              icon={treeMode ? <List className="w-3.5 h-3.5" /> : <ListTree className="w-3.5 h-3.5" />}
            />
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-auto">
          {!hasVisibleGroups ? (
            <div className="h-full min-h-24 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
              {normalizedFilter || hasButtonFilters
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
              rows={flatRows}
              checkedKeys={checkedKeys}
              selectedKeys={selectedKeys}
              focusedKey={focusedKey}
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
        />
      </Panel>

      <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] cursor-col-resize" />

      <Panel id="workspace-changes-diff" defaultSize={62} minSize={35} className="min-w-0 min-h-0 flex flex-col">
        <DiffPane
          title={active ? `${active.root.name} / ${active.change.path}` : t("git.workspaceChanges.diffTitle")}
          busy={busy}
          selectedCount={active ? 1 : 0}
          pair={pair}
          pairLoading={pairLoading}
          onStage={stageSelected}
          onUnstage={unstageSelected}
          onDiscard={discardSelected}
        />
      </Panel>
    </PanelGroup>
  );
}

function WorkspaceToolButton({
  label,
  icon,
  active = false,
  disabled = false,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`taomni-btn h-7 w-7 shrink-0 inline-flex items-center justify-center px-0 ${
        active ? "bg-[var(--taomni-accent)] text-white border-[var(--taomni-accent)]" : ""
      }`}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

function ToolbarDivider() {
  return <span className="mx-0.5 h-5 w-px shrink-0 bg-[var(--taomni-divider)]" aria-hidden="true" />;
}

function WorkspaceFlatChangesList({
  groups,
  rows,
  checkedKeys,
  selectedKeys,
  focusedKey,
  onToggleChecked,
  onSelect,
  onContextMenu,
}: {
  groups: Array<{
    root: GitWorkspaceRootInfo;
    state: WorkspaceChangesViewProps["snapshots"][string] | undefined;
    snapshot: GitSnapshot | null;
    visibleChanges: GitSnapshot["changes"];
  }>;
  rows: WorkspaceChangeRow[];
  checkedKeys: Set<string>;
  selectedKeys: Set<string>;
  focusedKey: string | null;
  onToggleChecked: (repoRoot: string, paths: string[], value: boolean) => void;
  onSelect: (repoRoot: string, path: string, mods: { ctrl: boolean; shift: boolean }) => void;
  onContextMenu: (repoRoot: string, path: string, event: ReactMouseEvent) => void;
}) {
  const statusRows = groups.filter((group) => group.state?.loading || group.state?.error);

  return (
    <div className="min-h-full">
      {rows.map((row) => (
        <WorkspaceFlatChangeRow
          key={row.key}
          row={row}
          checked={checkedKeys.has(row.key)}
          selected={selectedKeys.has(row.key)}
          active={focusedKey === row.key}
          onToggleChecked={(value) => onToggleChecked(row.root.repoRoot, [row.change.path], value)}
          onSelect={(mods) => onSelect(row.root.repoRoot, row.change.path, mods)}
          onContextMenu={(event) => onContextMenu(row.root.repoRoot, row.change.path, event)}
        />
      ))}
      {statusRows.map((group) => (
        <RepoFlatStatusRow
          key={group.root.repoRoot}
          root={group.root}
          loading={!!group.state?.loading}
          error={group.state?.error ?? null}
        />
      ))}
    </div>
  );
}

function WorkspaceFlatChangeRow({
  row,
  checked,
  selected,
  active,
  onToggleChecked,
  onSelect,
  onContextMenu,
}: {
  row: WorkspaceChangeRow;
  checked: boolean;
  selected: boolean;
  active: boolean;
  onToggleChecked: (value: boolean) => void;
  onSelect: (mods: { ctrl: boolean; shift: boolean }) => void;
  onContextMenu: (event: ReactMouseEvent) => void;
}) {
  const { root, change } = row;
  const t = useT();
  const repoColor = repoColorFor(root.repoRoot);
  const pathDir = workspaceDirectoryLabel(root.name, change.path);
  const oldPathLabel = change.oldPath ? workspacePathLabel(root.name, change.oldPath) : "";
  const status = workspaceStatusMeta(change, t);
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="workspace-change-row"
      aria-label={`${root.name} ${change.path} ${status.statusLabel}`}
      title={`${root.repoRoot}\n${change.path}`}
      className={`group relative w-full min-h-[48px] pr-2 py-1.5 flex items-center gap-2 text-left cursor-pointer border-b border-[var(--taomni-divider)] ${
        active ? "bg-[var(--taomni-hover)]" : selected ? "bg-[var(--taomni-accent)]/10" : "hover:bg-[var(--taomni-hover)]"
      }`}
      style={{ borderLeft: `3px solid ${repoColor.border}` }}
      onClick={(event) => onSelect({ ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey })}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect({ ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey });
        }
      }}
    >
      <input
        type="checkbox"
        className="ml-1 shrink-0 accent-[var(--taomni-accent)]"
        checked={checked}
        aria-label={t("git.workspaceChanges.selectFile", { repo: root.name, path: change.path })}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onToggleChecked(event.target.checked)}
      />
      <span
        className="shrink-0 w-12 rounded px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase"
        style={{
          background: repoColor.bg,
          border: `1px solid ${repoColor.border}`,
          color: repoColor.text,
        }}
        title={root.repoRoot}
      >
        {repoAbbr(root.name || root.repoRoot)}
      </span>
      <span
        className={`shrink-0 w-6 rounded px-1 py-0.5 text-center text-[10px] font-semibold ${status.kindClass}`}
        title={status.statusLabel}
        aria-label={status.statusLabel}
      >
        {status.kindLabel}
      </span>
      <div className="min-w-0 flex-1">
        <div className="min-w-0">
          <span className="block min-w-0 truncate text-[12px] font-semibold">{fileName(change.path)}</span>
        </div>
        <div className="truncate text-[11px] text-[var(--taomni-text-muted)]">
          {pathDir}
          {change.oldPath ? ` · ${t("git.workspaceChanges.fromPath", { path: oldPathLabel })}` : ""}
        </div>
      </div>
    </div>
  );
}

function RepoFlatStatusRow({
  root,
  loading,
  error,
}: {
  root: GitWorkspaceRootInfo;
  loading: boolean;
  error: string | null;
}) {
  const t = useT();
  const color = repoColorFor(root.repoRoot);
  return (
    <div
      className="min-h-[36px] px-2 py-2 flex items-center gap-2 border-b border-[var(--taomni-divider)] text-[12px]"
      style={{ borderLeft: `3px solid ${color.border}` }}
    >
      <span
        className="shrink-0 w-12 rounded px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase"
        style={{ background: color.bg, border: `1px solid ${color.border}`, color: color.text }}
      >
        {repoAbbr(root.name || root.repoRoot)}
      </span>
      {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--taomni-accent)]" /> : null}
      {error ? <AlertTriangle className="w-3.5 h-3.5 text-red-500" /> : null}
      <span className={error ? "truncate text-red-500" : "truncate text-[var(--taomni-text-muted)]"}>
        {error ?? t("git.workspaceChanges.loadingChanges")}
      </span>
    </div>
  );
}

function RepoChangeGroup({
  root,
  snapshot,
  changes,
  loading,
  error,
  treeMode,
  checkedKeys,
  selectedKeys,
  focusedKey,
  collapsed,
  onToggleCollapsed,
  busy,
  onToggleChecked,
  onStagePaths,
  onUnstagePaths,
  onSelect,
  onContextMenu,
}: {
  root: GitWorkspaceRootInfo;
  snapshot: GitSnapshot | null;
  changes: GitSnapshot["changes"];
  loading: boolean;
  error: string | null;
  treeMode: boolean;
  checkedKeys: Set<string>;
  selectedKeys: Set<string>;
  focusedKey: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  busy: boolean;
  onToggleChecked: (repoRoot: string, paths: string[], value: boolean) => void;
  onStagePaths: (repoRoot: string, paths: string[]) => void;
  onUnstagePaths: (repoRoot: string, paths: string[]) => void;
  onSelect: (repoRoot: string, path: string, mods: { ctrl: boolean; shift: boolean }) => void;
  onContextMenu: (repoRoot: string, path: string, event: ReactMouseEvent) => void;
}) {
  const t = useT();
  if (changes.length === 0 && !loading && !error) return null;

  const branch = snapshot?.detached ? `detached ${snapshot.headOid ?? ""}` : snapshot?.currentBranch ?? "No branch";
  const checkedCount = changes.filter((change) => checkedKeys.has(workspaceChangeKey(root.repoRoot, change.path))).length;
  const checkedPaths = new Set(
    changes
      .filter((change) => checkedKeys.has(workspaceChangeKey(root.repoRoot, change.path)))
      .map((change) => change.path),
  );
  const selectedPaths = new Set(
    changes
      .filter((change) => selectedKeys.has(workspaceChangeKey(root.repoRoot, change.path)))
      .map((change) => change.path),
  );
  const parsedFocus = focusedKey ? parseWorkspaceChangeKey(focusedKey) : null;
  const activePath = parsedFocus?.repoRoot === root.repoRoot ? parsedFocus.path : null;

  return (
    <section className="border-b border-[var(--taomni-divider)]">
      <div className="h-8 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)]">
        <button
          type="button"
          className="shrink-0 flex items-center justify-center text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"
          aria-label={collapsed
            ? t("git.workspaceChanges.expandRepository", { repo: root.name })
            : t("git.workspaceChanges.collapseRepository", { repo: root.name })}
          onClick={onToggleCollapsed}
        >
          {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
        <TriCheckbox
          state={checkState(checkedCount, changes.length)}
          disabled={changes.length === 0}
          ariaLabel={t("git.workspaceChanges.selectRepoChanges", { repo: root.name })}
          onChange={(value) => onToggleChecked(root.repoRoot, changes.map((change) => change.path), value)}
        />
        <GitBranch className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-accent)]" />
        <span className="min-w-0 truncate text-[12px] font-medium">{root.name}</span>
        <span className="min-w-0 truncate text-[11px] text-[var(--taomni-text-muted)]">{branch}</span>
        <div className="flex-1" />
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--taomni-accent)]" />}
        {error && <AlertTriangle className="w-3.5 h-3.5 text-red-500" />}
        <span className="shrink-0 rounded bg-[var(--taomni-hover)] px-1.5 py-0.5 text-[11px] text-[var(--taomni-text-muted)]">
          {checkedCount}/{changes.length}
        </span>
      </div>
      {collapsed ? null : error ? (
        <div className="px-8 py-2 text-[11px] text-red-500" title={error}>
          {error}
        </div>
      ) : changes.length > 0 ? (
        <>
          <ChangesTree
            changes={changes}
            treeMode={treeMode}
            showSectionActions={false}
            checked={checkedPaths}
            onToggleChecked={(paths, value) => onToggleChecked(root.repoRoot, paths, value)}
            busy={busy}
            onStagePaths={(paths) => onStagePaths(root.repoRoot, paths)}
            onUnstagePaths={(paths) => onUnstagePaths(root.repoRoot, paths)}
            selected={selectedPaths}
            activePath={activePath}
            onSelect={(path, mods) => onSelect(root.repoRoot, path, mods)}
            onContextMenu={(path, event) => onContextMenu(root.repoRoot, path, event)}
          />
        </>
      ) : loading ? (
        <div className="px-8 py-2 text-[11px] text-[var(--taomni-text-muted)]">
          {t("git.workspaceChanges.loadingChanges")}
        </div>
      ) : null}
    </section>
  );
}

function TriCheckbox({
  state,
  disabled,
  ariaLabel,
  onChange,
}: {
  state: TriState;
  disabled?: boolean;
  ariaLabel?: string;
  onChange: (value: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <input
      ref={(el) => {
        ref.current = el;
        if (el) el.indeterminate = state === "some";
      }}
      type="checkbox"
      className="shrink-0 accent-[var(--taomni-accent)]"
      checked={state === "all"}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

function checkState(checkedCount: number, totalCount: number): TriState {
  if (totalCount === 0 || checkedCount === 0) return "none";
  if (checkedCount === totalCount) return "all";
  return "some";
}

function fileName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function workspaceDirectoryLabel(repoName: string, path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return [repoName || "repo", ...parts].join(" / ") + " /";
}

function workspacePathLabel(repoName: string, path: string): string {
  return [repoName || "repo", ...path.split("/").filter(Boolean)].join(" / ");
}

function repoAbbr(name: string): string {
  const words = name
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length >= 2) return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  const compact = (words[0] ?? name).replace(/[^a-zA-Z0-9]/g, "");
  return (compact.slice(0, 3) || "repo").toUpperCase();
}

function workspaceStatusMeta(change: GitChange, t: TranslateFn): {
  kindLabel: string;
  kindClass: string;
  statusLabel: string;
} {
  if (change.conflict) {
    return {
      kindLabel: "!",
      kindClass: "bg-red-500/15 text-red-500",
      statusLabel: t("git.workspaceChanges.statusConflict"),
    };
  }
  if (change.staged) {
    return {
      kindLabel: shortChangeKind(change),
      kindClass: "bg-emerald-500/15 text-emerald-600",
      statusLabel: t("git.workspaceChanges.statusStaged"),
    };
  }
  if (change.status === "untracked") {
    return {
      kindLabel: "?",
      kindClass: "bg-amber-500/15 text-amber-600",
      statusLabel: t("git.workspaceChanges.statusUntracked"),
    };
  }
  return {
    kindLabel: shortChangeKind(change),
    kindClass: "bg-blue-500/15 text-blue-500",
    statusLabel: statusLabelForChange(change, t),
  };
}

function statusLabelForChange(change: GitChange, t: TranslateFn): string {
  if (change.status === "renamed") return t("git.workspaceChanges.statusRenamed");
  if (change.status === "deleted") return t("git.workspaceChanges.statusDeleted");
  if (change.status === "added") return t("git.workspaceChanges.statusAdded");
  return t("git.workspaceChanges.statusModified");
}

function shortChangeKind(change: GitChange): string {
  if (change.status === "renamed") return "R";
  if (change.status === "deleted") return "D";
  if (change.status === "added") return "A";
  if (change.status === "untracked") return "?";
  return "M";
}

function repoColorFor(repoRoot: string): { bg: string; border: string; text: string } {
  const palette = [
    { bg: "#DBEAFE", border: "#2563EB", text: "#1D4ED8" },
    { bg: "#DCFCE7", border: "#16A34A", text: "#15803D" },
    { bg: "#FEF3C7", border: "#D97706", text: "#B45309" },
    { bg: "#FCE7F3", border: "#DB2777", text: "#BE185D" },
    { bg: "#E0F2FE", border: "#0284C7", text: "#0369A1" },
    { bg: "#EDE9FE", border: "#7C3AED", text: "#6D28D9" },
    { bg: "#CCFBF1", border: "#0D9488", text: "#0F766E" },
    { bg: "#FFE4E6", border: "#E11D48", text: "#BE123C" },
  ];
  let hash = 0;
  for (let i = 0; i < repoRoot.length; i += 1) {
    hash = (hash * 31 + repoRoot.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}

function toggleSetValue<T>(current: Set<T>, value: T): Set<T> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function pathsByRepoFromGroups(
  groups: Array<{
    root: GitWorkspaceRootInfo;
    visibleChanges: GitSnapshot["changes"];
  }>,
  predicate: (change: GitChange) => boolean = () => true,
): Record<string, string[]> {
  const byRepo: Record<string, string[]> = {};
  for (const group of groups) {
    const paths = group.visibleChanges.filter(predicate).map((change) => change.path);
    if (paths.length > 0) byRepo[group.root.repoRoot] = paths;
  }
  return byRepo;
}

function workspaceChangeMatchesFilters({
  root,
  change,
  normalizedFilter,
  checked,
  checkedOnlyFilter,
  stageFilters,
  statusFilters,
}: {
  root: GitWorkspaceRootInfo;
  change: GitChange;
  normalizedFilter: string;
  checked: boolean;
  checkedOnlyFilter: boolean;
  stageFilters: Set<WorkspaceStageFilter>;
  statusFilters: Set<WorkspaceStatusFilter>;
}): boolean {
  if (checkedOnlyFilter && !checked) return false;
  if (stageFilters.size > 0 && !matchesStageFilters(change, stageFilters)) return false;
  if (statusFilters.size > 0 && !matchesStatusFilters(change, statusFilters)) return false;
  if (!normalizedFilter) return true;
  return (
    root.name.toLowerCase().includes(normalizedFilter) ||
    root.repoRoot.toLowerCase().includes(normalizedFilter) ||
    change.path.toLowerCase().includes(normalizedFilter) ||
    (change.oldPath ?? "").toLowerCase().includes(normalizedFilter) ||
    change.status.toLowerCase().includes(normalizedFilter) ||
    (change.conflict ? "conflict conflicted" : "").includes(normalizedFilter) ||
    (change.staged ? "staged" : "").includes(normalizedFilter) ||
    (change.unstaged ? "unstaged" : "").includes(normalizedFilter)
  );
}

function matchesStageFilters(change: GitChange, filters: Set<WorkspaceStageFilter>): boolean {
  if (filters.size === 2) return true;
  if (filters.has("staged") && change.staged) return true;
  if (filters.has("unstaged") && (change.unstaged || !change.staged)) return true;
  return false;
}

function matchesStatusFilters(change: GitChange, filters: Set<WorkspaceStatusFilter>): boolean {
  if (filters.has("conflict") && change.conflict) return true;
  if (filters.has("untracked") && change.status === "untracked") return true;
  if (filters.has("deleted") && change.status === "deleted") return true;
  if (filters.has("renamed") && change.status === "renamed") return true;
  if (filters.has("modified") && !change.conflict && change.status === "modified") {
    return true;
  }
  return false;
}
