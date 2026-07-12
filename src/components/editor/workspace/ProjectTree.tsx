/**
 * Project tree body: roots, hierarchical/flat entries, and loose files.
 * Presentation + expand/open callbacks only — load/mutate logic stays in the shell.
 */
import { Fragment, type MouseEvent, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  Loader2,
} from "lucide-react";
import { gitChangeLabel, type GitChange } from "../../../lib/git";
import type {
  CodeWorkspaceFileRef,
  CodeWorkspaceLooseFileInfo,
  CodeWorkspaceRootInfo,
} from "../../../types";
import type { WorkspaceEntry } from "../../../lib/editor/workspace";
import {
  compactEntryName,
  DEFAULT_DIR_STATE,
  DEFAULT_FLAT_FILES_STATE,
  fileKey,
  fileRefEquals,
  flatSourceGroup,
  flatSourceRelativePath,
  FLAT_VIEW_MAX_FILES,
  formatBytes,
  gitChangeForPath,
  gitDirectoryChangeCount,
  isFlatViewSourceFile,
  isRootRef,
  matchesTreeFilter,
  rootDirKey,
  shouldHideEntry,
  type CompactChainState,
  type DirectoryState,
  type FlatFilesState,
  type TreeSelection,
  type TreeViewMode,
} from "./codeWorkspaceModel";

export interface ProjectTreeOpenFileHint {
  dirty?: boolean;
}

export interface ProjectTreeProps {
  roots: CodeWorkspaceRootInfo[];
  looseFiles: CodeWorkspaceLooseFileInfo[];
  directories: Record<string, DirectoryState>;
  compactChains: Record<string, CompactChainState>;
  flatFiles: Record<string, FlatFilesState>;
  treeViewMode: TreeViewMode;
  treeFilter: string;
  expandedRoots: ReadonlySet<string>;
  expandedDirs: ReadonlySet<string>;
  selected: TreeSelection | null;
  activeKey: string | null;
  openFiles: Record<string, ProjectTreeOpenFileHint | undefined>;
  gitChangeByRootPath: ReadonlyMap<string, GitChange>;
  onToggleRoot: (rootId: string) => void;
  onToggleDir: (rootId: string, path: string) => void;
  onSelect: (selection: TreeSelection) => void;
  onOpenFile: (ref: CodeWorkspaceFileRef, options?: { preview?: boolean }) => void;
  onContextMenu: (event: MouseEvent, selection: TreeSelection) => void;
}

