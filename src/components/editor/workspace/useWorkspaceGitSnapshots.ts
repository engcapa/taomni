import { useCallback, useEffect, useRef, useState } from "react";
import {
  workspaceDetectGitRoots,
  type WorkspaceGitRoot,
} from "../../../lib/editor/workspace";
import { clearGitSnapshotCache, fetchGitSnapshotDeduplicated, normalizedRepoRoot } from "../../../lib/workspaceGitSnapshotRequests";
import { notifyGitRepoChanged, subscribeGitRepoRefresh } from "../../../lib/gitRefresh";
import type { CodeWorkspaceRootInfo } from "../../../types";
import {
  errorMessage,
  gitRootForWorkspacePath,
  type WorkspaceGitSnapshotState,
} from "./codeWorkspaceModel";

interface UseWorkspaceGitSnapshotsOptions {
  roots: CodeWorkspaceRootInfo[];
  onError: (message: string) => void;
  visible?: boolean;
}

export interface WorkspaceGitSnapshotsController {
  gitRoots: WorkspaceGitRoot[];
  gitRootsLoading: boolean;
  gitSnapshots: Record<string, WorkspaceGitSnapshotState>;
  notifyWorkspacePathGitChanged: (rootId: string, path: string) => void;
}

export { clearGitSnapshotCache, clearGitSnapshotInFlight, fetchGitSnapshotDeduplicated } from "../../../lib/workspaceGitSnapshotRequests";

function clearLoadingSnapshots(
  current: Record<string, WorkspaceGitSnapshotState>,
): Record<string, WorkspaceGitSnapshotState> {
  let changed = false;
  const next = Object.fromEntries(Object.entries(current).map(([repoRoot, state]) => {
    if (!state.loading) return [repoRoot, state];
    changed = true;
    return [repoRoot, { ...state, loading: false }];
  }));
  return changed ? next : current;
}

function sameGitSnapshotState(a: WorkspaceGitSnapshotState | undefined, b: WorkspaceGitSnapshotState): boolean {
  if (!a) return false;
  if (a.loading !== b.loading || a.error !== b.error) return false;
  if (a.headOid !== b.headOid || a.currentBranch !== b.currentBranch) return false;
  if (a.ahead !== b.ahead || a.behind !== b.behind) return false;
  if (a.changes.length !== b.changes.length) return false;
  for (let i = 0; i < a.changes.length; i++) {
    const ca = a.changes[i];
    const cb = b.changes[i];
    if (
      ca.path !== cb.path
      || ca.status !== cb.status
      || ca.staged !== cb.staged
      || ca.unstaged !== cb.unstaged
      || ca.conflict !== cb.conflict
    ) {
      return false;
    }
  }
  return true;
}

