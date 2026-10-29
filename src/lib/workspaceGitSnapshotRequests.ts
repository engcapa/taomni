import { gitSnapshot } from "./git";

// Share the limit across workspaces and the platform Git bar. Deduplication
// includes queued requests so selecting another tab cannot enqueue duplicates.
let activeRequests = 0;
const pendingRequests: Array<() => void> = [];
const MAX_BACKGROUND_REQUESTS = 2;

function requestSnapshot(repoRoot: string): ReturnType<typeof gitSnapshot> {
  return new Promise((resolve, reject) => {
    const start = () => {
      activeRequests += 1;
      const release = () => {
        activeRequests -= 1;
        pendingRequests.shift()?.();
      };
      try {
        void gitSnapshot(repoRoot).then(resolve, reject).finally(release);
      } catch (error) {
        reject(error);
        release();
      }
    };
    if (activeRequests < MAX_BACKGROUND_REQUESTS) start();
    else pendingRequests.push(start);
  });
}

const gitSnapshotInFlight = new Map<string, Promise<Awaited<ReturnType<typeof gitSnapshot>>>>();
const gitSnapshotCache = new Map<string, {
  snapshot: Awaited<ReturnType<typeof gitSnapshot>>;
  cachedAt: number;
}>();
const GIT_SNAPSHOT_CACHE_TTL_MS = 30_000;
const GIT_SNAPSHOT_CACHE_MAX_ENTRIES = 64;

export function normalizedRepoRoot(repoRoot: string): string {
  return repoRoot.trim();
}

function cacheGitSnapshot(repoRoot: string, snapshot: Awaited<ReturnType<typeof gitSnapshot>>): void {
  gitSnapshotCache.delete(repoRoot);
  gitSnapshotCache.set(repoRoot, { snapshot, cachedAt: Date.now() });
  while (gitSnapshotCache.size > GIT_SNAPSHOT_CACHE_MAX_ENTRIES) {
    const oldest = gitSnapshotCache.keys().next().value;
    if (oldest === undefined) break;
    gitSnapshotCache.delete(oldest);
  }
}

export function fetchGitSnapshotDeduplicated(
  repoRoot: string,
  { forceRefresh = false }: { forceRefresh?: boolean } = {},
): Promise<Awaited<ReturnType<typeof gitSnapshot>>> {
  const normalized = normalizedRepoRoot(repoRoot);
  const existing = gitSnapshotInFlight.get(normalized);
  if (existing) return existing;

  if (!forceRefresh) {
    const cached = gitSnapshotCache.get(normalized);
    if (cached && Date.now() - cached.cachedAt < GIT_SNAPSHOT_CACHE_TTL_MS) {
      gitSnapshotCache.delete(normalized);
      gitSnapshotCache.set(normalized, cached);
      return Promise.resolve(cached.snapshot);
    }
    if (cached) gitSnapshotCache.delete(normalized);
  }

  const promise = requestSnapshot(normalized)
    .then((snapshot) => {
      cacheGitSnapshot(normalized, snapshot);
      return snapshot;
    })
    .finally(() => {
      if (gitSnapshotInFlight.get(normalized) === promise) {
        gitSnapshotInFlight.delete(normalized);
      }
    });

  gitSnapshotInFlight.set(normalized, promise);
  return promise;
}

export function clearGitSnapshotInFlight(): void {
  gitSnapshotInFlight.clear();
}

export function clearGitSnapshotCache(repoRoot?: string): void {
  if (repoRoot === undefined) {
    gitSnapshotCache.clear();
    return;
  }
  gitSnapshotCache.delete(normalizedRepoRoot(repoRoot));
}
