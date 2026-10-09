import { useEffect, useRef, useState } from "react";
import { workspaceDetectGitRoots } from "../../lib/editor/workspace";
import type { GitWorkspaceRootInfo } from "../../types";
import type { Workspace } from "../../types/workspace";
import { WorkspaceGitManager } from "./WorkspaceGitManager";

/** Repository discovery belongs to the Workspace, independently of Files. */
export function WorkspaceGitSurface({ workspace, activeRepoRoot, visible, onOpenWorkspace }: {
  workspace: Workspace;
  activeRepoRoot?: string | null;
  visible: boolean;
  onOpenWorkspace: (repoRoot: string, path?: string | null) => void;
}) {
  const [roots, setRoots] = useState<GitWorkspaceRootInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (visible) surface.current?.focus();
  }, [visible]);
  const candidates = JSON.stringify(workspace.roots.map(({ id, name, path }) => ({ id, name, path })));
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void workspaceDetectGitRoots(JSON.parse(candidates)).then((detected) => {
      if (!cancelled) setRoots(Array.isArray(detected) ? detected : []);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(String(reason));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [workspace.id, candidates, retry]);

  return <div ref={surface} tabIndex={-1} data-testid="workspace-git-surface" className="h-full min-h-0 flex flex-col outline-none">
    {loading && <p role="status" className="px-3 py-2 text-xs">Detecting Git repositories…</p>}
    {error && <div role="alert" className="px-3 py-2 text-xs">{error}<button className="ml-2 rounded px-2 py-1 hover:bg-[var(--taomni-hover)]" onClick={() => setRetry((value) => value + 1)}>Retry</button></div>}
    {!loading && !error && roots.length === 0 && <p role="status" className="px-3 py-3 text-xs">No Git repository in this workspace</p>}
    {roots.length > 0 && <div inert={loading || !!error} className="flex-1 min-h-0"><WorkspaceGitManager workspaceName={workspace.name} roots={roots} activeRepoRoot={activeRepoRoot} visible={visible && !loading && !error} onOpenWorkspace={onOpenWorkspace} /></div>}
  </div>;
}
