import { useMemo } from "react";
import type { CodeWorkspaceRootInfo } from "../../../types";
import { matchesTreeFilter, rootDirKey, type DirectoryState, type FlatFilesState } from "./codeWorkspaceModel";
import { useWorkspaceFileSearch } from "./useWorkspaceFileSearch";

/** Keep query results separate from listings owned by expansion and flat views. */
export function useWorkspaceTreeSearch(roots: CodeWorkspaceRootInfo[], directories: Record<string, DirectoryState>, flatFiles: Record<string, FlatFilesState>, query: string, revision: number) {
  const search = useWorkspaceFileSearch(roots, flatFiles, query, true, revision);
  return useMemo(() => {
    if (!search) return flatFiles;
    return Object.fromEntries(roots.map((root) => {
      const entries = new Map((flatFiles[root.id]?.entries ?? [])
        .filter((entry) => matchesTreeFilter(entry.name, entry.path, query)).map((entry) => [entry.path, entry]));
      // Already expanded directories give immediate results, including empty
      // folders. The on-demand walk discovers the rest without expanding rows.
      for (const [key, state] of Object.entries(directories)) {
        if (!key.startsWith(rootDirKey(root.id, ""))) continue;
        for (const entry of state.entries) {
          if (matchesTreeFilter(entry.name, entry.path, query)) entries.set(entry.path, entry);
        }
      }
      for (const item of search.items) if (item.rootId === root.id) entries.set(item.path, item.entry);
      return [root.id, { entries: [...entries.values()], loaded: true, loading: search.loading, truncated: search.truncated, error: search.error }];
    }));
  }, [roots, directories, flatFiles, query, search]);
}
