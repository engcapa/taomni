import { useEffect } from "react";
import { gitProbePath, gitSnapshot } from "../../lib/git";
import { subscribeGitRepoRefresh } from "../../lib/gitRefresh";
import { EMPTY_WORKSPACE_GIT_SUMMARY, useWorkspaceGitSummaryStore } from "../../stores/workspaceGitSummaryStore";

/**
 * Reports the first Git repository found under the workspace roots to the
 * shared summary store (branch + changed-file count). The workspace sidebar
 * bar and the rail Git badge both render that one summary, so a collapsed
 * sidebar keeps the badge current (v6.1 review H4/AC-03).
 */
export function useWorkspaceGitSummaryReporter(roots: { path: string }[]): void {
  const setSummary = useWorkspaceGitSummaryStore((s) => s.setSummary);
  const rootsKey = roots.map((root) => root.path).join("\n");

  useEffect(() => {
    const paths = rootsKey ? rootsKey.split("\n") : [];
    let disposed = false;

    const load = async () => {
      if (paths.length === 0) {
        setSummary(EMPTY_WORKSPACE_GIT_SUMMARY);
        return;
      }
      setSummary({ ...EMPTY_WORKSPACE_GIT_SUMMARY, loading: true });
      for (const path of paths) {
        try {
          const probe = await gitProbePath(path);
          if (!probe.isRepo || !probe.repoRoot) continue;
          const snapshot = await gitSnapshot(probe.repoRoot);
          if (disposed) return;
          setSummary({
            repoRoot: probe.repoRoot,
            branch: snapshot.currentBranch ?? "",
            changeCount: snapshot.changes.length,
            loading: false,
          });
          return;
        } catch {
          // Not a repository (or git unavailable): try the next root.
        }
      }
      if (!disposed) setSummary(EMPTY_WORKSPACE_GIT_SUMMARY);
    };

    void load();
    const unsubscribe = subscribeGitRepoRefresh(() => { void load(); });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [rootsKey, setSummary]);
}
