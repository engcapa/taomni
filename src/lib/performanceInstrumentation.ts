/**
 * Optional, passive observation for real IPC performance runs. The observer
 * is absent during normal use and can never change the operation result.
 */
export interface PerformanceIpcEvent {
  phase: "start" | "end";
  command: string;
  args: unknown;
  atMs: number;
  ok?: boolean;
  error?: string;
}

type PerformanceIpcObserver = (event: PerformanceIpcEvent) => void;
type PerformanceGlobal = typeof globalThis & {
  __TAOMNI_PERF_OBSERVER__?: PerformanceIpcObserver;
};

function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export interface PerformanceSampleSummary {
  rawSamplesMs: number[];
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

/** Summarize retained samples without hiding slow observations. */
export function summarizePerformanceSamples(
  samples: readonly number[],
): PerformanceSampleSummary {
  if (samples.length === 0) throw new RangeError("performance samples must not be empty");
  const rawSamplesMs = [...samples];
  const ordered = [...rawSamplesMs].sort((a, b) => a - b);
  const nearestRank = (quantile: number): number => {
    const rank = Math.max(1, Math.ceil(ordered.length * quantile));
    return ordered[rank - 1]!;
  };
  return {
    rawSamplesMs,
    p50Ms: nearestRank(0.5),
    p95Ms: nearestRank(0.95),
    p99Ms: nearestRank(0.99),
    maxMs: ordered[ordered.length - 1]!,
  };
}

function notify(event: PerformanceIpcEvent): void {
  const observer = (globalThis as PerformanceGlobal).__TAOMNI_PERF_OBSERVER__;
  if (typeof observer !== "function") return;
  try {
    observer(event);
  } catch {
    // Measurement must never affect the production IPC path.
  }
}

export function invokeWithPerformanceObservation<T>(
  command: string,
  args: unknown,
  operation: () => Promise<T>,
): Promise<T> {
  notify({ phase: "start", command, args, atMs: nowMs() });
  let pending: Promise<T>;
  try {
    pending = operation();
  } catch (error) {
    notify({ phase: "end", command, args, atMs: nowMs(), ok: false, error: String(error) });
    return Promise.reject(error);
  }
  return pending.then(
    (value) => {
      notify({ phase: "end", command, args, atMs: nowMs(), ok: true });
      return value;
    },
    (error) => {
      notify({ phase: "end", command, args, atMs: nowMs(), ok: false, error: String(error) });
      throw error;
    },
  );
}
