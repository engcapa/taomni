import { useEffect, useMemo, useRef, useState } from "react";
import { workspaceListDir, type WorkspaceEntry } from "../../../lib/editor/workspace";
import type { CodeWorkspaceRootInfo } from "../../../types";
import { FLAT_VIEW_MAX_DEPTH, matchesTreeFilter, shouldHideEntry, type FlatFilesState } from "./codeWorkspaceModel";
import { fuzzyScore } from "./fuzzyMatch";
import type { GoToFileItem } from "./SearchEverywhere";

export interface WorkspaceSearchEntry extends GoToFileItem { entry: WorkspaceEntry }
interface SearchState {
  identity: string;
  items: WorkspaceSearchEntry[];
  loading: boolean;
  truncated: boolean;
  error: string | null;
}
export const WORKSPACE_SEARCH_MAX_RESULTS = 200;
const MAX_DIRECTORIES = 10_000;
const yieldToInput = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

/** Search metadata on demand, without enlarging the shared capped explorer index. */
export function useWorkspaceFileSearch(roots: CodeWorkspaceRootInfo[], flatFiles: Record<string, FlatFilesState>, query: string, includeDirectories = false, revision = 0) {
  const fallbackRoots = roots.filter((root) => includeDirectories || flatFiles[root.id]?.truncated);
  const identity = JSON.stringify([query.trim(), includeDirectories, revision, fallbackRoots.map((root) => [root.id, root.path, root.name])]);
  const [state, setState] = useState<SearchState | null>(null);
  const searchRoots = useMemo(() => fallbackRoots, [identity]);
  // Old-query reads occupy the same budget until IPC completes. Rapid typing
  // must not create two additional native reads per obsolete query.
  const pending = useRef(new Set<Promise<unknown>>());
  useEffect(() => {
    const needle = query.trim();
    if (!needle || !searchRoots.length) return;
    let cancelled = false;
    const items: WorkspaceSearchEntry[] = [];
    let error: string | null = null;
    let truncated = false;
    let publishedCount = -1;
    let publishedError: string | null = null;
    let lastPublish = 0;
    const queue = searchRoots.map((root) => ({ root, path: "", depth: 0 }));
    const publish = (loading: boolean) => {
      if (cancelled) return;
      if (loading && (performance.now() - lastPublish < 80
        || (publishedCount === items.length && publishedError === error))) return;
      publishedCount = items.length;
      publishedError = error;
      lastPublish = performance.now();
      setState({ identity, items: [...items], loading, truncated, error });
    };
    const read = async (directory: typeof queue[number]) => {
      while (pending.current.size >= 2) {
        await Promise.race(pending.current);
        if (cancelled) return null;
      }
      if (cancelled) return null;
      const request = workspaceListDir(directory.root.path, directory.path);
      pending.current.add(request);
      try { return { directory, result: await request }; }
      finally { pending.current.delete(request); }
    };
    const timer = window.setTimeout(async () => {
      for (let cursor = 0; cursor < queue.length && !cancelled;) {
        const batch = queue.slice(cursor, Math.min(cursor + 2, MAX_DIRECTORIES));
        if (!batch.length) { truncated = true; break; }
        cursor += batch.length;
        const results = await Promise.all(batch.map(read));
        if (cancelled) return;
        for (const response of results) {
          if (!response) continue;
          const { directory, result } = response;
          if (result.state !== "ready") {
            error = result.state === "failed" ? result.message : result.state === "unavailable" ? result.reason : "File search cancelled";
            continue;
          }
          let processed = 0;
          for (const entry of result.entries) {
            const hidden = shouldHideEntry(entry);
            // Heavy folders themselves remain discoverable; their contents do
            // not enter recursive searches (same exclusions as the file index).
            const matches = includeDirectories ? matchesTreeFilter(entry.name, entry.path, needle)
              : !hidden && fuzzyScore(needle, `${directory.root.name}/${entry.path}`) > 0;
            if ((entry.fileType === "file" || (includeDirectories && entry.fileType === "dir")) && matches) {
              items.push({ rootId: directory.root.id, rootName: directory.root.name, path: entry.path, entry });
              if (items.length >= WORKSPACE_SEARCH_MAX_RESULTS) { truncated = true; publish(false); return; }
            }
            if (entry.fileType === "dir" && !hidden) {
              if (directory.depth < FLAT_VIEW_MAX_DEPTH) queue.push({ ...directory, path: entry.path, depth: directory.depth + 1 });
              else truncated = true;
            }
            if (++processed % 256 === 0) {
              publish(true);
              await yieldToInput();
              if (cancelled) return;
            }
          }
        }
        publish(true);
        await yieldToInput();
      }
      publish(false);
    }, 120);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [identity, searchRoots]);
  const active = !!query.trim() && searchRoots.length > 0;
  return active ? state?.identity === identity ? state : {
    identity, items: [], loading: true, truncated: false, error: null,
  } : null;
}
