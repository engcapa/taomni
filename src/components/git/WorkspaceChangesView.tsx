import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Loader2,
  Search,
} from "lucide-react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import type { GitBlobPair, GitSnapshot } from "../../lib/git";
import type { GitWorkspaceRootInfo } from "../../types";
import { ChangesTree } from "./ChangesTree";
import { ChangesListToolbar } from "./shared/ChangesListToolbar";
import { CommitBar } from "./shared/CommitBar";
import { DiffPane } from "./shared/DiffPane";
import { parseWorkspaceChangeKey, workspaceChangeKey } from "./workspaceGitKeys";

type TriState = "all" | "none" | "some";

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
  selectedCount: number;
  focusedKey: string | null;
  pair: GitBlobPair | null;
  pairLoading: boolean;
  commitMessage: string;
  setCommitMessage: (message: string) => void;
  canCommitAndPush: boolean;
  scopeSummary: string;
  stageAll: () => void;
  unstageAll: () => void;
  stageSelected: () => void;
  unstageSelected: () => void;
  discardSelected: () => void;
  commit: () => void;
  commitAndPush: () => void;
  onToggleChecked: (repoRoot: string, paths: string[], value: boolean) => void;
  onSelect: (repoRoot: string, path: string, mods: { ctrl: boolean; shift: boolean }) => void;
  onContextMenu: (repoRoot: string, path: string, event: ReactMouseEvent) => void;
  repoCommitMessages: Record<string, string>;
  setRepoCommitMessage: (repoRoot: string, message: string) => void;
  commitRepo: (repoRoot: string) => void;
  commitRepoAndPush: (repoRoot: string) => void;
  checkedChangePathsByRepo: Record<string, string[]>;
  pushableRepoRoots: Set<string>;
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
  selectedCount,
  focusedKey,
  pair,
  pairLoading,
  commitMessage,
  setCommitMessage,
  canCommitAndPush,
  scopeSummary,
  stageAll,
  unstageAll,
  stageSelected,
  unstageSelected,
  discardSelected,
  commit,
  commitAndPush,
  onToggleChecked,
  onSelect,
  onContextMenu,
  repoCommitMessages,
  setRepoCommitMessage,
  commitRepo,
  commitRepoAndPush,
  checkedChangePathsByRepo,
  pushableRepoRoots,
}: WorkspaceChangesViewProps) {
  const [filter, setFilter] = useState("");
  const normalizedFilter = filter.trim().toLowerCase();
  const groups = roots.map((root) => ({
    root,
    state: snapshots[root.repoRoot],
    snapshot: snapshots[root.repoRoot]?.snapshot ?? null,
    visibleChanges: (snapshots[root.repoRoot]?.snapshot?.changes ?? []).filter((change) => (
      !normalizedFilter ||
      root.name.toLowerCase().includes(normalizedFilter) ||
      root.repoRoot.toLowerCase().includes(normalizedFilter) ||
      change.path.toLowerCase().includes(normalizedFilter) ||
      (change.oldPath ?? "").toLowerCase().includes(normalizedFilter) ||
      change.status.toLowerCase().includes(normalizedFilter) ||
      (change.conflict ? "conflict conflicted" : "").includes(normalizedFilter) ||
      (change.staged ? "staged" : "unstaged").includes(normalizedFilter)
    )),
  }));
  const totalChanges = groups.reduce((total, group) => total + (group.snapshot?.changes.length ?? 0), 0);
  const visibleChangeCount = groups.reduce((total, group) => total + group.visibleChanges.length, 0);
  const hasVisibleGroups = groups.some((group) => (
    group.visibleChanges.length > 0 || group.state?.loading || group.state?.error
  ));
  const hasStaged = groups.some((group) => group.snapshot?.changes.some((change) => change.staged));
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
          <span className="font-semibold text-[12px]">Workspace changes</span>
          <span className="min-w-0 truncate text-[11px] text-[var(--taomni-text-muted)]">{scopeSummary}</span>
        </div>
        <ChangesListToolbar
          busy={busy}
          checkedCount={checkedCount}
          totalCount={totalChanges}
          treeMode={treeMode}
          canStageAll={totalChanges > 0}
          canUnstageAll={hasStaged}
          onStageAll={stageAll}
          onUnstageAll={unstageAll}
          onToggleTreeMode={() => setTreeMode(!treeMode)}
        />
        <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)]">
          <div className="relative min-w-0 flex-1">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
            <input
              className="taomni-input h-7 w-full pl-7"
              value={filter}
              placeholder="Filter changes"
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
          {filter.trim() ? (
            <span className="shrink-0 text-[11px] text-[var(--taomni-text-muted)]">
              {visibleChangeCount}/{totalChanges}
            </span>
          ) : null}
        </div>

        <div className="flex-1 min-h-0 overflow-auto">
          {!hasVisibleGroups ? (
            <div className="h-full min-h-24 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
              {filter.trim() ? "No matching changes" : "No local changes"}
            </div>
          ) : groups.map(({ root, state, snapshot, visibleChanges }) => (
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
              commitMessage={repoCommitMessages[root.repoRoot] ?? ""}
              onCommitMessageChange={(value) => setRepoCommitMessage(root.repoRoot, value)}
              onCommit={() => commitRepo(root.repoRoot)}
              onCommitAndPush={() => commitRepoAndPush(root.repoRoot)}
              checkedRepoPathCount={checkedChangePathsByRepo[root.repoRoot]?.length ?? 0}
              canPush={pushableRepoRoots.has(root.repoRoot)}
              onToggleChecked={onToggleChecked}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
            />
          ))}
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
          title={`${active ? `${active.root.name} / ${active.change.path}` : "Diff"}${selectedCount > 1 ? ` (+${selectedCount - 1} selected)` : ""}`}
          busy={busy}
          selectedCount={selectedCount}
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
  commitMessage,
  onCommitMessageChange,
  onCommit,
  onCommitAndPush,
  checkedRepoPathCount,
  canPush,
  onToggleChecked,
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
  commitMessage: string;
  onCommitMessageChange: (value: string) => void;
  onCommit: () => void;
  onCommitAndPush: () => void;
  checkedRepoPathCount: number;
  canPush: boolean;
  onToggleChecked: (repoRoot: string, paths: string[], value: boolean) => void;
  onSelect: (repoRoot: string, path: string, mods: { ctrl: boolean; shift: boolean }) => void;
  onContextMenu: (repoRoot: string, path: string, event: ReactMouseEvent) => void;
}) {
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
  const stagedChanges = changes.filter((change) => change.staged);
  const unstagedChanges = changes.filter((change) => !change.staged);
  const canCommitRepo = !busy && checkedRepoPathCount > 0 && commitMessage.trim().length > 0;

  const renderTree = (subset: GitSnapshot["changes"]) => (
    <ChangesTree
      changes={subset}
      treeMode={treeMode}
      checked={checkedPaths}
      onToggleChecked={(paths, value) => onToggleChecked(root.repoRoot, paths, value)}
      selected={selectedPaths}
      activePath={activePath}
      onSelect={(path, mods) => onSelect(root.repoRoot, path, mods)}
      onContextMenu={(path, event) => onContextMenu(root.repoRoot, path, event)}
    />
  );

  return (
    <section className="border-b border-[var(--taomni-divider)]">
      <div className="h-8 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)]">
        <button
          type="button"
          className="shrink-0 flex items-center justify-center text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"
          aria-label={collapsed ? `Expand ${root.name}` : `Collapse ${root.name}`}
          onClick={onToggleCollapsed}
        >
          {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
        <TriCheckbox
          state={checkState(checkedCount, changes.length)}
          disabled={changes.length === 0}
          ariaLabel={`Select changes in ${root.name}`}
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
          {stagedChanges.length > 0 && (
            <>
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--taomni-text-muted)] bg-[var(--taomni-bg)]">
                Staged ({stagedChanges.length})
              </div>
              {renderTree(stagedChanges)}
            </>
          )}
          {unstagedChanges.length > 0 && (
            <>
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--taomni-text-muted)] bg-[var(--taomni-bg)]">
                Changes ({unstagedChanges.length})
              </div>
              {renderTree(unstagedChanges)}
            </>
          )}
          <div className="flex items-center gap-1.5 px-2 py-1.5 border-t border-[var(--taomni-divider)]">
            <input
              className="taomni-input h-7 min-w-0 flex-1 text-[12px]"
              value={commitMessage}
              placeholder={`Message for ${root.name}`}
              onChange={(event) => onCommitMessageChange(event.target.value)}
            />
            <button
              type="button"
              className="taomni-btn h-7 px-2 text-[11px]"
              aria-label={`Commit ${root.name}`}
              disabled={!canCommitRepo}
              onClick={onCommit}
            >
              Commit
            </button>
            <button
              type="button"
              className="taomni-btn h-7 px-2 text-[11px]"
              aria-label={`Commit and push ${root.name}`}
              disabled={!canCommitRepo || !canPush}
              onClick={onCommitAndPush}
            >
              Commit &amp; Push
            </button>
          </div>
        </>
      ) : loading ? (
        <div className="px-8 py-2 text-[11px] text-[var(--taomni-text-muted)]">
          Loading changes...
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
