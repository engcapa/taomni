type GitRefreshListener = (repoRoot: string, revision: number) => void;

const GIT_REFRESH_EVENT = "taomni:git-repo-refresh";
const listeners = new Set<GitRefreshListener>();
const revisions = new Map<string, number>();

function normalizeRepoRoot(repoRoot: string): string {
  return repoRoot.trim();
}

export function gitRefreshRevision(repoRoot: string): number {
  const normalized = normalizeRepoRoot(repoRoot);
  return normalized ? revisions.get(normalized) ?? 0 : 0;
}

export function notifyGitRepoChanged(repoRoot: string): number {
  const normalized = normalizeRepoRoot(repoRoot);
  if (!normalized) return 0;
  const revision = (revisions.get(normalized) ?? 0) + 1;
  revisions.set(normalized, revision);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(GIT_REFRESH_EVENT, {
      detail: { repoRoot: normalized, revision },
    }));
  } else {
    listeners.forEach((listener) => listener(normalized, revision));
  }
  return revision;
}

export function subscribeGitRepoRefresh(listener: GitRefreshListener): () => void {
  if (typeof window !== "undefined") {
    const handleRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ repoRoot?: unknown; revision?: unknown }>).detail;
      if (typeof detail?.repoRoot !== "string" || typeof detail.revision !== "number") return;
      listener(detail.repoRoot, detail.revision);
    };
    window.addEventListener(GIT_REFRESH_EVENT, handleRefresh);
    return () => window.removeEventListener(GIT_REFRESH_EVENT, handleRefresh);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