function GitStatusBadge({ change }: { change: GitChange | undefined }): ReactNode {
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

function renderMatchingFlatFiles(
  root: CodeWorkspaceRootInfo,
  props: ProjectTreeProps,
  options: { groupBySource: boolean },
): ReactNode {
  const {
    flatFiles,
    treeFilter,
    activeKey,
    selected,
    openFiles,
    gitChangeByRootPath,
    onSelect,
    onOpenFile,
    onContextMenu,
  } = props;
  const state = flatFiles[root.id] ?? DEFAULT_FLAT_FILES_STATE;
  if (state.loading && !state.loaded) {
    return (
      <div className="h-[var(--taomni-code-tree-row-height)] flex items-center gap-2 px-4 text-[var(--taomni-code-muted)]">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>Loading files</span>
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="m-2 rounded border border-red-500/30 bg-red-500/10 p-2 text-[12px] text-red-500">
        {state.error}
      </div>
    );
  }
  const entries = state.entries.filter((entry) => {
    if (shouldHideEntry(entry)) return false;
    // Flat view only lists language sources under recognized src/lib/app roots.
    // Filter search keeps the broader recursive index so nested names still match.
    if (options.groupBySource && !isFlatViewSourceFile(entry.path)) return false;
    return matchesTreeFilter(entry.name, entry.path, treeFilter);
  });
  if (entries.length === 0) {
    return (
      <div className="px-3 py-2 text-[var(--taomni-code-muted)]">
        {state.loaded ? (options.groupBySource ? "No language source files" : "No files") : "Not loaded"}
      </div>
    );
  }
  const groups = new Map<string, WorkspaceEntry[]>();
  if (options.groupBySource) {
    for (const entry of entries) {
      const group = flatSourceGroup(entry.path);
      const list = groups.get(group) ?? [];
      list.push(entry);
      groups.set(group, list);
    }
  } else {
    groups.set("__matches__", entries);
  }
  return (
    <>
      {state.truncated && (
        <div className="px-3 py-1 text-[11px] text-[var(--taomni-code-muted)]">
          Showing first {FLAT_VIEW_MAX_FILES} files
        </div>
      )}
      {[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, groupEntries]) => (
        <Fragment key={`${root.id}:flat:${group}`}>
          {options.groupBySource && (
            <div
              className="h-6 flex items-center gap-1.5 px-4 font-semibold text-[var(--taomni-code-muted)]"
              style={{ fontSize: "var(--taomni-code-tree-small-font-size)" }}
              data-testid="code-workspace-flat-group"
            >
              <Folder className="w-3.5 h-3.5 text-[#d59d32]" />
              <span>{group}</span>
              <span className="ml-auto text-[10px] font-normal">{groupEntries.length}</span>
            </div>
          )}
          {groupEntries.map((entry) => {
            const ref: CodeWorkspaceFileRef = { kind: "root", rootId: root.id, path: entry.path };
            const key = fileKey(ref);
            const active = activeKey === key;
            const isSelected = selected?.kind === "file" && isRootRef(selected.ref, root.id, entry.path);
            const open = openFiles[key];
            const change = gitChangeForPath(gitChangeByRootPath, root.id, entry.path);
            const label = options.groupBySource ? flatSourceRelativePath(entry.path) : entry.path;
            return (
              <button
                key={`${root.id}:flat:${entry.path}`}
                type="button"
                data-testid="code-workspace-flat-file"
                data-root-id={root.id}
                data-path={entry.path}
                data-active={active || undefined}
                data-selected={isSelected || undefined}
                className="h-[var(--taomni-code-tree-row-height)] w-full min-w-0 flex items-center gap-1.5 pl-6 pr-2 text-left hover:bg-[var(--taomni-code-active-line-bg)] data-[active=true]:bg-[var(--taomni-code-selection-match-bg)] data-[selected=true]:bg-[var(--taomni-code-active-line-bg)]"
                title={`${root.name} / ${entry.path}${entry.size ? ` - ${formatBytes(entry.size)}` : ""}`}
                onClick={() => {
                  onSelect({ kind: "file", ref });
                  // Permanent editor tab — do not replace a previous preview tab.
                  onOpenFile(ref);
                }}
                onDoubleClick={() => onOpenFile(ref)}
                onContextMenu={(event) => onContextMenu(event, { kind: "file", ref })}
              >
                <File className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
                <span className="truncate">{label}</span>
                {(change || open?.dirty) && (
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    <GitStatusBadge change={change} />
                    {open?.dirty && <span className="text-[var(--taomni-accent)]">*</span>}
                  </span>
                )}
              </button>
            );
          })}
        </Fragment>
      ))}
    </>
  );
}

function renderFlatEntries(
  root: CodeWorkspaceRootInfo,
  props: ProjectTreeProps,
): ReactNode {
  return renderMatchingFlatFiles(root, props, { groupBySource: true });
}

