import { useMemo, useRef, type MouseEvent as ReactMouseEvent } from "react";
import {
  AlertTriangle,
  GitBranch,
  GitCommitHorizontal,
  List,
  ListTree,
  Loader2,
  Upload,
} from "lucide-react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import type { GitBlobPair, GitSnapshot } from "../../lib/git";
import type { GitWorkspaceRootInfo } from "../../types";
import { ChangesTree } from "./ChangesTree";
import { DiffViewer } from "./DiffViewer";
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
  stageAll: () => void;
  unstageAll: () => void;
  stageSelected: () => void;
  unstageSelected: () => void;
  discardSelected: () => void;
  commit: () => void;
  commitAndPush: () => void;
  onToggleRepoChecked: (repoRoot: string, value: boolean) => void;
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
  selectedCount,
  focusedKey,
  pair,
  pairLoading,
  commitMessage,
  setCommitMessage,
  stageAll,
  unstageAll,
  stageSelected,
  unstageSelected,
  discardSelected,
  commit,
  commitAndPush,
  onToggleRepoChecked,
  onToggleChecked,
  onSelect,
  onContextMenu,
}: WorkspaceChangesViewProps) {
  const groups = roots.map((root) => ({
    root,
    state: snapshots[root.repoRoot],
    snapshot: snapshots[root.repoRoot]?.snapshot ?? null,
  }));
  const totalChanges = groups.reduce((total, group) => total + (group.snapshot?.changes.length ?? 0), 0);
  const hasVisibleGroups = groups.some((group) => (
    (group.snapshot?.changes.length ?? 0) > 0 || group.state?.loading || group.state?.error
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

  return (
    <PanelGroup orientation="horizontal" id="workspace-git-changes-layout">
      <Panel id="workspace-changes-list" defaultSize={38} minSize={26} className="min-w-0 min-h-0 flex flex-col border-r border-[var(--taomni-divider)]">
        <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--taomni-divider)]">
          <button className="taomni-btn h-7 px-2" type="button" disabled={busy || totalChanges === 0} onClick={stageAll}>Stage all</button>
          <button className="taomni-btn h-7 px-2" type="button" disabled={busy || !hasStaged} onClick={unstageAll}>Unstage all</button>
          <div className="flex-1" />
          <span className="text-[11px] text-[var(--taomni-text-muted)]">
            {checkedCount}/{totalChanges}
          </span>
          <button
            className="taomni-btn h-7 px-2"
            type="button"
            title={treeMode ? "Switch to flat list" : "Switch to directory tree"}
            onClick={() => setTreeMode(!treeMode)}
          >
            {treeMode ? <ListTree className="w-3.5 h-3.5" /> : <List className="w-3.5 h-3.5" />}
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto">
          {!hasVisibleGroups ? (
            <div className="h-full min-h-24 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
              No local changes
            </div>
          ) : groups.map(({ root, state, snapshot }) => (
            <RepoChangeGroup
              key={root.repoRoot}
              root={root}
              snapshot={snapshot}
              loading={!!state?.loading}
              error={state?.error ?? null}
              treeMode={treeMode}
              checkedKeys={checkedKeys}
              selectedKeys={selectedKeys}
              focusedKey={focusedKey}
              onToggleRepoChecked={onToggleRepoChecked}
              onToggleChecked={onToggleChecked}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>

        <div className="shrink-0 border-t border-[var(--taomni-divider)] p-2 space-y-2">
          <textarea
            className="taomni-input w-full min-h-20 resize-none"
            value={commitMessage}
            placeholder="Commit message"
            onChange={(event) => setCommitMessage(event.target.value)}
          />
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--taomni-text-muted)]">
              {checkedCount} files in {checkedRepoCount} repos
            </span>
            <button
              className="taomni-btn h-7 px-2 inline-flex items-center gap-1"
              type="button"
              disabled={!canCommit}
              onClick={commit}
            >
              <GitCommitHorizontal className="w-3.5 h-3.5" />
              <span>Commit</span>
            </button>
            <button
              className="taomni-btn h-7 px-2 inline-flex items-center gap-1"
              type="button"
              disabled={!canCommit}
              onClick={commitAndPush}
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Commit and Push</span>
            </button>
          </div>
        </div>
      </Panel>

      <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] cursor-col-resize" />

      <Panel id="workspace-changes-diff" defaultSize={62} minSize={35} className="min-w-0 min-h-0 flex flex-col">
        <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--taomni-divider)]">
          <span className="font-semibold truncate text-[12px]">
            {active ? `${active.root.name} / ${active.change.path}` : "Diff"}
            {selectedCount > 1 ? ` (+${selectedCount - 1} selected)` : ""}
          </span>
          <div className="flex-1" />
          <button className="taomni-btn h-7 px-2" type="button" disabled={busy || selectedCount === 0} onClick={stageSelected}>Stage</button>
          <button className="taomni-btn h-7 px-2" type="button" disabled={busy || selectedCount === 0} onClick={unstageSelected}>Unstage</button>
          <button className="taomni-btn h-7 px-2 text-red-500" type="button" disabled={busy || selectedCount === 0} onClick={discardSelected}>Discard</button>
        </div>
        <DiffViewer pair={pair} loading={pairLoading} emptyLabel="Select a file to preview its diff" />
      </Panel>
    </PanelGroup>
  );
}

function RepoChangeGroup({
  root,
  snapshot,
  loading,
  error,
  treeMode,
  checkedKeys,
  selectedKeys,
  focusedKey,
  onToggleRepoChecked,
  onToggleChecked,
  onSelect,
  onContextMenu,
}: {
  root: GitWorkspaceRootInfo;
  snapshot: GitSnapshot | null;
  loading: boolean;
  error: string | null;
  treeMode: boolean;
  checkedKeys: Set<string>;
  selectedKeys: Set<string>;
  focusedKey: string | null;
  onToggleRepoChecked: (repoRoot: string, value: boolean) => void;
  onToggleChecked: (repoRoot: string, paths: string[], value: boolean) => void;
  onSelect: (repoRoot: string, path: string, mods: { ctrl: boolean; shift: boolean }) => void;
  onContextMenu: (repoRoot: string, path: string, event: ReactMouseEvent) => void;
}) {
  const changes = snapshot?.changes ?? [];
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
        <TriCheckbox
          state={checkState(checkedCount, changes.length)}
          disabled={changes.length === 0}
          onChange={(value) => onToggleRepoChecked(root.repoRoot, value)}
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
      {error ? (
        <div className="px-8 py-2 text-[11px] text-red-500" title={error}>
          {error}
        </div>
      ) : changes.length > 0 ? (
        <ChangesTree
          changes={changes}
          treeMode={treeMode}
          checked={checkedPaths}
          onToggleChecked={(paths, value) => onToggleChecked(root.repoRoot, paths, value)}
          selected={selectedPaths}
          activePath={activePath}
          onSelect={(path, mods) => onSelect(root.repoRoot, path, mods)}
          onContextMenu={(path, event) => onContextMenu(root.repoRoot, path, event)}
        />
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
  onChange,
}: {
  state: TriState;
  disabled?: boolean;
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
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

function checkState(checkedCount: number, totalCount: number): TriState {
  if (totalCount === 0 || checkedCount === 0) return "none";
  if (checkedCount === totalCount) return "all";
  return "some";
}