export function useWorkspaceGitSnapshots({
  roots,
  onError,
  visible = true,
}: UseWorkspaceGitSnapshotsOptions): WorkspaceGitSnapshotsController {
  const [gitRoots, setGitRoots] = useState<WorkspaceGitRoot[]>([]);
  const [gitRootsLoading, setGitRootsLoading] = useState(false);
  const [gitSnapshots, setGitSnapshots] = useState<Record<string, WorkspaceGitSnapshotState>>({});
  const rootsRef = useRef(roots);
  const gitRootsRef = useRef(gitRoots);
  const visibleRef = useRef(visible);
  const visibilityGenerationRef = useRef(0);
  const refreshSequenceRef = useRef(new Map<string, number>());
  const forceRefreshOnShowRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    rootsRef.current = roots;
  }, [roots]);

  useEffect(() => {
    gitRootsRef.current = gitRoots;
  }, [gitRoots]);

  useEffect(() => {
    visibilityGenerationRef.current += 1;
    if (visible) forceRefreshOnShowRef.current = true;
    if (!visible) setGitSnapshots(clearLoadingSnapshots);
    if (!visible) setGitRootsLoading(false);
  }, [visible]);

  const refreshSnapshots = useCallback(async (
    targets = gitRootsRef.current,
    { forceRefresh = false }: { forceRefresh?: boolean } = {},
  ) => {
    const visibilityGeneration = visibilityGenerationRef.current;
    await Promise.all(targets.map(async (root) => {
      const repoRoot = normalizedRepoRoot(root.repoRoot);
      if (!repoRoot || !visibleRef.current) return;
      const requestSequence = (refreshSequenceRef.current.get(repoRoot) ?? 0) + 1;
      refreshSequenceRef.current.set(repoRoot, requestSequence);
      const isCurrentRequest = () => (
        visibleRef.current
        && visibilityGenerationRef.current === visibilityGeneration
        && refreshSequenceRef.current.get(repoRoot) === requestSequence
      );
      if (!isCurrentRequest()) return;
      setGitSnapshots((current) => {
        const prev = current[repoRoot];
        return {
          ...current,
          [repoRoot]: {
            changes: prev?.changes ?? [],
            headOid: prev?.headOid ?? null,
            currentBranch: prev?.currentBranch ?? null,
            ahead: prev?.ahead ?? 0,
            behind: prev?.behind ?? 0,
            loading: true,
            error: null,
          },
        };
      });
      try {
        const snapshot = await fetchGitSnapshotDeduplicated(repoRoot, { forceRefresh });
        if (!isCurrentRequest()) return;
        const nextState: WorkspaceGitSnapshotState = {
          changes: snapshot.changes,
          headOid: snapshot.headOid,
          currentBranch: snapshot.currentBranch,
          ahead: snapshot.ahead,
          behind: snapshot.behind,
          loading: false,
          error: null,
        };
        setGitSnapshots((current) => {
          if (!isCurrentRequest() || sameGitSnapshotState(current[repoRoot], nextState)) return current;
          return { ...current, [repoRoot]: nextState };
        });
      } catch (error) {
        if (!isCurrentRequest()) return;
        const err = errorMessage(error);
        setGitSnapshots((current) => {
          if (!isCurrentRequest()) return current;
          const prev = current[repoRoot];
          const nextState: WorkspaceGitSnapshotState = {
            changes: prev?.changes ?? [],
            headOid: prev?.headOid ?? null,
            currentBranch: prev?.currentBranch ?? null,
            ahead: prev?.ahead ?? 0,
            behind: prev?.behind ?? 0,
            loading: false,
            error: err,
          };
          if (sameGitSnapshotState(prev, nextState)) return current;
          return { ...current, [repoRoot]: nextState };
        });
      }
    }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (roots.length === 0) {
      gitRootsRef.current = [];
      setGitRoots([]);
      setGitRootsLoading(false);
      setGitSnapshots({});
      return () => {
        cancelled = true;
      };
    }

    if (!visible) {
      setGitRootsLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setGitRootsLoading(true);
    void workspaceDetectGitRoots(roots.map((root) => ({
      id: root.id,
      name: root.name,
      path: root.path,
    }))).then((detected) => {
      if (cancelled || !visibleRef.current) return;
      // A provider that resolves null (or a non-array) must degrade to "no
      // git roots", not crash the workspace tab render (gitRoots[0] and the
      // snapshot filter both assume an array).
      const detectedRoots = Array.isArray(detected) ? detected : [];
      gitRootsRef.current = detectedRoots;
      setGitRoots(detectedRoots);
      setGitSnapshots((current) => Object.fromEntries(
        Object.entries(current).filter(([repoRoot]) => (
          detectedRoots.some((root) => root.repoRoot === repoRoot)
        )),
      ));
    }).catch((error) => {
      if (cancelled || !visibleRef.current) return;
      gitRootsRef.current = [];
      setGitRoots([]);
      onError(errorMessage(error));
    }).finally(() => {
      if (!cancelled && visibleRef.current) setGitRootsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [onError, roots, visible]);

  useEffect(() => {
    if (gitRoots.length === 0) return;
    if (!visible) return;
    const forceRefresh = forceRefreshOnShowRef.current;
    forceRefreshOnShowRef.current = false;
    void refreshSnapshots(gitRoots, { forceRefresh });
    const timer = window.setInterval(() => {
      if (visibleRef.current) {
        void refreshSnapshots(gitRootsRef.current, { forceRefresh: true });
      }
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [gitRoots, refreshSnapshots, visible]);

  useEffect(() => subscribeGitRepoRefresh((repoRoot) => {
    const root = gitRootsRef.current.find((item) => item.repoRoot === repoRoot);
    if (!root) return;
    clearGitSnapshotCache(repoRoot);
    if (visibleRef.current) void refreshSnapshots([root], { forceRefresh: true });
  }), [refreshSnapshots]);

  const notifyWorkspacePathGitChanged = useCallback((rootId: string, path: string) => {
    const root = rootsRef.current.find((item) => item.id === rootId);
    if (!root) return;
    const repo = gitRootForWorkspacePath(root, path, gitRootsRef.current);
    if (repo) {
      clearGitSnapshotCache(repo.repoRoot);
      notifyGitRepoChanged(repo.repoRoot);
    }
  }, []);

  return {
    gitRoots,
    gitRootsLoading,
    gitSnapshots,
    notifyWorkspacePathGitChanged,
  };
}