function renderEntries(
  root: CodeWorkspaceRootInfo,
  path: string,
  depth: number,
  props: ProjectTreeProps,
): ReactNode {
  const {
    directories,
    compactChains,
    treeViewMode,
    treeFilter,
    expandedDirs,
    activeKey,
    selected,
    openFiles,
    gitChangeByRootPath,
    onToggleDir,
    onSelect,
    onOpenFile,
    onContextMenu,
  } = props;
  const state = directories[rootDirKey(root.id, path)] ?? DEFAULT_DIR_STATE;
  const filter = treeFilter.trim();
  // Substring filter cannot see unexpanded/unloaded children. When a query is
  // active, fall back to the recursive flat index so e.g. `http` finds
  // `src/foo/http2_connect.rs` without expanding every folder first.
  if (filter) {
    return renderMatchingFlatFiles(root, props, { groupBySource: false });
  }
  if (state.loading && !state.loaded) {
    return (
      <div className="h-[var(--taomni-code-tree-row-height)] flex items-center gap-2 px-2 text-[var(--taomni-code-muted)]">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>Loading</span>
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="m-2 rounded border border-red-500/30 bg-red-500/10 p-2 text-[12px] text-red-500">
        {state.error}
      </div>
    );
  }
  const entries = state.entries.filter((entry) => !shouldHideEntry(entry));
  if (entries.length === 0) {
    return (
      <div className="px-3 py-2 text-[var(--taomni-code-muted)]">
        Empty
      </div>
    );
  }
  return entries.map((entry) => {
    const isDir = entry.fileType === "dir";
    const chain = treeViewMode === "compact"
      ? compactChains[rootDirKey(root.id, entry.path)]
      : undefined;
    const displayPath = isDir && chain?.path ? chain.path : entry.path;
    const displayName = isDir ? compactEntryName(entry, chain) : entry.name;
    const dirKey = rootDirKey(root.id, displayPath);
    const isExpanded = expandedDirs.has(dirKey);
    const rowStyle = { paddingLeft: `${10 + depth * 14}px` };
    if (isDir) {
      const childState = directories[dirKey];
      const isSelected = selected?.kind === "dir" && selected.rootId === root.id && selected.path === displayPath;
      const changeCount = gitDirectoryChangeCount(gitChangeByRootPath, root.id, displayPath);
      return (
        <Fragment key={`${root.id}:${entry.path}`}>
          <button
            type="button"
            data-testid="code-workspace-tree-dir"
            data-root-id={root.id}
            data-path={displayPath}
            data-selected={isSelected || undefined}
            className="h-[var(--taomni-code-tree-row-height)] w-full min-w-0 flex items-center gap-1.5 pr-2 text-left hover:bg-[var(--taomni-code-active-line-bg)] data-[selected=true]:bg-[var(--taomni-code-active-line-bg)]"
            style={rowStyle}
            title={`${root.name} / ${displayPath}`}
            onClick={() => {
              onSelect({ kind: "dir", rootId: root.id, path: displayPath });
              onToggleDir(root.id, displayPath);
            }}
            onContextMenu={(event) => onContextMenu(event, { kind: "dir", rootId: root.id, path: displayPath })}
          >
            {isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
            )}
            <Folder className="w-3.5 h-3.5 shrink-0 text-[#d59d32]" />
            <span className="truncate">{displayName}</span>
            {(changeCount > 0 || childState?.loading || chain?.loading) && (
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {changeCount > 0 && (
                  <span className="rounded border border-[var(--taomni-code-border)] px-1 text-[10px] text-[var(--taomni-code-muted)]">
                    {changeCount}
                  </span>
                )}
                {(childState?.loading || chain?.loading) && <Loader2 className="w-3 h-3 animate-spin" />}
              </span>
            )}
          </button>
          {isExpanded && renderEntries(root, displayPath, depth + 1, props)}
        </Fragment>
      );
    }
    const ref: CodeWorkspaceFileRef = { kind: "root", rootId: root.id, path: entry.path };
    const key = fileKey(ref);
    const active = activeKey === key;
    const isSelected = selected?.kind === "file" && isRootRef(selected.ref, root.id, entry.path);
    const open = openFiles[key];
    const change = gitChangeForPath(gitChangeByRootPath, root.id, entry.path);
    return (
      <button
        key={`${root.id}:${entry.path}`}
        type="button"
        data-testid="code-workspace-tree-file"
        data-root-id={root.id}
        data-path={entry.path}
        data-active={active || undefined}
        data-selected={isSelected || undefined}
        className="h-[var(--taomni-code-tree-row-height)] w-full min-w-0 flex items-center gap-1.5 pr-2 text-left hover:bg-[var(--taomni-code-active-line-bg)] data-[active=true]:bg-[var(--taomni-code-selection-match-bg)] data-[selected=true]:bg-[var(--taomni-code-active-line-bg)]"
        style={rowStyle}
        title={`${root.name} / ${entry.path}${entry.size ? ` - ${formatBytes(entry.size)}` : ""}`}
        onClick={() => {
          onSelect({ kind: "file", ref });
          // Permanent editor tab — keep previously opened tabs switchable.
          onOpenFile(ref);
        }}
        onDoubleClick={() => onOpenFile(ref)}
        onContextMenu={(event) => onContextMenu(event, { kind: "file", ref })}
      >
        <span className="w-3.5 shrink-0" />
        <File className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
        <span className="truncate">{entry.name}</span>
        {(change || open?.dirty) && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <GitStatusBadge change={change} />
            {open?.dirty && <span className="text-[var(--taomni-accent)]">*</span>}
          </span>
        )}
      </button>
    );
  });
}

