import type { CodeWorkspaceFileRef, CodeWorkspaceLooseFileInfo } from "../../../types";
import type { EditorGroupId } from "../../../stores/codeWorkspaceStore";
import {
  fileRefFromFileKey,
  type PersistedEditorGroup,
  type WorkspaceLayoutSnapshot,
} from "./workspaceLayoutPersistence";

export interface RestoreTarget {
  key: string;
  ref: CodeWorkspaceFileRef;
  groupId: EditorGroupId;
  preview: boolean;
  active: boolean;
}

export interface WorkspaceRestorePlan {
  activeTargets: RestoreTarget[];
  backgroundTargets: RestoreTarget[];
  activeGroupId: EditorGroupId | null;
}

/**
 * Plan workspace restoration with first-screen prioritization (ED-PERF-003 / PERF-4.1).
 * Active tabs of each leaf editor group are identified first for immediate load,
 * followed by remaining background tabs to be loaded with bounded concurrency.
 */
export function planWorkspaceRestore(
  snapshot: WorkspaceLayoutSnapshot,
  looseFiles: readonly CodeWorkspaceLooseFileInfo[],
): WorkspaceRestorePlan {
  const activeTargets: RestoreTarget[] = [];
  const backgroundTargets: RestoreTarget[] = [];

  const groupEntries = Object.entries(snapshot.editorGroups) as Array<[EditorGroupId, PersistedEditorGroup]>;

  for (const [groupId, group] of groupEntries) {
    if (!group) continue;
    const activeKey = group.activeKey;

    for (const key of group.openOrder) {
      const ref = fileRefFromFileKey(key, looseFiles);
      if (!ref) continue;
      const isActive = key === activeKey;
      const target: RestoreTarget = {
        key,
        ref,
        groupId,
        preview: group.previewKey === key,
        active: isActive,
      };

      if (isActive) {
        activeTargets.push(target);
      } else {
        backgroundTargets.push(target);
      }
    }
  }

  return {
    activeTargets,
    backgroundTargets,
    activeGroupId: snapshot.activeEditorGroupId ?? null,
  };
}

/**
 * Execute an async task across an array of items with a fixed concurrency window (2-4).
 */
export async function executeBoundedAsyncQueue<T, R>(
  items: readonly T[],
  worker: (item: T) => Promise<R>,
  concurrency = 3,
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return [];
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function runner(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      const item = items[currentIndex]!;
      try {
        results[currentIndex] = { status: "fulfilled", value: await worker(item) };
      } catch (reason) {
        // A failed background read is isolated to its tab. Keep consuming the
        // queue so one bad file cannot prevent later tabs from restoring.
        results[currentIndex] = { status: "rejected", reason };
      }
    }
  }

  const requestedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : 3;
  const poolSize = Math.min(items.length, Math.max(2, Math.min(4, requestedConcurrency)));
  const pool = Array.from({ length: poolSize }, () => runner());
  await Promise.all(pool);
  return results;
}

/**
 * Generates cache key for git line diff calculation (§8.17.4 / ED-PERF-003).
 */
export function getLineDiffCacheKey(
  filePath: string,
  headOid: string | null,
  textVersion: number,
): string {
  return `${filePath}@${headOid ?? "untracked"}:${textVersion}`;
}

export interface RestoreTimingMarks {
  requestedAt: number | null;
  activeReadyAt: number | null;
  allReadyAt: number | null;
  cancelled: boolean;
  activeCount: number;
  backgroundCount: number;
}

export interface RestoreTimingRecorder {
  readonly marks: RestoreTimingMarks;
  markRequested(at?: number): void;
  markActiveReady(at?: number): void;
  markAllReady(at?: number): void;
  markCancelled(): void;
  toJSON(): RestoreTimingMarks;
}

/**
 * ED-AUDIT-013: monotonic recorder for the three workspace-restore moments
 * the performance contract measures: restore requested, focused active
 * leaf/leaves ready, and background drain complete. First write wins per
 * milestone so StrictMode remounts and repeated drains cannot rewrite
 * history; cancellation is a flag, never a timestamp rewrite. Durations
 * derive from app-clock differences, never from runner step timings.
 */
export function createRestoreTimingRecorder(
  activeCount: number,
  backgroundCount: number,
): RestoreTimingRecorder {
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const marks: RestoreTimingMarks = {
    requestedAt: null,
    activeReadyAt: null,
    allReadyAt: null,
    cancelled: false,
    activeCount,
    backgroundCount,
  };
  return {
    marks,
    markRequested(at: number = now()) {
      if (marks.requestedAt === null) marks.requestedAt = at;
    },
    markActiveReady(at: number = now()) {
      if (marks.activeReadyAt === null) marks.activeReadyAt = at;
    },
    markAllReady(at: number = now()) {
      if (marks.allReadyAt === null) marks.allReadyAt = at;
    },
    markCancelled() {
      marks.cancelled = true;
    },
    toJSON() {
      return { ...marks };
    },
  };
}
