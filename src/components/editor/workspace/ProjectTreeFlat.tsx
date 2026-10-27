import { Fragment, type ReactNode } from "react";
import { Folder, Loader2 } from "lucide-react";
import type { CodeWorkspaceFileRef, CodeWorkspaceRootInfo } from "../../../types";
import type { WorkspaceEntry } from "../../../lib/editor/workspace";
import { DEFAULT_FLAT_FILES_STATE, FLAT_VIEW_MAX_FILES, fileKey, flatSourceGroup, flatSourceRelativePath, formatBytes, gitChangeForPath, isFlatViewSourceFile, isRootRef, matchesTreeFilter, shouldHideEntry } from "./codeWorkspaceModel";
import type { ProjectTreeProps } from "./projectTreeTypes";
import { GitStatusBadge, ProjectTreeEntryDetails } from "./ProjectTreeEntryDetails";
import { WorkspaceFileIcon } from "./WorkspaceFileIcon";
import { explorerPackage } from "./explorerPreferences";

export function renderMatchingFlatFiles(
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
      const pkg = explorerPackage(entry.path);
      const group = props.treeViewMode === "packages" ? `${pkg.sourceRoot} · ${pkg.name}` : flatSourceGroup(entry.path);
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
              data-testid={props.treeViewMode === "packages" ? "code-workspace-package-group" : "code-workspace-flat-group"}
            >
              <Folder className="w-3.5 h-3.5 text-[var(--taomni-code-muted)]" />
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
            const label = props.treeViewMode === "packages" ? explorerPackage(entry.path).file : options.groupBySource ? flatSourceRelativePath(entry.path) : entry.path;
            return (
              <button
                key={`${root.id}:flat:${entry.path}`}
                type="button"
                data-testid="code-workspace-flat-file"
                data-root-id={root.id}
                data-path={entry.path}
                data-tree-kind="file"
                data-active={active || undefined}
                data-selected={isSelected || undefined}
                role="treeitem"
                aria-level={2}
                aria-selected={isSelected}
                className="h-[var(--taomni-code-tree-row-height)] w-full min-w-0 flex items-center gap-1.5 pl-6 pr-2 text-left hover:bg-[var(--taomni-code-active-line-bg)] data-[active=true]:bg-[var(--taomni-code-selection-match-bg)] data-[selected=true]:bg-[var(--taomni-code-active-line-bg)]"
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
                <WorkspaceFileIcon path={entry.path} />
                <span className="truncate">{label}</span>
                {(change || open?.dirty) && (
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    <GitStatusBadge change={change} />
                    {open?.dirty && <span className="text-[var(--taomni-accent)]">*</span>}
                  </span>
                )}
                <ProjectTreeEntryDetails entry={entry} list={props.treeViewMode === "list"} visible={props.showDetails} />
              </button>
            );
          })}
        </Fragment>
      ))}
    </>
  );
}
