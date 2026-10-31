import { useCallback, useEffect, useRef, useState } from "react";
import {
  workspaceCompactChain,
  workspaceListDir,
  workspaceListFilesRecursive,
} from "../../../lib/editor/workspace";
import type { CodeWorkspaceRootInfo } from "../../../types";
import { useWorkspaceTreeSearch } from "./useWorkspaceTreeSearch";
import { useExpandedWorkspaceDirectories } from "./hooks/useExpandedWorkspaceDirectories";
import { useWorkspaceExternalTreeRefresh } from "./hooks/useWorkspaceExternalTreeRefresh";
import {
  DEFAULT_DIR_STATE,
  DEFAULT_FLAT_FILES_STATE,
  FLAT_VIEW_MAX_DEPTH,
  FLAT_VIEW_MAX_FILES,
  parentPath,
  rootDirKey,
  shouldHideEntry,
  type CompactChainState,
  type DirectoryState,
  type FlatFilesState,
  type TreeViewMode,
} from "./codeWorkspaceModel";

interface UseWorkspaceTreeDataOptions {
  roots: CodeWorkspaceRootInfo[];
  expandedRootIds: ReadonlySet<string>;
  expandedDirKeys?: ReadonlySet<string>;
  treeViewMode: TreeViewMode;
  /** Non-empty queries search metadata without changing expansion or the flat index. */
  treeFilter?: string;
  onError: (message: string) => void;
}

const NO_EXPANDED_DIRS: ReadonlySet<string> = new Set();
const MAX_COMPACT_REQUESTS = 4;

export interface WorkspaceTreeDataController {
  directories: Record<string, DirectoryState>;
  compactChains: Record<string, CompactChainState>;
  flatFiles: Record<string, FlatFilesState>;
  searchFiles: Record<string, FlatFilesState>;
  loadDir: (rootId: string, path: string) => Promise<void>;
  loadFlatFiles: (rootId: string, force?: boolean) => Promise<void>;
  reset: (options?: { retainListings?: boolean }) => void;
  removeRoot: (rootId: string) => void;
  refreshPath: (absolutePath: string) => void;
}

/**
 * Owns the ephemeral project-tree listing caches and their async lifecycle.
 * Expansion/selection remain in the keyed workspace store; disk listings can
 * be discarded and rebuilt at any time, so they intentionally stay local.
 */
