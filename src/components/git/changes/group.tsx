import { AlertTriangle, ChevronDown, ChevronRight, GitBranch, Loader2 } from "lucide-react";
import { type MouseEvent as ReactMouseEvent } from "react";
import { type GitSnapshot } from "../../../lib/git";
import { useT } from "../../../lib/i18n";
import type { GitWorkspaceRootInfo } from "../../../types";
import { ChangesTree } from "../ChangesTree";
import { parseWorkspaceChangeKey, workspaceChangeKey } from "../workspaceGitKeys";
import { TriCheckbox, checkState } from "./selection";

export function RepoChangeGroup({
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
  onSelect: (repoRoot: string, path: string, mods: { ctrl: boolean; shift: boolean; }) => void;
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
