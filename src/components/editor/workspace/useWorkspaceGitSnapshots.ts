import { useCallback, useEffect, useRef, useState } from "react";
import {
  workspaceDetectGitRoots,
  type WorkspaceGitRoot,
} from "../../../lib/editor/workspace";
import { gitSnapshot } from "../../../lib/git";
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
}

export interface WorkspaceGitSnapshotsController {
  gitRoots: WorkspaceGitRoot[];
  gitRootsLoading: boolean;
  gitSnapshots: Record<string, WorkspaceGitSnapshotState>;
  notifyWorkspacePathGitChanged: (rootId: string, path: string) => void;
}

export function useWorkspaceGitSnapshots({
  roots,
  onError,
}: UseWorkspaceGitSnapshotsOptions): WorkspaceGitSnapshotsController {
  const [gitRoots, setGitRoots] = useState<WorkspaceGitRoot[]>([]);
  const [gitRootsLoading, setGitRootsLoading] = useState(false);
  const [gitSnapshots, setGitSnapshots] = useState<Record<string, WorkspaceGitSnapshotState>>({});
  const rootsRef = useRef(roots);
  const gitRootsRef = useRef(gitRoots);

  useEffect(() => {
    rootsRef.current = roots;
  }, [roots]);

  useEffect(() => {
    gitRootsRef.current = gitRoots;
  }, [gitRoots]);

  const refreshSnapshots = useCallback(async (targets = gitRootsRef.current) => {
    await Promise.all(targets.map(async (root) => {
      setGitSnapshots((current) => ({
        ...current,
        [root.repoRoot]: {
          changes: current[root.repoRoot]?.changes ?? [],
          headOid: current[root.repoRoot]?.headOid ?? null,
          currentBranch: current[root.repoRoot]?.currentBranch ?? null,
          ahead: current[root.repoRoot]?.ahead ?? 0,
          behind: current[root.repoRoot]?.behind ?? 0,
          loading: true,
          error: null,
        },
      }));
      try {
        const snapshot = await gitSnapshot(root.repoRoot);
        setGitSnapshots((current) => ({
          ...current,
          [root.repoRoot]: {
            changes: snapshot.changes,
            headOid: snapshot.headOid,
            currentBranch: snapshot.currentBranch,
            ahead: snapshot.ahead,
            behind: snapshot.behind,
            loading: false,
            error: null,
          },
        }));
      } catch (error) {
        setGitSnapshots((current) => ({
          ...current,
          [root.repoRoot]: {
            changes: current[root.repoRoot]?.changes ?? [],
            headOid: current[root.repoRoot]?.headOid ?? null,
            currentBranch: current[root.repoRoot]?.currentBranch ?? null,
            ahead: current[root.repoRoot]?.ahead ?? 0,
            behind: current[root.repoRoot]?.behind ?? 0,
            loading: false,
            error: errorMessage(error),
          },
        }));
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

    setGitRootsLoading(true);
    void workspaceDetectGitRoots(roots.map((root) => ({
      id: root.id,
      name: root.name,
      path: root.path,
    }))).then((detected) => {
      if (cancelled) return;
      gitRootsRef.current = detected;
      setGitRoots(detected);
      setGitSnapshots((current) => Object.fromEntries(
        Object.entries(current).filter(([repoRoot]) => (
          detected.some((root) => root.repoRoot === repoRoot)
        )),
      ));
    }).catch((error) => {
      if (cancelled) return;
      gitRootsRef.current = [];
      setGitRoots([]);
      onError(errorMessage(error));
    }).finally(() => {
      if (!cancelled) setGitRootsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [onError, roots]);

  useEffect(() => {
    if (gitRoots.length === 0) return;
    void refreshSnapshots(gitRoots);
    const timer = window.setInterval(() => {
      void refreshSnapshots(gitRootsRef.current);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [gitRoots, refreshSnapshots]);

  useEffect(() => subscribeGitRepoRefresh((repoRoot) => {
    const root = gitRootsRef.current.find((item) => item.repoRoot === repoRoot);
    if (root) void refreshSnapshots([root]);
  }), [refreshSnapshots]);

  const notifyWorkspacePathGitChanged = useCallback((rootId: string, path: string) => {
    const root = rootsRef.current.find((item) => item.id === rootId);
    if (!root) return;
    const repo = gitRootForWorkspacePath(root, path, gitRootsRef.current);
    if (repo) notifyGitRepoChanged(repo.repoRoot);
  }, []);

  return {
    gitRoots,
    gitRootsLoading,
    gitSnapshots,
    notifyWorkspacePathGitChanged,
  };
}
