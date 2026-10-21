import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gitSnapshot } from "../../../lib/git";
import { subscribeGitRepoRefresh } from "../../../lib/gitRefresh";
import { filterSnapshotRoots, isMissingRepoPathError, retainDeadRepoRoots } from "../../../lib/workspaceGitManagerSync";
import type { GitWorkspaceRootInfo } from "../../../types";
import { dedupeRoots, errorMessage, type RepoScope, type RepoSnapshotState } from "./model";
import { initialRepoScope, loadRepoScope, normalizeRepoScope, rootsForScope, saveRepoScope, workspaceRootsKey } from "./scope";

export interface UseWorkspaceGitRepositoriesContext {
  roots: GitWorkspaceRootInfo[];
  activeRepoRoot: string | null | undefined;
  setPanelVersion: import("react").Dispatch<import("react").SetStateAction<number>>;
  visible: boolean;
}

export function useWorkspaceGitRepositories(context: UseWorkspaceGitRepositoriesContext) {
  const { roots, activeRepoRoot, setPanelVersion, visible } = context;
  const normalizedRoots = useMemo(() => dedupeRoots(roots), [roots]);
  const rootsKey = useMemo(() => workspaceRootsKey(normalizedRoots), [normalizedRoots]);
  const [selectedRepoRoot, setSelectedRepoRoot] = useState(activeRepoRoot ?? normalizedRoots[0]?.repoRoot ?? "");
  const [repoScope, setRepoScope] = useState<RepoScope>(() => (
    loadRepoScope(workspaceRootsKey(normalizedRoots), normalizedRoots)
    ?? initialRepoScope(normalizedRoots, activeRepoRoot)
  ));
  const [snapshots, setSnapshots] = useState<Record<string, RepoSnapshotState>>({});
  /** Bumped only when a current snapshot lands, so diffs re-read after real refreshes. */
  const [snapshotRevisions, setSnapshotRevisions] = useState<Record<string, number>>({});
  /** Repo paths that failed with missing-cwd style errors; skip further snapshots. */
  const [deadRepoRoots, setDeadRepoRoots] = useState<Set<string>>(() => new Set());
  /** Per-repository snapshot request sequence; only the latest response may commit. */
  const refreshSequenceRef = useRef(new Map<string, number>());
  const liveRepoRootsRef = useRef(new Set<string>());

  const selectedRoot = useMemo(
    () => normalizedRoots.find((root) => root.repoRoot === selectedRepoRoot) ?? normalizedRoots[0] ?? null,
    [normalizedRoots, selectedRepoRoot],
  );
  const scopedRoots = useMemo(
    () => rootsForScope(normalizedRoots, repoScope),
    [normalizedRoots, repoScope],
  );
  const repoScopeIsAll = repoScope.mode === "all";
  const repoScopeIsMulti = repoScope.mode !== "single";
  const operationRoots = useMemo(
    () => scopedRoots,
    [scopedRoots],
  );
  const singleRepoMode = normalizedRoots.length === 1;
  const liveRoots = useMemo(
    () => filterSnapshotRoots(normalizedRoots, deadRepoRoots),
    [deadRepoRoots, normalizedRoots],
  );

  useEffect(() => {
    liveRepoRootsRef.current = new Set(normalizedRoots.map((root) => root.repoRoot));
    setDeadRepoRoots((current) => {
      const next = retainDeadRepoRoots(current, normalizedRoots);
      if (next.size === current.size && [...next].every((root) => current.has(root))) return current;
      return next;
    });
    setSnapshots((current) => {
      const live = new Set(normalizedRoots.map((root) => root.repoRoot));
      const entries = Object.entries(current).filter(([repoRoot]) => live.has(repoRoot));
      if (entries.length === Object.keys(current).length) return current;
      return Object.fromEntries(entries);
    });
  }, [normalizedRoots]);

  useEffect(() => {
    setSelectedRepoRoot((current) => {
      const validActiveRoots = scopedRoots.length > 0 ? scopedRoots : normalizedRoots;
      if (validActiveRoots.some((root) => root.repoRoot === current)) return current;
      if (activeRepoRoot && validActiveRoots.some((root) => root.repoRoot === activeRepoRoot)) {
        return activeRepoRoot;
      }
      return validActiveRoots[0]?.repoRoot ?? "";
    });
    setRepoScope((current) => {
      return normalizeRepoScope(current, normalizedRoots, activeRepoRoot);
    });
  }, [activeRepoRoot, normalizedRoots, scopedRoots]);

  useEffect(() => {
    saveRepoScope(rootsKey, repoScope, normalizedRoots);
  }, [normalizedRoots, repoScope, rootsKey]);

  const refreshRepo = useCallback(async (repoRoot: string) => {
    if (deadRepoRoots.has(repoRoot)) {
      const message = `Repository path no longer exists: ${repoRoot}`;
      setSnapshots((current) => ({
        ...current,
        [repoRoot]: {
          snapshot: null,
          loading: false,
          error: message,
        },
      }));
      throw new Error(message);
    }
    const sequence = (refreshSequenceRef.current.get(repoRoot) ?? 0) + 1;
    refreshSequenceRef.current.set(repoRoot, sequence);
    // A superseded or removed-root response still resolves for its caller but
    // never commits: a late A must not overwrite a newer A, nor revive a root.
    const isCurrent = () => (
      refreshSequenceRef.current.get(repoRoot) === sequence
      && liveRepoRootsRef.current.has(repoRoot)
    );
    setSnapshots((current) => ({
      ...current,
      [repoRoot]: {
        snapshot: current[repoRoot]?.snapshot ?? null,
        loading: true,
        error: null,
      },
    }));
    try {
      const snapshot = await gitSnapshot(repoRoot);
      if (isCurrent()) {
        setSnapshots((current) => ({
          ...current,
          [repoRoot]: {
            snapshot,
            loading: false,
            error: null,
          },
        }));
        setSnapshotRevisions((current) => ({ ...current, [repoRoot]: (current[repoRoot] ?? 0) + 1 }));
      }
      return snapshot;
    } catch (err) {
      const message = errorMessage(err);
      if (!isCurrent()) throw err;
      if (isMissingRepoPathError(message)) {
        setDeadRepoRoots((current) => {
          if (current.has(repoRoot)) return current;
          const next = new Set(current);
          next.add(repoRoot);
          return next;
        });
      }
      setSnapshots((current) => ({
        ...current,
        [repoRoot]: {
          snapshot: isMissingRepoPathError(message) ? null : (current[repoRoot]?.snapshot ?? null),
          loading: false,
          error: message,
        },
      }));
      throw err;
    }
  }, [deadRepoRoots]);

  const refreshRepos = useCallback(async (targets = liveRoots) => {
    const snapshotTargets = filterSnapshotRoots(targets, deadRepoRoots);
    await Promise.allSettled(snapshotTargets.map((root) => refreshRepo(root.repoRoot)));
  }, [deadRepoRoots, liveRoots, refreshRepo]);

  useEffect(() => subscribeGitRepoRefresh((repoRoot) => {
    if (deadRepoRoots.has(repoRoot)) return;
    if (normalizedRoots.some((root) => root.repoRoot === repoRoot)) {
      void refreshRepo(repoRoot);
      setPanelVersion((current) => current + 1);
    }
  }), [deadRepoRoots, normalizedRoots, refreshRepo]);

  useEffect(() => {
    if (!visible || liveRoots.length === 0 || singleRepoMode) return;
    void refreshRepos(liveRoots);
  }, [liveRoots, refreshRepos, singleRepoMode, visible]);
  return {
    scopedRoots,
    snapshots,
    snapshotRevisions,
    setSelectedRepoRoot,
    refreshRepo,
    normalizedRoots,
    operationRoots,
    refreshRepos,
    selectedRoot,
    repoScopeIsMulti,
    singleRepoMode,
    repoScope,
    setRepoScope,
    selectedRepoRoot,
    repoScopeIsAll,
  };
}
