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

export type WorkspaceRestorePerformanceOutcome = "ready" | "failed" | "cancelled";

export interface WorkspaceRestorePerformanceEvent {
  kind: "start" | "read-start" | WorkspaceRestorePerformanceOutcome | "all-ready" | "cancelled";
  key?: string;
  groupId?: EditorGroupId;
  active?: boolean;
  atMs: number;
  elapsedMs: number;
  error?: string;
}

export interface WorkspaceRestorePerformanceRun {
  schemaVersion: 1;
  runId: string;
  workspaceInstanceId: string;
  activeGroupId: EditorGroupId | null;
  activeTargetCount: number;
  backgroundTargetCount: number;
  startedAtMs: number;
  activeReadyAtMs: number | null;
  allReadyAtMs: number | null;
  cancelledAtMs: number | null;
  events: WorkspaceRestorePerformanceEvent[];
}

export interface WorkspaceRestorePerformanceController {
  readStarted(target: Pick<RestoreTarget, "key" | "groupId" | "active">): void;
  targetSettled(
    target: Pick<RestoreTarget, "key" | "groupId" | "active">,
    outcome: WorkspaceRestorePerformanceOutcome,
    error?: string,
  ): void;
  allReady(): void;
  cancelled(reason?: string): void;
  snapshot(): WorkspaceRestorePerformanceRun;
}

type RestorePerformanceGlobal = typeof globalThis & {
  __TAOMNI_WORKSPACE_RESTORE_PERFORMANCE__?: {
    runs: WorkspaceRestorePerformanceRun[];
  };
};

let restorePerformanceSequence = 0;

function restorePerformanceNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function restorePerformanceGlobal(): { runs: WorkspaceRestorePerformanceRun[] } {
  const target = globalThis as RestorePerformanceGlobal;
  if (!target.__TAOMNI_WORKSPACE_RESTORE_PERFORMANCE__) {
    target.__TAOMNI_WORKSPACE_RESTORE_PERFORMANCE__ = { runs: [] };
  }
  return target.__TAOMNI_WORKSPACE_RESTORE_PERFORMANCE__;
}

function copyRestorePerformanceRun(run: WorkspaceRestorePerformanceRun): WorkspaceRestorePerformanceRun {
  return {
    ...run,
    events: run.events.map((event) => ({ ...event })),
  };
}

/**
 * Passive restore timing observation. It records the real production read
 * lifecycle in memory for QA collection; it never schedules, cancels, or
 * changes a restore operation.
 */
export function beginWorkspaceRestorePerformance(
  workspaceInstanceId: string,
  activeTargets: readonly RestoreTarget[],
  backgroundTargets: readonly RestoreTarget[],
  activeGroupId: EditorGroupId | null,
): WorkspaceRestorePerformanceController {
  const startedAtMs = restorePerformanceNow();
  const run: WorkspaceRestorePerformanceRun = {
    schemaVersion: 1,
    runId: `${workspaceInstanceId}:restore:${restorePerformanceSequence += 1}`,
    workspaceInstanceId,
    activeGroupId,
    activeTargetCount: activeTargets.length,
    backgroundTargetCount: backgroundTargets.length,
    startedAtMs,
    activeReadyAtMs: null,
    allReadyAtMs: null,
    cancelledAtMs: null,
    events: [],
  };
  const global = restorePerformanceGlobal();
  global.runs.push(run);
  if (global.runs.length > 8) global.runs.splice(0, global.runs.length - 8);

  const addEvent = (
    kind: WorkspaceRestorePerformanceEvent["kind"],
    target?: Pick<RestoreTarget, "key" | "groupId" | "active">,
    error?: string,
  ) => {
    const atMs = restorePerformanceNow();
    run.events.push({
      kind,
      ...(target ? { key: target.key, groupId: target.groupId, active: target.active } : {}),
      atMs,
      elapsedMs: Math.max(0, atMs - startedAtMs),
      ...(error ? { error } : {}),
    });
  };
  addEvent("start");

  return {
    readStarted: (target) => addEvent("read-start", target),
    targetSettled: (target, outcome, error) => {
      addEvent(outcome, target, error);
      if (
        outcome === "ready"
        && target.active
        && target.groupId === activeGroupId
        && run.activeReadyAtMs === null
      ) {
        run.activeReadyAtMs = run.events[run.events.length - 1]!.atMs;
      }
    },
    allReady: () => {
      if (run.allReadyAtMs !== null || run.cancelledAtMs !== null) return;
      addEvent("all-ready");
      run.allReadyAtMs = run.events[run.events.length - 1]!.atMs;
    },
    cancelled: (reason) => {
      if (run.cancelledAtMs !== null || run.allReadyAtMs !== null) return;
      addEvent("cancelled", undefined, reason);
      run.cancelledAtMs = run.events[run.events.length - 1]!.atMs;
    },
    snapshot: () => copyRestorePerformanceRun(run),
  };
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
