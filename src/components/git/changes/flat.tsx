import { AlertTriangle, ChevronDown, ChevronRight, GitBranch, Loader2 } from "lucide-react";
import { type MouseEvent as ReactMouseEvent } from "react";
import { type GitChange, type GitSnapshot } from "../../../lib/git";
import { useT } from "../../../lib/i18n";
import { buildWorkspaceFlatGroups, changeFileName, changePathDirectory } from "../../../lib/workspaceGitFlatList";
import type { GitWorkspaceRootInfo } from "../../../types";
import { workspaceChangeKey } from "../workspaceGitKeys";
import { type WorkspaceChangesViewProps } from "./model";
import { repoAbbr, repoColorFor, workspaceStatusMeta } from "./presentation";
import { TriCheckbox, checkState } from "./selection";

export function WorkspaceFlatChangesList({
  groups,
  checkedKeys,
  selectedKeys,
  focusedKey,
  collapsedRepos,
  onToggleCollapsed,
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
  checkedKeys: Set<string>;
  selectedKeys: Set<string>;
  focusedKey: string | null;
  collapsedRepos: Set<string>;
  onToggleCollapsed: (repoRoot: string) => void;
  onToggleChecked: (repoRoot: string, paths: string[], value: boolean) => void;
  onSelect: (repoRoot: string, path: string, mods: { ctrl: boolean; shift: boolean; }) => void;
  onContextMenu: (repoRoot: string, path: string, event: ReactMouseEvent) => void;
}) {
  const t = useT();
  const changesByRepo = new Map(
    groups.map((group) => [group.root.repoRoot, group.visibleChanges] as const),
  );
  const flatGroups = buildWorkspaceFlatGroups(
    groups.map((group) => group.root),
    changesByRepo,
  );
  const statusRows = groups.filter((group) => group.state?.loading || group.state?.error);

  return (
    <div className="min-h-full" data-testid="workspace-flat-changes-list">
      {flatGroups.map((group) => {
        const collapsed = collapsedRepos.has(group.root.repoRoot);
        const branch = groupSnapshotBranch(groups, group.root.repoRoot);
        const checkedCount = group.changes.filter((change) => (
          checkedKeys.has(workspaceChangeKey(group.root.repoRoot, change.path))
        )).length;
        return (
          <section
            key={group.root.repoRoot}
            data-testid="workspace-flat-repo-group"
            data-repo-root={group.root.repoRoot}
            className="border-b border-[var(--taomni-divider)]"
          >
            <div
              data-testid="workspace-flat-repo-header"
              className="h-7 flex items-center gap-1.5 pl-2 pr-2 bg-[var(--taomni-quick-bg)] border-b border-[var(--taomni-divider)]"
            >
              <button
                type="button"
                className="shrink-0 flex items-center justify-center text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"
                aria-label={collapsed
                  ? t("git.workspaceChanges.expandRepository", { repo: group.root.name })
                  : t("git.workspaceChanges.collapseRepository", { repo: group.root.name })}
                onClick={() => onToggleCollapsed(group.root.repoRoot)}
              >
                {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
              <TriCheckbox
                state={checkState(checkedCount, group.changes.length)}
                disabled={group.changes.length === 0}
                ariaLabel={t("git.workspaceChanges.selectRepoChanges", { repo: group.root.name })}
                onChange={(value) => onToggleChecked(
                  group.root.repoRoot,
                  group.changes.map((change) => change.path),
                  value,
                )}
              />
              <GitBranch className="w-3 h-3 shrink-0 text-[var(--taomni-accent)]" />
              <span className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-[var(--taomni-text)]">
                {group.root.name}
              </span>
              {branch ? (
                <span className="min-w-0 truncate text-[10px] text-[var(--taomni-text-muted)]">{branch}</span>
              ) : null}
              <div className="flex-1" />
              <span className="shrink-0 text-[10px] text-[var(--taomni-text-muted)]">
                {checkedCount}/{group.changes.length}
              </span>
            </div>
            {collapsed ? null : group.changes.map((change) => {
              const key = workspaceChangeKey(group.root.repoRoot, change.path);
              return (
                <WorkspaceFlatChangeRow
                  key={key}
                  root={group.root}
                  change={change}
                  checked={checkedKeys.has(key)}
                  selected={selectedKeys.has(key)}
                  active={focusedKey === key}
                  onToggleChecked={(value) => onToggleChecked(group.root.repoRoot, [change.path], value)}
                  onSelect={(mods) => onSelect(group.root.repoRoot, change.path, mods)}
                  onContextMenu={(event) => onContextMenu(group.root.repoRoot, change.path, event)}
                />
              );
            })}
          </section>
        );
      })}
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

export function groupSnapshotBranch(
  groups: Array<{ root: GitWorkspaceRootInfo; snapshot: GitSnapshot | null; }>,
  repoRoot: string,
): string | null {
  const snapshot = groups.find((group) => group.root.repoRoot === repoRoot)?.snapshot ?? null;
  if (!snapshot) return null;
  if (snapshot.detached) return `detached ${snapshot.headOid ?? ""}`.trim();
  return snapshot.currentBranch;
}

export function WorkspaceFlatChangeRow({
  root,
  change,
  checked,
  selected,
  active,
  onToggleChecked,
  onSelect,
  onContextMenu,
}: {
  root: GitWorkspaceRootInfo;
  change: GitChange;
  checked: boolean;
  selected: boolean;
  active: boolean;
  onToggleChecked: (value: boolean) => void;
  onSelect: (mods: { ctrl: boolean; shift: boolean; }) => void;
  onContextMenu: (event: ReactMouseEvent) => void;
}) {
  const t = useT();
  const pathDir = changePathDirectory(change.path);
  const name = changeFileName(change.path);
  const status = workspaceStatusMeta(change, t);
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="workspace-change-row"
      data-compact="true"
      data-repo-root={root.repoRoot}
      data-path={change.path}
      data-active={active ? "true" : undefined}
      aria-label={`${root.name} ${change.path} ${status.statusLabel}`}
      title={`${root.repoRoot}\n${change.path}`}
      className={`group relative w-full min-h-[28px] h-7 pl-6 pr-2 py-0.5 flex items-center gap-1.5 text-left cursor-pointer border-b border-[var(--taomni-divider)]/60 ${active ? "bg-[var(--taomni-hover)]" : selected ? "bg-[var(--taomni-accent)]/10" : "hover:bg-[var(--taomni-hover)]"
        }`}
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
        className="shrink-0 accent-[var(--taomni-accent)]"
        checked={checked}
        aria-label={t("git.workspaceChanges.selectFile", { repo: root.name, path: change.path })}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onToggleChecked(event.target.checked)}
      />
      <span
        className={`shrink-0 w-5 rounded px-0.5 py-0 text-center text-[10px] font-semibold ${status.kindClass}`}
        title={status.statusLabel}
        aria-label={status.statusLabel}
      >
        {status.kindLabel}
      </span>
      <div className="min-w-0 flex-1 flex items-baseline gap-1.5 overflow-hidden">
        <span className="shrink-0 max-w-[55%] truncate text-[12px] font-medium">{name}</span>
        {pathDir ? (
          <span className="min-w-0 truncate text-[10px] text-[var(--taomni-text-muted)]" data-testid="workspace-change-path">
            {pathDir}
          </span>
        ) : null}
        {change.oldPath ? (
          <span className="min-w-0 truncate text-[10px] text-[var(--taomni-text-muted)]">
            · {t("git.workspaceChanges.fromPath", { path: change.oldPath })}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function RepoFlatStatusRow({
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
