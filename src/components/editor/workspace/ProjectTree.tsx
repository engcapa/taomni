import { memo, useMemo } from "react";
import "./ProjectTree.css";
import { File, Folder } from "./icons";
import { createGitDirectoryChangeCounts } from "./model/trees";
import { DEFAULT_EXPLORER_SORT, sortExplorerEntries } from "./explorerPreferences";
import type { ProjectTreeProps } from "./projectTreeTypes";
import { projectTreeRows } from "./projectTreeRendering";
import { ProjectTreeViewport } from "./ProjectTreeViewport";

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
  const { roots, looseFiles } = props;

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

  return <ProjectTreeViewport rows={projectTreeRows(props)} selected={props.selected} viewMode={props.treeViewMode} />;
});

export type { ProjectTreeProps } from "./projectTreeTypes";
