import type { MouseEvent } from "react";
import type { CodeWorkspaceFileRef, CodeWorkspaceLooseFileInfo, CodeWorkspaceRootInfo } from "../../../types";
import type { GitChange } from "../../../lib/git";
import type { CompactChainState, DirectoryState, FlatFilesState, TreeSelection, TreeViewMode } from "./codeWorkspaceModel";
import type { ExplorerSort } from "./explorerPreferences";

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
  /** Empty workspace entry points (the header keeps them under New +). */
  onAddFolder?: () => void;
  onOpenLooseFile?: () => void;
  /** IDEA Appearance › Details: modification time and size after file names. */
  showDetails?: boolean;
  sort?: ExplorerSort;
}
