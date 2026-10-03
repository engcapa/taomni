// In-memory execution log for a SQL query panel: one run per Run click, one
// entry per executable statement. Pure data helpers so DbClientTab and the
// log view share the same status/summary rules.

export type ExecutionLogStatus = "running" | "success" | "failed" | "cancelled" | "skipped" | "not-run";

export interface ExecutionLogEntry {
  id: string;
  ordinal: number;
  sql: string;
  status: ExecutionLogStatus;
  startedAt: number | null;
  durationMs: number | null;
  rowCount: number | null;
  rowsAffected: number | null;
  message: string | null;
  sheetId: string | null;
}

export interface ExecutionLogRun {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  entries: ExecutionLogEntry[];
}

export interface ExecutionLogSummary {
  total: number;
  success: number;
  failed: number;
  cancelled: number;
  skipped: number;
  notRun: number;
  running: number;
  durationMs: number;
}

export const MAX_EXECUTION_LOG_RUNS = 20;

let runCounter = 0;

export function createExecutionRun(statements: string[], startedAt: number): ExecutionLogRun {
  runCounter += 1;
  const runId = `run-${startedAt}-${runCounter}`;
  return {
    id: runId,
    startedAt,
    finishedAt: null,
    entries: statements.map((sql, index) => ({
      id: `${runId}-${index + 1}`,
      ordinal: index + 1,
      sql,
      status: "not-run",
      startedAt: null,
      durationMs: null,
      rowCount: null,
      rowsAffected: null,
      message: null,
      sheetId: null,
    })),
  };
}

export function patchExecutionEntry(
  run: ExecutionLogRun,
  entryId: string,
  patch: Partial<Omit<ExecutionLogEntry, "id" | "ordinal" | "sql">>,
): ExecutionLogRun {
  return {
    ...run,
    entries: run.entries.map((entry) => (entry.id === entryId ? { ...entry, ...patch } : entry)),
  };
}

/** Close a run: any entry still `running` was interrupted and counts as cancelled. */
export function finishExecutionRun(run: ExecutionLogRun, finishedAt: number): ExecutionLogRun {
  return {
    ...run,
    finishedAt,
    entries: run.entries.map((entry) => (entry.status === "running" ? { ...entry, status: "cancelled" } : entry)),
  };
}

export function summarizeExecutionRun(run: ExecutionLogRun): ExecutionLogSummary {
  const summary: ExecutionLogSummary = {
    total: run.entries.length,
    success: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    notRun: 0,
    running: 0,
    durationMs: 0,
  };
  for (const entry of run.entries) {
    if (entry.status === "success") summary.success += 1;
    else if (entry.status === "failed") summary.failed += 1;
    else if (entry.status === "cancelled") summary.cancelled += 1;
    else if (entry.status === "skipped") summary.skipped += 1;
    else if (entry.status === "not-run") summary.notRun += 1;
    else summary.running += 1;
    summary.durationMs += entry.durationMs ?? 0;
  }
  return summary;
}

/** Newest run first; the oldest runs beyond the cap are dropped. */
export function prependExecutionRun(runs: ExecutionLogRun[], run: ExecutionLogRun): ExecutionLogRun[] {
  return [run, ...runs.filter((candidate) => candidate.id !== run.id)].slice(0, MAX_EXECUTION_LOG_RUNS);
}

export function formatExecutionDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs)) return "";
  const ms = Math.max(0, Math.round(durationMs));
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function formatExecutionClock(timestamp: number | null): string {
  if (timestamp === null) return "";
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function replaceExecutionRun(runs: ExecutionLogRun[], run: ExecutionLogRun): ExecutionLogRun[] {
  return runs.map((candidate) => (candidate.id === run.id ? run : candidate));
}
