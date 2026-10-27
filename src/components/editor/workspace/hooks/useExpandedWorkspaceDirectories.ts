import { useEffect } from "react";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { rootDirKey, type CompactChainState, type DirectoryState, type TreeViewMode } from "../codeWorkspaceModel";

interface ExpandedDirectoryOptions {
  roots: readonly CodeWorkspaceRootInfo[];
  expandedRootIds: ReadonlySet<string>;
  expandedDirKeys: ReadonlySet<string>;
  directories: Readonly<Record<string, DirectoryState>>;
  compactChains: Readonly<Record<string, CompactChainState>>;
  treeViewMode: TreeViewMode;
  treeFilter: string;
  loadDir: (rootId: string, path: string) => Promise<void>;
}

/** Reconcile persisted expansion with the ephemeral native/VFS listings. */
export function useExpandedWorkspaceDirectories({
  roots, expandedRootIds, expandedDirKeys, directories, compactChains,
  treeViewMode, treeFilter, loadDir,
}: ExpandedDirectoryOptions): void {
  useEffect(() => {
    if (!expandedDirKeys.size || treeFilter.trim()
      || treeViewMode === "flat" || treeViewMode === "files" || treeViewMode === "packages") return;
    for (const root of roots) {
      if (!expandedRootIds.has(root.id)) continue;
      const pending = [""];
      const visited = new Set<string>();
      while (pending.length) {
        const path = pending.pop()!;
        const key = rootDirKey(root.id, path);
        if (visited.has(key)) continue;
        visited.add(key);
        const listing = directories[key];
        if (!listing?.loaded || listing.error) continue;
        for (const entry of listing.entries) {
          // Explicitly persisted expansions are user intent. Heavy folders
          // stay out of recursive indexes, but their direct listing should be
          // restored just like any other file-explorer directory.
          if (entry.fileType !== "dir") continue;
          const childPath = treeViewMode === "compact"
            ? compactChains[rootDirKey(root.id, entry.path)]?.path ?? entry.path
            : entry.path;
          const childKey = rootDirKey(root.id, childPath);
          if (!expandedDirKeys.has(childKey)) continue;
          const child = directories[childKey];
          // Existing entries, pending reads and explicit error/retry semantics
          // belong to the data owner. Only fill missing visible listings.
          if (!child?.loaded && !child?.loading) void loadDir(root.id, childPath);
          if (child?.loaded && !child.error) pending.push(childPath);
        }
      }
    }
  }, [roots, expandedRootIds, expandedDirKeys, directories, compactChains, treeViewMode, treeFilter, loadDir]);
}
