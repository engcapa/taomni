import type { ReactNode } from "react";
import type { WorkspaceEntry } from "../../../lib/editor/workspace";
import { gitChangeLabel, type GitChange } from "../../../lib/git";
import { useLocale } from "../../../lib/i18n";
import { treeFileDetails, formatTreeBytes, treeModifiedDate } from "./treeToolbarChrome";
import { explorerEntryType } from "./explorerPreferences";

export function ProjectTreeEntryName({ children, depth, list }: { children: ReactNode; depth: number; list: boolean }) {
  return list ? <span data-testid="code-workspace-list-name" className="taomni-explorer-list-name flex min-w-0 items-center gap-1.5 self-stretch pr-2"
    style={{ paddingLeft: `${10 + depth * 14}px` }}>{children}</span> : children;
}

export function GitStatusBadge({ change }: { change: GitChange | undefined }): ReactNode {
  if (!change) return null;
  const label = change.conflict
    ? "C"
    : change.status === "untracked"
      ? "U"
      : change.status === "renamed"
        ? "R"
        : change.status[0]?.toUpperCase() ?? "?";
  const color = change.conflict
    ? "border-red-500/30 bg-red-500/10 text-red-500"
    : change.status === "untracked"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-500"
      : change.staged
        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
        : "border-blue-500/30 bg-blue-500/10 text-blue-500";
  return (
    <span
      data-testid="code-workspace-git-status"
      className={`inline-flex h-4 min-w-4 items-center justify-center rounded border px-1 text-[10px] font-semibold ${color}`}
      title={gitChangeLabel(change)}
    >
      {label}
    </span>
  );
}

export function ProjectTreeEntryDetails({ entry, list, visible }: { entry: WorkspaceEntry; list: boolean; visible?: boolean }) {
  const { locale } = useLocale();
  if (list) return <span data-testid="code-workspace-list-metadata" className="taomni-explorer-list-metadata">
    <span data-testid="code-workspace-list-size">{entry.fileType === "dir" ? "—" : formatTreeBytes(entry.size)}</span>
    <span data-testid="code-workspace-list-type" className="truncate">{explorerEntryType(entry)}</span>
    <span data-testid="code-workspace-list-modified">{treeModifiedDate(entry.mtime, locale) || "—"}</span>
  </span>;
  return visible ? <span data-testid="code-workspace-tree-file-details" className="min-w-0 truncate text-[var(--taomni-code-muted)]">
    {treeFileDetails(entry.size, entry.mtime, locale)}
  </span> : null;
}
