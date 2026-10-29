/**
 * Project tree body: roots, hierarchical/flat entries, and loose files.
 * Presentation + expand/open callbacks only — load/mutate logic stays in the shell.
 */
import { Fragment, memo, useMemo, type ReactNode } from "react";
import "./ProjectTree.css";
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  Loader2,
} from "./icons";
import type {
  CodeWorkspaceFileRef,
  CodeWorkspaceRootInfo,
} from "../../../types";
import {
  compactEntryName,
  DEFAULT_DIR_STATE,
  fileKey,
  fileRefEquals,
  formatBytes,
  gitChangeForPath,
  isRootRef,
  rootDirKey,
} from "./codeWorkspaceModel";
import { WorkspaceFileIcon } from "./WorkspaceFileIcon";
import type { ProjectTreeProps } from "./projectTreeTypes";
import { renderMatchingFlatFiles } from "./ProjectTreeFlat";
import { GitStatusBadge, ProjectTreeEntryDetails, ProjectTreeEntryName } from "./ProjectTreeEntryDetails";
import { DEFAULT_EXPLORER_SORT, sortExplorerEntries } from "./explorerPreferences";
import { createGitDirectoryChangeCounts } from "./model/trees";

interface ProjectTreeRenderProps extends ProjectTreeProps {
  gitDirectoryCounts: ReadonlyMap<string, number>;
}

function renderEntries(
  root: CodeWorkspaceRootInfo,
  path: string,
  depth: number,
  props: ProjectTreeRenderProps,
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
  if (!state.loaded) {
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
  // The hierarchical Project view is also the general file explorer. Heavy
  // directories are excluded from recursive indexes (flat/packages/search)
  // to keep scans bounded, but they must remain visible here: hiding them
  // makes a real directory that only contains e.g. `node_modules` or `target`
  // appear as the misleading `Empty` state.
  const entries = state.entries;
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
    const rowStyle = treeViewMode === "list" ? undefined : { paddingLeft: `${10 + depth * 14}px` };
    if (isDir) {
      const childState = directories[dirKey];
      const isSelected = selected?.kind === "dir" && selected.rootId === root.id && selected.path === displayPath;
      const changeCount = props.gitDirectoryCounts.get(rootDirKey(root.id, displayPath)) ?? 0;
      return (
        <Fragment key={`${root.id}:${entry.path}`}>
          <button
            type="button"
            data-testid="code-workspace-tree-dir"
            data-root-id={root.id}
            data-path={displayPath}
            data-tree-kind="dir"
            data-selected={isSelected || undefined}
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={isExpanded}
            aria-selected={isSelected}
            className="h-[var(--taomni-code-tree-row-height)] w-full min-w-0 flex items-center gap-1.5 pr-2 text-left hover:bg-[var(--taomni-code-active-line-bg)] data-[selected=true]:bg-[var(--taomni-code-active-line-bg)]"
            style={rowStyle}
            title={`${root.name} / ${displayPath}`}
            onClick={() => {
              onSelect({ kind: "dir", rootId: root.id, path: displayPath });
            }}
            onDoubleClick={() => {
              onSelect({ kind: "dir", rootId: root.id, path: displayPath });
              onToggleDir(root.id, displayPath);
            }}
            onContextMenu={(event) => onContextMenu(event, { kind: "dir", rootId: root.id, path: displayPath })}
          >
            <ProjectTreeEntryName depth={depth} list={treeViewMode === "list"}>
              <span
                role="button"
                tabIndex={-1}
                aria-label={isExpanded ? "Collapse directory" : "Expand directory"}
                data-testid="code-workspace-tree-dir-arrow"
                className="inline-flex items-center justify-center p-0.5 -m-0.5 rounded hover:bg-[var(--taomni-code-active-line-bg)]"
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect({ kind: "dir", rootId: root.id, path: displayPath });
                  onToggleDir(root.id, displayPath);
                }}
              >
                {isExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
                )}
              </span>
              <WorkspaceFileIcon path={displayPath} folder expanded={isExpanded} />
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
            </ProjectTreeEntryName>
            {treeViewMode === "list" && <ProjectTreeEntryDetails entry={entry} list />}
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
        data-tree-kind="file"
        data-active={active || undefined}
        data-selected={isSelected || undefined}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={isSelected}
        className="h-[var(--taomni-code-tree-row-height)] w-full min-w-0 flex items-center gap-1.5 pr-2 text-left hover:bg-[var(--taomni-code-active-line-bg)] data-[active=true]:bg-[var(--taomni-code-selection-match-bg)] data-[selected=true]:bg-[var(--taomni-code-active-line-bg)]"
        style={rowStyle}
        title={`${root.name} / ${entry.path}${entry.size ? ` - ${formatBytes(entry.size)}` : ""}`}
        onClick={() => {
          onSelect({ kind: "file", ref });
        }}
        onDoubleClick={() => {
          onSelect({ kind: "file", ref });
          onOpenFile(ref, { preview: false });
        }}
        onContextMenu={(event) => onContextMenu(event, { kind: "file", ref })}
      >
        <ProjectTreeEntryName depth={depth} list={treeViewMode === "list"}>
          <span className="w-3.5 shrink-0" />
          <WorkspaceFileIcon path={entry.path} />
          <span className="truncate">{entry.name}</span>
          {(change || open?.dirty) && (
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <GitStatusBadge change={change} />
              {open?.dirty && <span className="text-[var(--taomni-accent)]">*</span>}
            </span>
          )}
        </ProjectTreeEntryName>
        <ProjectTreeEntryDetails entry={entry} list={treeViewMode === "list"} visible={props.showDetails} />
      </button>
    );
  });
}

