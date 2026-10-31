import { useCallback, useEffect, useRef } from "react";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { parentPath, relativePathWithinRoot, rootDirKey, type DirectoryState, type TreeViewMode } from "../codeWorkspaceModel";

interface Dependencies {
  roots: CodeWorkspaceRootInfo[];
  directories: Record<string, DirectoryState>;
  treeViewMode: TreeViewMode;
  treeFilter: string;
  loadDir: (rootId: string, path: string, options?: { background?: boolean }) => Promise<void>;
  loadFlatFiles: (rootId: string, force?: boolean) => Promise<void>;
  refreshSearch?: () => void;
  invalidateCompactPaths: (rootId: string, path: string) => void;
}

/** Refresh only cached parents affected by a watcher burst. Manual refresh stays separate. */
export function useWorkspaceExternalTreeRefresh(dependencies: Dependencies) {
  const latest = useRef(dependencies);
  latest.current = dependencies;
  const pending = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    pending.current.clear();
  }, []);
  useEffect(() => cancel, [cancel]);

  const refreshPath = useCallback((absolutePath: string) => {
    pending.current.add(absolutePath);
    // A continuous event stream must not postpone visible changes indefinitely.
    if (timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const paths = [...pending.current];
      pending.current.clear();
      const state = latest.current;
      const flat = ["flat", "files", "packages"].includes(state.treeViewMode);
      let searchChanged = false;
      for (const root of state.roots) {
        const changed = paths.flatMap((path) => {
          const relative = relativePathWithinRoot(root.path, path);
          return relative === null ? [] : [relative];
        });
        if (!changed.length) continue;
        searchChanged = true;
        const parents = new Set(changed.map(parentPath));
        for (const path of parents) {
          // A change below an unopened branch cannot change any displayed row.
          // Its first expansion still reads disk through the normal load path.
          if (!state.directories[rootDirKey(root.id, path)]?.loaded) continue;
          void state.loadDir(root.id, path, { background: true });
        }
        for (const path of changed) state.invalidateCompactPaths(root.id, path);
        if (flat) void state.loadFlatFiles(root.id, true);
      }
      if (searchChanged && state.treeFilter.trim()) state.refreshSearch?.();
    }, 200);
  }, []);
  return { refreshPath, cancel };
}
