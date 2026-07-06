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
import { gitChangeLabel, type GitBlobPair, type GitChange, type GitSnapshot } from "../../lib/git";
import type { GitWorkspaceRootInfo } from "../../types";
import { ChangesTree } from "./ChangesTree";
import { ChangesListToolbar } from "./shared/ChangesListToolbar";
import { CommitBar } from "./shared/CommitBar";
import { DiffPane } from "./shared/DiffPane";
import { parseWorkspaceChangeKey, workspaceChangeKey } from "./workspaceGitKeys";

type TriState = "all" | "none" | "some";

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
                commitMessage={repoCommitMessages[root.repoRoot] ?? ""}
                onCommitMessageChange={(value) => setRepoCommitMessage(root.repoRoot, value)}
                onCommit={() => commitRepo(root.repoRoot)}
                onCommitAndPush={() => commitRepoAndPush(root.repoRoot)}
                checkedRepoPathCount={checkedChangePathsByRepo[root.repoRoot]?.length ?? 0}
                canPush={pushableRepoRoots.has(root.repoRoot)}
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
  const repoColor = repoColorFor(root.repoRoot);
  const pathDir = directoryName(change.path);
  const oldPathDir = change.oldPath ? directoryName(change.oldPath) : "";
  const status = workspaceStatusMeta(change);
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="workspace-change-row"
      aria-label={`${root.name} ${change.path} ${status.actionLabel}`}
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
        aria-label={`Select ${root.name} ${change.path}`}
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
      <span className={`shrink-0 w-6 rounded px-1 py-0.5 text-center text-[10px] font-semibold ${status.kindClass}`}>
        {status.kindLabel}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-[12px] font-medium">{fileName(change.path)}</span>
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${status.actionClass}`}>
            {status.actionLabel}
          </span>
        </div>
        <div className="truncate text-[11px] text-[var(--taomni-text-muted)]">
          {pathDir || "."} / {gitChangeLabel(change)}
          {change.oldPath ? ` · from ${oldPathDir || "."} / ${fileName(change.oldPath)}` : ""}
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
        {error ?? "Loading changes..."}
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
  commitMessage,
  onCommitMessageChange,
  onCommit,
  onCommitAndPush,
  checkedRepoPathCount,
  canPush,
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
  commitMessage: string;
  onCommitMessageChange: (value: string) => void;
  onCommit: () => void;
  onCommitAndPush: () => void;
  checkedRepoPathCount: number;
  canPush: boolean;
  onToggleChecked: (repoRoot: string, paths: string[], value: boolean) => void;
  onStagePaths: (repoRoot: string, paths: string[]) => void;
  onUnstagePaths: (repoRoot: string, paths: string[]) => void;
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
  const canCommitRepo = !busy && checkedRepoPathCount > 0 && commitMessage.trim().length > 0;

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
          <ChangesTree
            changes={changes}
            treeMode={treeMode}
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

function fileName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function directoryName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
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

function workspaceStatusMeta(change: GitChange): {
  kindLabel: string;
  kindClass: string;
  actionLabel: string;
  actionClass: string;
} {
  if (change.conflict) {
    return {
      kindLabel: "!",
      kindClass: "bg-red-500/15 text-red-500",
      actionLabel: "Resolve",
      actionClass: "bg-red-500/15 text-red-500",
    };
  }
  if (change.staged) {
    return {
      kindLabel: shortChangeKind(change),
      kindClass: "bg-emerald-500/15 text-emerald-600",
      actionLabel: "Commit",
      actionClass: "bg-emerald-500/15 text-emerald-600",
    };
  }
  if (change.status === "untracked") {
    return {
      kindLabel: "?",
      kindClass: "bg-amber-500/15 text-amber-600",
      actionLabel: "Add",
      actionClass: "bg-amber-500/15 text-amber-600",
    };
  }
  return {
    kindLabel: shortChangeKind(change),
    kindClass: "bg-blue-500/15 text-blue-500",
    actionLabel: "Add",
    actionClass: "bg-blue-500/15 text-blue-500",
  };
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