export function useWorkspaceTreeData({
  roots,
  expandedRootIds,
  expandedDirKeys = NO_EXPANDED_DIRS,
  treeViewMode,
  treeFilter = "",
  onError,
}: UseWorkspaceTreeDataOptions): WorkspaceTreeDataController {
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [compactChains, setCompactChains] = useState<Record<string, CompactChainState>>({});
  const [flatFiles, setFlatFiles] = useState<Record<string, FlatFilesState>>({});
  const rootsRef = useRef(roots);
  const compactChainsRef = useRef(compactChains);
  const flatFilesRef = useRef(flatFiles);
  const generationRef = useRef(0);
  // A directory can be requested more than once in one refresh generation
  // (restored expansion, watcher refresh, and a user retry may overlap). Keep
  // only the newest response for each key so a late empty/error result cannot
  // replace a newer, populated listing.
  const directoryRequestsRef = useRef<Record<string, number>>({});
  const compactGenerationsRef = useRef<Record<string, number>>({});
  const compactRequestsRef = useRef<Record<string, symbol>>({});
  const flatGenerationsRef = useRef<Record<string, number>>({});
  const flatRequestsRef = useRef<Record<string, symbol>>({});
  const activeCompactRequestsRef = useRef(new Set<symbol>());
  const mountedRef = useRef(false);
  const [compactWorkVersion, setCompactWorkVersion] = useState(0);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [searchVersion, setSearchVersion] = useState(0);
  const refreshSearch = useCallback(() => setSearchVersion((version) => version + 1), []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    rootsRef.current = roots;
  }, [roots]);

  // Publish the request state synchronously, before another visible row can
  // schedule the same key. React may batch the corresponding state updates.
  const updateCompactChains = useCallback((
    update: (current: Record<string, CompactChainState>) => Record<string, CompactChainState>,
  ) => {
    const next = update(compactChainsRef.current);
    compactChainsRef.current = next;
    setCompactChains(next);
  }, []);

  useEffect(() => {
    flatFilesRef.current = flatFiles;
  }, [flatFiles]);

  const findRoot = useCallback(
    (rootId: string) => rootsRef.current.find((root) => root.id === rootId) ?? null,
    [],
  );

  const loadDir = useCallback(async (rootId: string, path: string, options?: { background?: boolean }) => {
    const root = findRoot(rootId);
    if (!root) return;
    const generation = generationRef.current;
    const key = rootDirKey(rootId, path);
    const request = (directoryRequestsRef.current[key] ?? 0) + 1;
    directoryRequestsRef.current[key] = request;
    if (!options?.background) setDirectories((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? DEFAULT_DIR_STATE),
        loading: true,
        error: null,
      },
    }));
    // W0 boundary: the decoder returns a discriminated union, so a missing
    // command / stub gap / malformed payload can never write `undefined`
    // entries into DirectoryState.
    const result = await workspaceListDir(root.path, path);
    if (generation !== generationRef.current) return;
    if (directoryRequestsRef.current[key] !== request) return;
    if (findRoot(rootId)?.path !== root.path) return;
    if (result.state === "ready") {
      setDirectories((current) => ({
        ...current,
        [key]: { entries: [...result.entries], loaded: true, loading: false, error: null },
      }));
      return;
    }
    if (result.state === "cancelled") return;
    const message = result.state === "unavailable" ? result.reason : result.message;
    setDirectories((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? DEFAULT_DIR_STATE),
        loaded: true,
        loading: false,
        error: message,
      },
    }));
    onError(message);
  }, [findRoot, onError]);

  const loadCompactChain = useCallback(async (rootId: string, path: string) => {
    const root = findRoot(rootId);
    if (!root || !mountedRef.current) return;
    const key = rootDirKey(rootId, path);
    const cached = compactChainsRef.current[key];
    const generation = generationRef.current;
    // One attempt per refresh, including errors. A denied directory must not
    // retry whenever a sibling's listing changes.
    if (compactGenerationsRef.current[key] === generation
      || activeCompactRequestsRef.current.size >= MAX_COMPACT_REQUESTS) return;
    compactGenerationsRef.current[key] = generation;
    const request = Symbol(key);
    compactRequestsRef.current[key] = request;
    activeCompactRequestsRef.current.add(request);
    updateCompactChains((current) => ({
      ...current,
      [key]: { path: cached?.path ?? path, entries: cached?.entries ?? [], loading: true, error: null },
    }));
    try {
      const result = await workspaceCompactChain(root.path, path, 16);
      if (!mountedRef.current || generation !== generationRef.current
        || compactRequestsRef.current[key] !== request
        || findRoot(rootId)?.path !== root.path) return;
      if (result.state === "ready") {
        const entries = [...result.entries];
        // Cache the compact endpoint, but only expanded endpoints may schedule
        // its children. Merely caching this listing must never start a walk.
        const walkedPath = entries.length > 0 ? parentPath(entries[0].path) : path;
        updateCompactChains((current) => ({
          ...current,
          [key]: { path: walkedPath, entries, loading: false, error: null },
        }));
        setDirectories((current) => ({
          ...current,
          [rootDirKey(rootId, walkedPath)]: {
            ...(current[rootDirKey(rootId, walkedPath)] ?? DEFAULT_DIR_STATE),
            entries,
            loaded: true,
            loading: false,
            error: null,
          },
        }));
        return;
      }
      const message = result.state === "cancelled" ? null
        : result.state === "unavailable" ? result.reason : result.message;
      updateCompactChains((current) => ({
        ...current,
        [key]: { path: cached?.path ?? path, entries: cached?.entries ?? [], loading: false, error: message },
      }));
    } finally {
      // Old-generation requests still occupy native workers until they finish.
      // Refreshing must not reset this budget and multiply in-flight work.
      activeCompactRequestsRef.current.delete(request);
      if (mountedRef.current) setCompactWorkVersion((version) => version + 1);
    }
  }, [findRoot, updateCompactChains]);

  const loadFlatFiles = useCallback(async (rootId: string, force = false) => {
    const root = findRoot(rootId);
    if (!root) return;
    const cached = flatFilesRef.current[rootId];
    const generation = generationRef.current;
    if (!force && flatGenerationsRef.current[rootId] === generation
      && (cached?.loading || cached?.loaded)) return;
    flatGenerationsRef.current[rootId] = generation;
    const request = Symbol(rootId);
    flatRequestsRef.current[rootId] = request;
    setFlatFiles((current) => ({
      ...current,
      [rootId]: {
        ...(current[rootId] ?? DEFAULT_FLAT_FILES_STATE),
        loading: true,
        error: null,
      },
    }));
    const result = await workspaceListFilesRecursive(
      root.path,
      "",
      FLAT_VIEW_MAX_DEPTH,
      FLAT_VIEW_MAX_FILES,
    );
    if (generation !== generationRef.current) return;
    if (flatRequestsRef.current[rootId] !== request || findRoot(rootId)?.path !== root.path) return;
    if (result.state === "ready") {
      setFlatFiles((current) => ({
        ...current,
        [rootId]: {
          entries: [...result.entries],
          loading: false,
          loaded: true,
          error: null,
          truncated: result.truncated,
        },
      }));
      return;
    }
    if (result.state === "cancelled") return;
    const message = result.state === "unavailable" ? result.reason : result.message;
    setFlatFiles((current) => ({
      ...current,
      [rootId]: {
        entries: current[rootId]?.entries ?? [],
        loading: false,
        loaded: true,
        error: message,
        truncated: false,
      },
    }));
    onError(message);
  }, [findRoot, onError]);

  const invalidateCompactPaths = useCallback((rootId: string, changedPath: string) => {
    const prefix = `${rootId}:`;
    const keys = Object.keys(compactChainsRef.current).filter((key) => {
      if (!key.startsWith(prefix)) return false;
      const path = key.slice(prefix.length);
      return changedPath === path || changedPath.startsWith(`${path}/`);
    });
    if (!keys.length) return;
    for (const key of keys) {
      delete compactGenerationsRef.current[key];
      delete compactRequestsRef.current[key];
    }
    updateCompactChains((current) => {
      const next = { ...current };
      for (const key of keys) delete next[key];
      return next;
    });
  }, [updateCompactChains]);
  const externalRefresh = useWorkspaceExternalTreeRefresh({
    roots, directories, treeViewMode, treeFilter, loadDir, loadFlatFiles, invalidateCompactPaths, refreshSearch,
  });

  const reset = useCallback((options?: { retainListings?: boolean }) => {
    externalRefresh.cancel();
    generationRef.current += 1;
    directoryRequestsRef.current = {};
    compactGenerationsRef.current = {};
    compactRequestsRef.current = {};
    flatGenerationsRef.current = {};
    flatRequestsRef.current = {};
    flatFilesRef.current = {};
    // A watcher refresh invalidates old requests without unmounting the rows
    // beneath a pending pointer event or the user's keyboard focus. Each new
    // listing replaces its snapshot when ready; a workspace reset still clears.
    const retain = <T extends { loading: boolean }>(current: Record<string, T>) =>
      options?.retainListings
        ? Object.fromEntries(Object.entries(current).map(([key, state]) => [key, { ...state, loading: false }]))
        : {};
    setDirectories(retain);
    updateCompactChains(retain);
    setFlatFiles(retain);
    setReloadVersion((version) => version + 1);
  }, [externalRefresh.cancel, updateCompactChains]);

  const removeRoot = useCallback((rootId: string) => {
    delete flatRequestsRef.current[rootId];
    delete flatGenerationsRef.current[rootId];
    const prefix = `${rootId}:`;
    for (const key of Object.keys(directoryRequestsRef.current)) {
      if (key.startsWith(prefix)) delete directoryRequestsRef.current[key];
    }
    for (const key of Object.keys(compactGenerationsRef.current)) {
      if (key.startsWith(prefix)) delete compactGenerationsRef.current[key];
    }
    for (const key of Object.keys(compactRequestsRef.current)) {
      if (key.startsWith(prefix)) delete compactRequestsRef.current[key];
    }
    setDirectories((current) => Object.fromEntries(
      Object.entries(current).filter(([key]) => !key.startsWith(prefix)),
    ));
    updateCompactChains((current) => Object.fromEntries(
      Object.entries(current).filter(([key]) => !key.startsWith(prefix)),
    ));
    setFlatFiles((current) => {
      const next = { ...current };
      delete next[rootId];
      return next;
    });
  }, [updateCompactChains]);

  useEffect(() => {
    roots.forEach((root) => {
      if (expandedRootIds.has(root.id)) void loadDir(root.id, "");
    });
  }, [expandedRootIds, loadDir, roots]);

  useExpandedWorkspaceDirectories({
    roots, expandedRootIds, expandedDirKeys, directories, compactChains,
    treeViewMode, treeFilter, loadDir,
  });

  useEffect(() => {
    if (treeViewMode !== "compact" || treeFilter.trim()) return;
    // Mirror the rendered tree: each expanded listing needs compact names for
    // its immediate directory rows. Cached descendants below a collapsed row
    // are not visible and must not recursively schedule their own children.
    for (const root of roots) {
      if (!expandedRootIds.has(root.id)) continue;
      const pending = [""];
      const visited = new Set<string>();
      while (pending.length) {
        const path = pending.pop()!;
        if (visited.has(path)) continue;
        visited.add(path);
        const state = directories[rootDirKey(root.id, path)];
        if (!state?.loaded || state.error) continue;
        for (const entry of state.entries) {
          if (entry.fileType !== "dir") continue;
          if (!shouldHideEntry(entry)) void loadCompactChain(root.id, entry.path);
          const childPath = compactChainsRef.current[rootDirKey(root.id, entry.path)]?.path ?? entry.path;
          if (expandedDirKeys.has(rootDirKey(root.id, childPath))) pending.push(childPath);
        }
      }
    }
  }, [roots, expandedRootIds, expandedDirKeys, directories, compactChains, compactWorkVersion, loadCompactChain, treeViewMode, treeFilter]);

  const searchFiles = useWorkspaceTreeSearch(roots, directories, flatFiles, treeFilter, reloadVersion + searchVersion);

  useEffect(() => {
    // Flat views retain their existing capped cache; tree search owns a
    // separate query-dependent walk and must not start a second recursive scan.
    const needsFlatIndex = treeViewMode === "flat" || treeViewMode === "files" || treeViewMode === "packages";
    if (!needsFlatIndex) return;
    roots.forEach((root) => void loadFlatFiles(root.id));
  }, [loadFlatFiles, reloadVersion, roots, treeFilter, treeViewMode]);

  return {
    directories,
    compactChains,
    flatFiles,
    searchFiles,
    loadDir,
    loadFlatFiles,
    reset,
    removeRoot,
    refreshPath: externalRefresh.refreshPath,
  };
}
