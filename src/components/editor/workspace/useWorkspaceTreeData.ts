import { useCallback, useEffect, useRef, useState } from "react";
import {
  workspaceCompactChain,
  workspaceListDir,
  workspaceListFilesRecursive,
} from "../../../lib/editor/workspace";
import type { CodeWorkspaceRootInfo } from "../../../types";
import {
  DEFAULT_DIR_STATE,
  DEFAULT_FLAT_FILES_STATE,
  FLAT_VIEW_MAX_DEPTH,
  FLAT_VIEW_MAX_FILES,
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
  treeViewMode: TreeViewMode;
  onError: (message: string) => void;
}

export interface WorkspaceTreeDataController {
  directories: Record<string, DirectoryState>;
  compactChains: Record<string, CompactChainState>;
  flatFiles: Record<string, FlatFilesState>;
  loadDir: (rootId: string, path: string) => Promise<void>;
  loadFlatFiles: (rootId: string, force?: boolean) => Promise<void>;
  reset: () => void;
  removeRoot: (rootId: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Owns the ephemeral project-tree listing caches and their async lifecycle.
 * Expansion/selection remain in the keyed workspace store; disk listings can
 * be discarded and rebuilt at any time, so they intentionally stay local.
 */
export function useWorkspaceTreeData({
  roots,
  expandedRootIds,
  treeViewMode,
  onError,
}: UseWorkspaceTreeDataOptions): WorkspaceTreeDataController {
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [compactChains, setCompactChains] = useState<Record<string, CompactChainState>>({});
  const [flatFiles, setFlatFiles] = useState<Record<string, FlatFilesState>>({});
  const rootsRef = useRef(roots);
  const compactChainsRef = useRef(compactChains);
  const flatFilesRef = useRef(flatFiles);
  const generationRef = useRef(0);

  useEffect(() => {
    rootsRef.current = roots;
  }, [roots]);

  useEffect(() => {
    compactChainsRef.current = compactChains;
  }, [compactChains]);

  useEffect(() => {
    flatFilesRef.current = flatFiles;
  }, [flatFiles]);

  const findRoot = useCallback(
    (rootId: string) => rootsRef.current.find((root) => root.id === rootId) ?? null,
    [],
  );

  const loadDir = useCallback(async (rootId: string, path: string) => {
    const root = findRoot(rootId);
    if (!root) return;
    const generation = generationRef.current;
    const key = rootDirKey(rootId, path);
    setDirectories((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? DEFAULT_DIR_STATE),
        loading: true,
        error: null,
      },
    }));
    try {
      const entries = await workspaceListDir(root.path, path);
      if (generation !== generationRef.current) return;
      setDirectories((current) => ({
        ...current,
        [key]: { entries, loaded: true, loading: false, error: null },
      }));
    } catch (error) {
      if (generation !== generationRef.current) return;
      const message = errorMessage(error);
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
    }
  }, [findRoot, onError]);

  const loadCompactChain = useCallback(async (rootId: string, path: string) => {
    const root = findRoot(rootId);
    if (!root) return;
    const key = rootDirKey(rootId, path);
    const cached = compactChainsRef.current[key];
    if (cached?.loading || (cached && !cached.error)) return;
    const generation = generationRef.current;
    setCompactChains((current) => ({
      ...current,
      [key]: { path, entries: current[key]?.entries ?? [], loading: true, error: null },
    }));
    try {
      const chain = await workspaceCompactChain(root.path, path, 16);
      if (generation !== generationRef.current) return;
      setCompactChains((current) => ({
        ...current,
        [key]: { path: chain.path, entries: chain.entries, loading: false, error: null },
      }));
      setDirectories((current) => ({
        ...current,
        [rootDirKey(rootId, chain.path)]: {
          entries: chain.entries,
          loaded: true,
          loading: false,
          error: null,
        },
      }));
    } catch (error) {
      if (generation !== generationRef.current) return;
      setCompactChains((current) => ({
        ...current,
        [key]: { path, entries: [], loading: false, error: errorMessage(error) },
      }));
    }
  }, [findRoot]);

  const loadFlatFiles = useCallback(async (rootId: string, force = false) => {
    const root = findRoot(rootId);
    if (!root) return;
    const cached = flatFilesRef.current[rootId];
    if (!force && (cached?.loading || cached?.loaded)) return;
    const generation = generationRef.current;
    setFlatFiles((current) => ({
      ...current,
      [rootId]: {
        ...(current[rootId] ?? DEFAULT_FLAT_FILES_STATE),
        loading: true,
        error: null,
      },
    }));
    try {
      const entries = await workspaceListFilesRecursive(
        root.path,
        "",
        FLAT_VIEW_MAX_DEPTH,
        FLAT_VIEW_MAX_FILES,
      );
      if (generation !== generationRef.current) return;
      setFlatFiles((current) => ({
        ...current,
        [rootId]: {
          entries,
          loading: false,
          loaded: true,
          error: null,
          truncated: entries.length >= FLAT_VIEW_MAX_FILES,
        },
      }));
    } catch (error) {
      if (generation !== generationRef.current) return;
      const message = errorMessage(error);
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
    }
  }, [findRoot, onError]);

  const reset = useCallback(() => {
    generationRef.current += 1;
    compactChainsRef.current = {};
    flatFilesRef.current = {};
    setDirectories({});
    setCompactChains({});
    setFlatFiles({});
  }, []);

  const removeRoot = useCallback((rootId: string) => {
    setDirectories((current) => Object.fromEntries(
      Object.entries(current).filter(([key]) => !key.startsWith(`${rootId}:`)),
    ));
    setCompactChains((current) => Object.fromEntries(
      Object.entries(current).filter(([key]) => !key.startsWith(`${rootId}:`)),
    ));
    setFlatFiles((current) => {
      const next = { ...current };
      delete next[rootId];
      return next;
    });
  }, []);

  useEffect(() => {
    roots.forEach((root) => {
      if (expandedRootIds.has(root.id)) void loadDir(root.id, "");
    });
  }, [expandedRootIds, loadDir, roots]);

  useEffect(() => {
    if (treeViewMode !== "compact") return;
    for (const [key, state] of Object.entries(directories)) {
      if (!state.loaded || state.error) continue;
      const [rootId] = key.split(":", 1);
      for (const entry of state.entries) {
        if (entry.fileType === "dir" && !shouldHideEntry(entry)) {
          void loadCompactChain(rootId, entry.path);
        }
      }
    }
  }, [directories, loadCompactChain, treeViewMode]);

  useEffect(() => {
    if (treeViewMode !== "flat") return;
    roots.forEach((root) => void loadFlatFiles(root.id));
  }, [loadFlatFiles, roots, treeViewMode]);

  return {
    directories,
    compactChains,
    flatFiles,
    loadDir,
    loadFlatFiles,
    reset,
    removeRoot,
  };
}