/**
 * Memoized: the workspace shell re-renders per caret move; with stable
 * handlers (useLatestHandlers) the tree only re-renders when its data changes.
 */
export const ProjectTree = memo(function ProjectTree(inputProps: ProjectTreeProps) {
  const sort = inputProps.sort ?? DEFAULT_EXPLORER_SORT;
  // Selection, caret and dirty-buffer publications do not change directory
  // order. Keep sorting tied to the actual entries and explorer preferences.
  const sortedEntries = useMemo(() => {
    return {
      directories: Object.fromEntries(Object.entries(inputProps.directories).map(([key, value]) =>
        [key, { ...value, entries: sortExplorerEntries(value.entries, sort) }])),
      flatFiles: Object.fromEntries(Object.entries(inputProps.flatFiles).map(([key, value]) =>
        [key, { ...value, entries: sortExplorerEntries(value.entries, sort) }])),
    };
  }, [inputProps.directories, inputProps.flatFiles, sort]);
  const gitDirectoryCounts = useMemo(() => createGitDirectoryChangeCounts(
    inputProps.gitChangeByRootPath, inputProps.roots.map((root) => root.id),
  ), [inputProps.gitChangeByRootPath, inputProps.roots]);
  const props = { ...inputProps, ...sortedEntries, gitDirectoryCounts };
  const {
    roots,
    looseFiles,
    treeViewMode,
    treeFilter,
    expandedRoots,
    selected,
    activeKey,
    openFiles,
    onToggleRoot,
    onSelect,
    onOpenFile,
    onContextMenu,
  } = props;

  if (roots.length === 0 && looseFiles.length === 0) {
    return (
      <div data-testid="code-workspace-tree-empty" className="px-3 py-3 flex flex-col items-start gap-1.5 text-[var(--taomni-code-muted)]">
        <span>Open a file or add a folder</span>
        {props.onAddFolder && (
          <button
            type="button"
            data-testid="code-workspace-tree-add-folder"
            className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[var(--taomni-accent)] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={props.onAddFolder}
          >
            <Folder className="w-3.5 h-3.5 shrink-0" />
            Add Folder to Workspace…
          </button>
        )}
        {props.onOpenLooseFile && (
          <button
            type="button"
            data-testid="code-workspace-tree-open-file"
            className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[var(--taomni-accent)] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={props.onOpenLooseFile}
          >
            <File className="w-3.5 h-3.5 shrink-0" />
            Open File…
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      {roots.map((root) => {
        const expanded = expandedRoots.has(root.id);
        const selectedRoot = selected?.kind === "root" && selected.rootId === root.id;
        const rootChangeCount = gitDirectoryCounts.get(rootDirKey(root.id, "")) ?? 0;
        return (
          <Fragment key={root.id}>
            <button
              type="button"
              data-testid="code-workspace-tree-root"
              data-root-id={root.id}
              data-root-path={root.path}
              data-tree-kind="root"
              data-selected={selectedRoot || undefined}
              role="treeitem"
              aria-level={1}
              aria-expanded={expanded}
              aria-selected={selectedRoot}
              className="h-[var(--taomni-code-tree-row-height)] w-full min-w-0 flex items-center gap-1.5 px-2 text-left font-semibold hover:bg-[var(--taomni-code-active-line-bg)] data-[selected=true]:bg-[var(--taomni-code-active-line-bg)]"
              title={root.path}
              onClick={() => onSelect({ kind: "root", rootId: root.id })}
              onDoubleClick={() => {
                onSelect({ kind: "root", rootId: root.id });
                onToggleRoot(root.id);
              }}
              onContextMenu={(event) => onContextMenu(event, { kind: "root", rootId: root.id })}
            >
              <span
                role="button"
                tabIndex={-1}
                aria-label={expanded ? "Collapse root" : "Expand root"}
                data-testid="code-workspace-tree-root-arrow"
                className="inline-flex items-center justify-center p-0.5 -m-0.5 rounded hover:bg-[var(--taomni-code-active-line-bg)]"
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect({ kind: "root", rootId: root.id });
                  onToggleRoot(root.id);
                }}
              >
                {expanded ? (
                  <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
                )}
              </span>
              <WorkspaceFileIcon path={root.path} folder expanded={expanded} />
              <span className="shrink-0 max-w-[60%] truncate">{root.name}</span>
              {/* IDEA shows the project root's location after its name. */}
              <span data-testid="code-workspace-tree-root-path" className="min-w-0 truncate font-normal text-[var(--taomni-code-muted)]">
                {root.path}
              </span>
              {rootChangeCount > 0 && (
                <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] font-normal text-[var(--taomni-code-muted)]">
                  <span className="rounded border border-[var(--taomni-code-border)] px-1">
                    {rootChangeCount}
                  </span>
                </span>
              )}
            </button>
            {expanded && (
              (treeViewMode === "flat" || treeViewMode === "packages")
                ? renderMatchingFlatFiles(root, props, { groupBySource: true })
                : treeViewMode === "files" || treeFilter.trim()
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
                data-tree-kind="loose-file"
                data-loose-id={file.id}
                data-path={file.path}
                data-active={active || undefined}
                data-selected={selectedLoose || undefined}
                role="treeitem"
                aria-level={1}
                aria-selected={selectedLoose}
                className="h-[var(--taomni-code-tree-row-height)] w-full min-w-0 flex items-center gap-1.5 pl-6 pr-2 text-left hover:bg-[var(--taomni-code-active-line-bg)] data-[active=true]:bg-[var(--taomni-code-selection-match-bg)] data-[selected=true]:bg-[var(--taomni-code-active-line-bg)]"
                title={file.path}
                onClick={() => {
                  onSelect({ kind: "file", ref });
                }}
                onDoubleClick={() => {
                  onSelect({ kind: "file", ref });
                  onOpenFile(ref, { preview: false });
                }}
                onContextMenu={(event) => onContextMenu(event, { kind: "file", ref })}
              >
                <WorkspaceFileIcon path={file.path} />
                <span className="truncate">{file.name}</span>
                {open?.dirty && <span className="ml-auto text-[var(--taomni-accent)]">*</span>}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
});

export type { ProjectTreeProps } from "./projectTreeTypes";
