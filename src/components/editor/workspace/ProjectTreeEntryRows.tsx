import { memo } from "react";
import type { WorkspaceEntry } from "../../../lib/editor/workspace";
import type { GitChange } from "../../../lib/git";
import { ChevronDown, ChevronRight, Loader2 } from "./icons";
import { formatBytes } from "./codeWorkspaceModel";
import { GitStatusBadge, ProjectTreeEntryDetails, ProjectTreeEntryName } from "./ProjectTreeEntryDetails";
import type { ProjectTreeProps } from "./projectTreeTypes";
import { WorkspaceFileIcon } from "./WorkspaceFileIcon";

interface EntryProps extends Pick<ProjectTreeProps, "onSelect" | "onContextMenu"> {
  entry: WorkspaceEntry;
  rootId: string;
  rootName: string;
  depth: number;
  list: boolean;
  selected: boolean;
}

interface DirectoryProps extends EntryProps, Pick<ProjectTreeProps, "onToggleDir"> {
  displayPath: string;
  displayName: string;
  expanded: boolean;
  changeCount: number;
  loading: boolean;
}

// Explicit row inputs let React skip unaffected rows on selection/dirty changes.
// No comparator may hide a changed callback, entry, Git status or display mode.
export const ProjectTreeDirectoryRow = memo(function ProjectTreeDirectoryRow({
  entry, rootId, rootName, depth, list, selected, displayPath, displayName,
  expanded, changeCount, loading, onSelect, onToggleDir, onContextMenu,
}: DirectoryProps) {
  const selection = { kind: "dir" as const, rootId, path: displayPath };
  return (
    <button
      type="button" data-testid="code-workspace-tree-dir" data-root-id={rootId}
      data-path={displayPath} data-tree-kind="dir" data-selected={selected || undefined}
      role="treeitem" aria-level={depth + 1} aria-expanded={expanded} aria-selected={selected}
      className="h-[var(--taomni-code-tree-row-height)] w-full min-w-0 flex items-center gap-1.5 pr-2 text-left hover:bg-[var(--taomni-code-active-line-bg)] data-[selected=true]:bg-[var(--taomni-code-active-line-bg)]"
      style={list ? undefined : { paddingLeft: `${10 + depth * 14}px` }}
      title={`${rootName} / ${displayPath}`}
      onClick={() => onSelect(selection)}
      onDoubleClick={() => { onSelect(selection); onToggleDir(rootId, displayPath); }}
      onContextMenu={(event) => onContextMenu(event, selection)}
    >
      <ProjectTreeEntryName depth={depth} list={list}>
        <span
          role="button" tabIndex={-1} aria-label={expanded ? "Collapse directory" : "Expand directory"}
          data-testid="code-workspace-tree-dir-arrow"
          className="inline-flex items-center justify-center p-0.5 -m-0.5 rounded hover:bg-[var(--taomni-code-active-line-bg)]"
          onClick={(event) => { event.stopPropagation(); onSelect(selection); onToggleDir(rootId, displayPath); }}
        >
          {expanded ? <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
            : <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-code-muted)]" />}
        </span>
        <WorkspaceFileIcon path={displayPath} folder expanded={expanded} />
        <span className="truncate">{displayName}</span>
        {(changeCount > 0 || loading) && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {changeCount > 0 && <span className="rounded border border-[var(--taomni-code-border)] px-1 text-[10px] text-[var(--taomni-code-muted)]">{changeCount}</span>}
            {loading && <Loader2 className="w-3 h-3 animate-spin" />}
          </span>
        )}
      </ProjectTreeEntryName>
      {list && <ProjectTreeEntryDetails entry={entry} list />}
    </button>
  );
});

interface FileProps extends EntryProps, Pick<ProjectTreeProps, "onOpenFile" | "showDetails"> {
  active: boolean;
  dirty: boolean;
  change: GitChange | undefined;
}

export const ProjectTreeFileRow = memo(function ProjectTreeFileRow({
  entry, rootId, rootName, depth, list, selected, active, dirty, change, showDetails,
  onSelect, onOpenFile, onContextMenu,
}: FileProps) {
  const ref = { kind: "root" as const, rootId, path: entry.path };
  const selection = { kind: "file" as const, ref };
  return (
    <button
      type="button" data-testid="code-workspace-tree-file" data-root-id={rootId}
      data-path={entry.path} data-tree-kind="file" data-active={active || undefined} data-selected={selected || undefined}
      role="treeitem" aria-level={depth + 1} aria-selected={selected}
      className="h-[var(--taomni-code-tree-row-height)] w-full min-w-0 flex items-center gap-1.5 pr-2 text-left hover:bg-[var(--taomni-code-active-line-bg)] data-[active=true]:bg-[var(--taomni-code-selection-match-bg)] data-[selected=true]:bg-[var(--taomni-code-active-line-bg)]"
      style={list ? undefined : { paddingLeft: `${10 + depth * 14}px` }}
      title={`${rootName} / ${entry.path}${entry.size ? ` - ${formatBytes(entry.size)}` : ""}`}
      onClick={() => onSelect(selection)}
      onDoubleClick={() => { onSelect(selection); onOpenFile(ref, { preview: false }); }}
      onContextMenu={(event) => onContextMenu(event, selection)}
    >
      <ProjectTreeEntryName depth={depth} list={list}>
        <span className="w-3.5 shrink-0" />
        <WorkspaceFileIcon path={entry.path} />
        <span className="truncate">{entry.name}</span>
        {(change || dirty) && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <GitStatusBadge change={change} />
            {dirty && <span className="text-[var(--taomni-accent)]">*</span>}
          </span>
        )}
      </ProjectTreeEntryName>
      <ProjectTreeEntryDetails entry={entry} list={list} visible={showDetails} />
    </button>
  );
});