export function ProjectTree(props: ProjectTreeProps) {
  const {
    roots,
    looseFiles,
    treeViewMode,
    treeFilter,
    expandedRoots,
    selected,
    activeKey,
    openFiles,
    gitChangeByRootPath,
    onToggleRoot,
    onSelect,
    onOpenFile,
    onContextMenu,
  } = props;

  if (roots.length === 0 && looseFiles.length === 0) {
    return (
      <div className="px-3 py-2 text-[var(--taomni-code-muted)]">
        Open a file or add a folder
      </div>
    );
  }

  return (
    <>
      {roots.map((root) => {
        const expanded = expandedRoots.has(root.id);
        const selectedRoot = selected?.kind === "root" && selected.rootId === root.id;
        const rootChangeCount = gitDirectoryChangeCount(gitChangeByRootPath, root.id, "");
        return (
          <Fragment key={root.id}>
            <button
              type="button"
              data-testid="code-workspace-tree-root"
              data-root-id={root.id}
              data-selected={selectedRoot || undefined}
              className="h-[var(--taomni-code-tree-row-height)] w-full min-w-0 flex items-center gap-1.5 px-2 text-left font-semibold hover:bg-[var(--taomni-code-active-line-bg)] data-[selected=true]:bg-[var(--taomni-code-active-line-bg)]"
              title={root.path}
              onClick={() => onToggleRoot(root.id)}
              onContextMenu={(event) => onContextMenu(event, { kind: "root", rootId: root.id })}
            >
              {expanded ? (
                <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
              )}
              <Folder className="w-3.5 h-3.5 shrink-0 text-[#d59d32]" />
              <span className="truncate">{root.name}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] font-normal text-[var(--taomni-code-muted)]">
                {rootChangeCount > 0 && (
                  <span className="rounded border border-[var(--taomni-code-border)] px-1">
                    {rootChangeCount}
                  </span>
                )}
                <span>{root.kind}</span>
              </span>
            </button>
            {expanded && (
              treeViewMode === "flat"
                ? renderFlatEntries(root, props)
                : treeFilter.trim()
                  ? renderMatchingFlatFiles(root, props, { groupBySource: false })
                  : renderEntries(root, "", 1, props)
            )}
          </Fragment>
        );
      })}
      {looseFiles.length > 0 && (
        <div className="mt-1">
          <div
            className="h-6 flex items-center gap-1.5 px-2 font-semibold text-[var(--taomni-code-muted)]"
            style={{ fontSize: "var(--taomni-code-tree-small-font-size)" }}
          >
            <File className="w-3.5 h-3.5" />
            <span>Loose Files</span>
          </div>
          {looseFiles.map((file) => {
            const ref: CodeWorkspaceFileRef = { kind: "loose", id: file.id, path: file.path };
            const key = fileKey(ref);
            const open = openFiles[key];
            const active = activeKey === key;
            const selectedLoose = selected?.kind === "file" && fileRefEquals(selected.ref, ref);
            return (
              <button
                key={file.id}
                type="button"
                data-testid="code-workspace-tree-loose-file"
                data-path={file.path}
                data-active={active || undefined}
                data-selected={selectedLoose || undefined}
                className="h-[var(--taomni-code-tree-row-height)] w-full min-w-0 flex items-center gap-1.5 pl-6 pr-2 text-left hover:bg-[var(--taomni-code-active-line-bg)] data-[active=true]:bg-[var(--taomni-code-selection-match-bg)] data-[selected=true]:bg-[var(--taomni-code-active-line-bg)]"
                title={file.path}
                onClick={() => {
                  onSelect({ kind: "file", ref });
                  onOpenFile(ref);
                }}
                onDoubleClick={() => onOpenFile(ref)}
              >
                <File className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
                <span className="truncate">{file.name}</span>
                {open?.dirty && <span className="ml-auto text-[var(--taomni-accent)]">*</span>}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
