import { useEffect, useMemo, useRef, useState } from "react";
import { GitBranch } from "lucide-react";
import type { WorkspaceGitRoot } from "../../lib/editor/workspace";
import { GitPanel } from "../git/GitPanel";

interface WorkspaceGitContainerProps {
  gitRoots: WorkspaceGitRoot[];
  activeRootId: string | null;
  visible: boolean;
}

export function WorkspaceGitContainer({
  gitRoots,
  activeRootId,
  visible,
}: WorkspaceGitContainerProps) {
  const [selectedRepoRoot, setSelectedRepoRoot] = useState("");
  const lastActiveRootIdRef = useRef<string | null>(null);
  const activeRepo = useMemo(
    () => gitRoots.find((root) => activeRootId && root.rootIds.includes(activeRootId)) ?? null,
    [activeRootId, gitRoots],
  );
  const selectedRepo = useMemo(
    () => gitRoots.find((root) => root.repoRoot === selectedRepoRoot) ?? gitRoots[0] ?? null,
    [gitRoots, selectedRepoRoot],
  );

  useEffect(() => {
    if (activeRootId === lastActiveRootIdRef.current) return;
    lastActiveRootIdRef.current = activeRootId;
    if (activeRepo && activeRepo.repoRoot !== selectedRepoRoot) {
      setSelectedRepoRoot(activeRepo.repoRoot);
    }
  }, [activeRepo, activeRootId, selectedRepoRoot]);

  useEffect(() => {
    if (activeRepo) return;
    if ((!selectedRepoRoot || !selectedRepo) && gitRoots[0]) {
      setSelectedRepoRoot(gitRoots[0].repoRoot);
    }
  }, [activeRepo, gitRoots, selectedRepo, selectedRepoRoot]);

  return (
    <div
      data-testid="workspace-git-container"
      className="h-full min-h-0 flex flex-col bg-[var(--taomni-code-bg)] text-[var(--taomni-code-text)]"
    >
      <div className="h-9 shrink-0 flex items-center gap-2 overflow-x-auto border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-3">
        <GitBranch className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-accent)]" />
        <span className="shrink-0 font-semibold text-[12px]">Git</span>
        <select
          data-testid="workspace-git-repo-select"
          className="taomni-input h-7 min-w-40 max-w-72"
          value={selectedRepo?.repoRoot ?? ""}
          onChange={(event) => setSelectedRepoRoot(event.target.value)}
          disabled={gitRoots.length === 0}
        >
          {gitRoots.length > 0 ? gitRoots.map((root) => (
            <option key={root.repoRoot} value={root.repoRoot}>
              {root.name}
            </option>
          )) : (
            <option value="">No Git repositories</option>
          )}
        </select>
        {selectedRepo && (
          <span className="min-w-0 truncate text-[11px] text-[var(--taomni-code-muted)]" title={selectedRepo.repoRoot}>
            {selectedRepo.repoRoot}
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0">
        {selectedRepo ? (
          <GitPanel key={selectedRepo.repoRoot} repoRoot={selectedRepo.repoRoot} visible={visible} embedded />
        ) : (
          <div className="h-full flex items-center justify-center text-[12px] text-[var(--taomni-code-muted)]">
            No Git repositories detected
          </div>
        )}
      </div>
    </div>
  );
}
